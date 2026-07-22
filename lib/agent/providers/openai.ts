import OpenAI from 'openai';

import { toAnthropicTools } from '@/lib/agent/tools/to-anthropic';

import type { AgentTool } from '@/lib/agent/tools/types';
import type {
  AgentContentBlock,
  AgentMessage,
  AgentProvider,
  ProviderStreamEvent,
  ProviderStreamOptions,
} from './types';

/**
 * BYOK OpenAI (ChatGPT) provider.
 *
 * Translates the runtime's provider-neutral conversation into the Chat
 * Completions wire format, streams the response, and maps the stream back to
 * neutral ProviderStreamEvents. OpenAI caches prompts automatically (no
 * explicit breakpoints), so unlike the Anthropic provider there is no
 * cache-control markup here.
 */

/**
 * Tool conversion reuses the Anthropic JSON-Schema converter (zod → JSON Schema
 * + design-schema compaction); only the envelope differs. Cached per tools
 * reference — the registry returns a stable array.
 */
const convertedToolsCache = new WeakMap<readonly AgentTool[], OpenAI.Chat.Completions.ChatCompletionTool[]>();

function getOpenAiTools(tools: readonly AgentTool[]): OpenAI.Chat.Completions.ChatCompletionTool[] {
  const cached = convertedToolsCache.get(tools);
  if (cached) return cached;

  const converted: OpenAI.Chat.Completions.ChatCompletionTool[] = toAnthropicTools(tools as AgentTool[]).map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  }));
  convertedToolsCache.set(tools, converted);
  return converted;
}

export function createOpenAiProvider(apiKey: string): AgentProvider {
  const client = new OpenAI({ apiKey, maxRetries: 2 });

  return {
    id: 'openai-byok',

    async *streamMessage(options: ProviderStreamOptions): AsyncIterable<ProviderStreamEvent> {
      const stream = await client.chat.completions.create(
        {
          model: options.model,
          max_completion_tokens: options.maxTokens,
          // Design/building work doesn't benefit from deep reasoning the way
          // code does (Framer measured no eval difference), so default OpenAI
          // reasoning models to low effort — faster and cheaper per turn.
          ...(isReasoningModel(options.model) ? { reasoning_effort: 'low' as const } : {}),
          messages: [
            { role: 'system', content: options.system },
            ...toOpenAiMessages(options.messages),
          ],
          tools: getOpenAiTools(options.tools),
          stream: true,
          stream_options: { include_usage: true },
        },
        { signal: options.signal },
      );

      // Tool-call arguments stream as partial JSON keyed by index; assemble
      // them and emit one complete tool_use per call at the end of the stream.
      const toolCalls = new Map<number, { id: string; name: string; json: string }>();
      let stopReason: string | null = null;
      let usage: OpenAI.CompletionUsage | undefined;

      for await (const chunk of stream) {
        // The final usage chunk has an empty choices array.
        usage = chunk.usage ?? usage;
        const choice = chunk.choices[0];
        if (!choice) continue;

        if (choice.delta?.content) {
          yield { type: 'text_delta', text: choice.delta.content };
        }

        for (const delta of choice.delta?.tool_calls ?? []) {
          const existing = toolCalls.get(delta.index);
          if (existing) {
            existing.json += delta.function?.arguments ?? '';
          } else {
            toolCalls.set(delta.index, {
              id: delta.id ?? `call_${delta.index}_${Date.now()}`,
              name: delta.function?.name ?? '',
              json: delta.function?.arguments ?? '',
            });
          }
        }

        if (choice.finish_reason) {
          stopReason = choice.finish_reason;
        }
      }

      for (const call of [...toolCalls.entries()].sort(([a], [b]) => a - b).map(([, c]) => c)) {
        yield { type: 'tool_use', id: call.id, name: call.name, input: parseToolInput(call.json) };
      }

      // OpenAI caches automatically and bills cached input at a discount;
      // there is no separately billed cache write.
      const cachedTokens = usage?.prompt_tokens_details?.cached_tokens ?? 0;
      yield {
        type: 'message_stop',
        stopReason,
        usage: {
          inputTokens: Math.max(0, (usage?.prompt_tokens ?? 0) - cachedTokens),
          outputTokens: usage?.completion_tokens ?? 0,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: cachedTokens,
        },
      };
    },
  };
}

/**
 * Convert neutral messages to Chat Completions messages.
 *
 * The shapes don't map 1:1: an assistant turn's tool_use blocks become the
 * `tool_calls` field of one assistant message, and each tool_result block in
 * the following user turn becomes its own `role: "tool"` message.
 */
function toOpenAiMessages(messages: AgentMessage[]): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const out: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];

  for (const message of messages) {
    if (message.role === 'assistant') {
      const text = message.content
        .filter((block): block is Extract<AgentContentBlock, { type: 'text' }> => block.type === 'text')
        .map((block) => block.text)
        .join('');
      const toolCalls = message.content
        .filter((block): block is Extract<AgentContentBlock, { type: 'tool_use' }> => block.type === 'tool_use')
        .map((block) => ({
          id: block.id,
          type: 'function' as const,
          function: { name: block.name, arguments: JSON.stringify(block.input) },
        }));

      out.push({
        role: 'assistant',
        content: text || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }

    // User turn: tool results become role:"tool" messages; the rest (text and
    // images) folds into one user message with content parts.
    const parts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
    for (const block of message.content) {
      if (block.type === 'tool_result') {
        out.push({
          role: 'tool',
          tool_call_id: block.toolUseId,
          content: block.isError ? `Error: ${block.content}` : block.content,
        });
      } else if (block.type === 'text') {
        parts.push({ type: 'text', text: block.text });
      } else if (block.type === 'image') {
        parts.push({
          type: 'image_url',
          image_url: { url: `data:${block.mediaType};base64,${block.data}` },
        });
      }
    }
    if (parts.length > 0) {
      out.push({ role: 'user', content: parts });
    }
  }

  return out;
}

/** Models that accept the `reasoning_effort` parameter (GPT-5 family and o-series). */
function isReasoningModel(model: string): boolean {
  return /^(gpt-5|o\d)/.test(model);
}

/** Tool input arrives as streamed partial JSON; empty means a no-arg tool. */
function parseToolInput(json: string): Record<string, unknown> {
  if (!json.trim()) return {};
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

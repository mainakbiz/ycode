import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';

import type { Content, Part } from '@google/genai';
import type { AgentTool } from '@/lib/agent/tools/types';
import type {
  AgentMessage,
  AgentProvider,
  ProviderStreamEvent,
  ProviderStreamOptions,
} from './types';

/**
 * BYOK Google Gemini provider.
 *
 * Translates the runtime's provider-neutral conversation into Gemini contents
 * (user/model roles, functionCall/functionResponse parts), streams the
 * response, and maps it back to neutral ProviderStreamEvents. Gemini caches
 * prompts implicitly (no explicit breakpoints), so unlike the Anthropic
 * provider there is no cache-control markup here.
 */

/** Function declarations converted from the shared zod schemas, cached per
 * tools reference — the registry returns a stable array. */
const convertedToolsCache = new WeakMap<readonly AgentTool[], Array<{ name: string; description: string; parametersJsonSchema: unknown }>>();

function getGeminiFunctionDeclarations(tools: readonly AgentTool[]) {
  const cached = convertedToolsCache.get(tools);
  if (cached) return cached;

  const converted = tools.map((tool) => {
    const schema = z.toJSONSchema(z.object(tool.inputSchema)) as Record<string, unknown>;
    delete schema.$schema;
    return {
      name: tool.name,
      description: tool.description,
      // Standard JSON Schema (not the legacy OpenAPI Schema field), so the
      // zod-converted schemas (anyOf unions etc.) pass through losslessly.
      parametersJsonSchema: schema,
    };
  });
  convertedToolsCache.set(tools, converted);
  return converted;
}

export function createGoogleProvider(apiKey: string): AgentProvider {
  const client = new GoogleGenAI({ apiKey });

  return {
    id: 'google-byok',

    async *streamMessage(options: ProviderStreamOptions): AsyncIterable<ProviderStreamEvent> {
      const stream = await client.models.generateContentStream({
        model: options.model,
        contents: toGeminiContents(options.messages),
        config: {
          systemInstruction: options.system,
          maxOutputTokens: options.maxTokens,
          tools: [{ functionDeclarations: getGeminiFunctionDeclarations(options.tools) }],
          abortSignal: options.signal,
        },
      });

      let stopReason: string | null = null;
      let toolCallCounter = 0;
      let usage: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        thoughtsTokenCount?: number;
        cachedContentTokenCount?: number;
      } | undefined;

      for await (const chunk of stream) {
        usage = chunk.usageMetadata ?? usage;
        const candidate = chunk.candidates?.[0];
        if (!candidate) continue;

        for (const part of candidate.content?.parts ?? []) {
          if (part.text && !part.thought) {
            yield { type: 'text_delta', text: part.text };
          }
          if (part.functionCall?.name) {
            // Gemini function calls arrive complete (not as partial JSON) and
            // may omit ids; synthesize one so the runtime's tool_use/tool_result
            // pairing works. The id is not echoed back to Gemini — responses
            // are matched by name and order (see toGeminiContents).
            toolCallCounter += 1;
            yield {
              type: 'tool_use',
              id: part.functionCall.id ?? `gemini_call_${Date.now()}_${toolCallCounter}`,
              name: part.functionCall.name,
              input: (part.functionCall.args ?? {}) as Record<string, unknown>,
            };
          }
        }

        if (candidate.finishReason) {
          stopReason = candidate.finishReason;
        }
      }

      // Gemini caches implicitly and bills cached input at a discount; thinking
      // tokens are billed as output.
      const cachedTokens = usage?.cachedContentTokenCount ?? 0;
      yield {
        type: 'message_stop',
        stopReason,
        usage: {
          inputTokens: Math.max(0, (usage?.promptTokenCount ?? 0) - cachedTokens),
          outputTokens: (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0),
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: cachedTokens,
        },
      };
    },
  };
}

/**
 * Convert neutral messages to Gemini contents.
 *
 * Assistant turns become role "model" with functionCall parts; the tool_result
 * blocks in the following user turn become functionResponse parts. Gemini
 * matches responses to calls by name and order rather than by our synthetic
 * ids, so the id→name mapping is rebuilt from the preceding tool_use blocks.
 */
function toGeminiContents(messages: AgentMessage[]): Content[] {
  const contents: Content[] = [];
  const toolNameById = new Map<string, string>();

  for (const message of messages) {
    const parts: Part[] = [];

    for (const block of message.content) {
      if (block.type === 'text') {
        parts.push({ text: block.text });
      } else if (block.type === 'image') {
        parts.push({ inlineData: { mimeType: block.mediaType, data: block.data } });
      } else if (block.type === 'tool_use') {
        toolNameById.set(block.id, block.name);
        parts.push({ functionCall: { name: block.name, args: block.input } });
      } else if (block.type === 'tool_result') {
        parts.push({
          functionResponse: {
            name: toolNameById.get(block.toolUseId) ?? 'unknown_tool',
            response: block.isError ? { error: block.content } : { output: block.content },
          },
        });
      }
    }

    if (parts.length > 0) {
      contents.push({ role: message.role === 'assistant' ? 'model' : 'user', parts });
    }
  }

  return contents;
}

import Anthropic from '@anthropic-ai/sdk';

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
 * Converting ~80 Zod tool schemas to Anthropic JSON Schema is non-trivial CPU
 * work, and the tool set is static (the registry returns a stable array
 * reference). Cache the converted-and-cache-marked result per tools reference so
 * it's computed once per process instead of on every tool-loop turn / prompt.
 */
const convertedToolsCache = new WeakMap<readonly AgentTool[], Anthropic.Tool[]>();

function getAnthropicTools(tools: readonly AgentTool[]): Anthropic.Tool[] {
  const cached = convertedToolsCache.get(tools);
  if (cached) return cached;

  const converted = withToolCaching(toAnthropicTools(tools as AgentTool[]));
  convertedToolsCache.set(tools, converted);
  return converted;
}

/**
 * BYOK Anthropic provider.
 *
 * Translates the runtime's provider-neutral conversation into Anthropic's wire
 * format, streams the response, and maps Anthropic stream events back to neutral
 * ProviderStreamEvents. The large system prompt and tool definitions are marked
 * for prompt caching to cut cost and latency on multi-turn tool loops.
 */
/** Max attempts when the API returns a transient error before any output. */
const MAX_STREAM_ATTEMPTS = 5;
/** Base backoff in ms; grows exponentially with jitter. */
const RETRY_BASE_DELAY_MS = 800;

export function createAnthropicProvider(apiKey: string): AgentProvider {
  // The SDK retries the initial request on its own; our generator adds a
  // guarded retry on top for overloaded/transient errors (see streamMessage).
  const client = new Anthropic({ apiKey, maxRetries: 2 });

  return {
    id: 'anthropic-byok',

    async *streamMessage(options: ProviderStreamOptions): AsyncIterable<ProviderStreamEvent> {
      const tools = getAnthropicTools(options.tools);
      const messages = withConversationCaching(toAnthropicMessages(options.messages));

      for (let attempt = 1; ; attempt += 1) {
        // Only safe to retry while we haven't emitted anything for this turn —
        // once partial output is yielded, a retry would duplicate the stream.
        let emitted = false;

        try {
          const stream = client.messages.stream(
            {
              model: options.model,
              max_tokens: options.maxTokens,
              system: [
                { type: 'text', text: options.system, cache_control: { type: 'ephemeral' } },
              ],
              tools,
              messages,
            },
            { signal: options.signal },
          );

          // Track in-flight tool_use blocks by content index to assemble their
          // streamed input JSON before emitting a complete tool_use event.
          const toolBlocks = new Map<number, { id: string; name: string; json: string }>();
          let stopReason: string | null = null;
          let inputTokens = 0;
          let outputTokens = 0;
          let cacheCreationInputTokens = 0;
          let cacheReadInputTokens = 0;

          for await (const event of stream) {
            switch (event.type) {
              case 'message_start':
                inputTokens = event.message.usage?.input_tokens ?? 0;
                cacheCreationInputTokens = event.message.usage?.cache_creation_input_tokens ?? 0;
                cacheReadInputTokens = event.message.usage?.cache_read_input_tokens ?? 0;
                break;

              case 'content_block_start':
                if (event.content_block.type === 'tool_use') {
                  toolBlocks.set(event.index, {
                    id: event.content_block.id,
                    name: event.content_block.name,
                    json: '',
                  });
                }
                break;

              case 'content_block_delta':
                if (event.delta.type === 'text_delta') {
                  emitted = true;
                  yield { type: 'text_delta', text: event.delta.text };
                } else if (event.delta.type === 'input_json_delta') {
                  const block = toolBlocks.get(event.index);
                  if (block) block.json += event.delta.partial_json;
                }
                break;

              case 'content_block_stop': {
                const block = toolBlocks.get(event.index);
                if (block) {
                  toolBlocks.delete(event.index);
                  emitted = true;
                  yield {
                    type: 'tool_use',
                    id: block.id,
                    name: block.name,
                    input: parseToolInput(block.json),
                  };
                }
                break;
              }

              case 'message_delta':
                stopReason = event.delta.stop_reason ?? stopReason;
                outputTokens = event.usage?.output_tokens ?? outputTokens;
                break;

              case 'message_stop':
                emitted = true;
                yield {
                  type: 'message_stop',
                  stopReason,
                  usage: {
                    inputTokens,
                    outputTokens,
                    cacheCreationInputTokens,
                    cacheReadInputTokens,
                  },
                };
                break;

              default:
                break;
            }
          }

          return;
        } catch (error) {
          const canRetry =
            !emitted &&
            attempt < MAX_STREAM_ATTEMPTS &&
            !options.signal?.aborted &&
            isRetryableError(error);

          if (!canRetry) throw error;

          await delay(backoffDelay(attempt), options.signal);
        }
      }
    },
  };
}

/** Transient errors worth retrying: overloaded, rate limit, 5xx, connection. */
function isRetryableError(error: unknown): boolean {
  if (error instanceof Anthropic.APIConnectionError) return true;

  const status = (error as { status?: number })?.status;
  if (status === 408 || status === 409 || status === 429 || (status !== undefined && status >= 500)) {
    return true;
  }

  const type =
    (error as { error?: { type?: string } })?.error?.type ??
    (error as { type?: string })?.type;
  if (type === 'overloaded_error' || type === 'rate_limit_error' || type === 'api_error') {
    return true;
  }

  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return message.includes('overloaded') || message.includes('rate limit');
}

/** Exponential backoff with full jitter. */
function backoffDelay(attempt: number): number {
  const ceiling = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
  return Math.round(Math.random() * ceiling);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('Aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Add a rolling cache breakpoint on the final block of the conversation.
 *
 * System and tools already carry breakpoints (2 of Anthropic's 4 allowed). This
 * marks the end of the transcript so that on each tool-loop turn the growing
 * prefix — prior tool calls and their potentially large results (e.g. a full
 * `get_layers` tree) — is read from cache (~10%) instead of re-billed in full.
 * Short prefixes that don't meet the cache minimum are simply not cached, which
 * is harmless.
 */
function withConversationCaching(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  if (messages.length === 0) return messages;
  const lastIndex = messages.length - 1;
  const last = messages[lastIndex];
  if (!Array.isArray(last.content) || last.content.length === 0) return messages;

  const blocks = [...last.content];
  const tail = blocks.length - 1;
  blocks[tail] = { ...blocks[tail], cache_control: { type: 'ephemeral' } } as Anthropic.ContentBlockParam;

  const next = [...messages];
  next[lastIndex] = { ...last, content: blocks };
  return next;
}

/** Mark the final tool as a cache breakpoint so all tool definitions are cached. */
function withToolCaching(tools: ReturnType<typeof toAnthropicTools>): Anthropic.Tool[] {
  const anthropicTools = tools as unknown as Anthropic.Tool[];
  if (anthropicTools.length > 0) {
    anthropicTools[anthropicTools.length - 1] = {
      ...anthropicTools[anthropicTools.length - 1],
      cache_control: { type: 'ephemeral' },
    };
  }
  return anthropicTools;
}

function toAnthropicMessages(messages: AgentMessage[]): Anthropic.MessageParam[] {
  return messages.map((message) => ({
    role: message.role,
    content: message.content.map(toAnthropicBlock),
  }));
}

function toAnthropicBlock(block: AgentContentBlock): Anthropic.ContentBlockParam {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };
    case 'image':
      return {
        type: 'image',
        source: {
          type: 'base64',
          media_type: block.mediaType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
          data: block.data,
        },
      };
    case 'tool_use':
      return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: block.toolUseId,
        content: block.content,
        is_error: block.isError,
      };
  }
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

import type { AgentTool } from '@/lib/agent/tools/types';

/**
 * Provider-neutral conversation types.
 *
 * The runtime speaks these shapes; each provider (Anthropic now, GPT later)
 * translates them to/from its own wire format internally. This keeps the
 * tool-calling loop independent of any single LLM vendor.
 */

export type AgentRole = 'user' | 'assistant';

export interface AgentTextBlock {
  type: 'text';
  text: string;
}

export interface AgentImageBlock {
  type: 'image';
  /** MIME type, e.g. "image/png", "image/jpeg", "image/webp", "image/gif". */
  mediaType: string;
  /** Base64-encoded image bytes (no data: URL prefix). */
  data: string;
}

export interface AgentToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AgentToolResultBlock {
  type: 'tool_result';
  toolUseId: string;
  content: string;
  isError?: boolean;
}

export type AgentContentBlock =
  | AgentTextBlock
  | AgentImageBlock
  | AgentToolUseBlock
  | AgentToolResultBlock;

export interface AgentMessage {
  role: AgentRole;
  content: AgentContentBlock[];
}

export interface AgentUsage {
  /** Uncached input tokens billed at full price. */
  inputTokens: number;
  outputTokens: number;
  /** Tokens written to the prompt cache (≈ full price + 25%). */
  cacheCreationInputTokens?: number;
  /** Tokens served from the prompt cache (≈ 10% of full price). */
  cacheReadInputTokens?: number;
}

/**
 * Granular events a provider emits while streaming one assistant turn. The
 * runtime accumulates these into a full assistant message and drives the loop.
 */
export type ProviderStreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'message_stop'; stopReason: string | null; usage?: AgentUsage };

export interface ProviderStreamOptions {
  system: string;
  messages: AgentMessage[];
  tools: AgentTool[];
  model: string;
  maxTokens: number;
  signal?: AbortSignal;
}

/**
 * An LLM backend. The BYOK Anthropic provider ships in this repo; the Ycode
 * Cloud overlay registers a hosted provider implementing the same interface.
 */
export interface AgentProvider {
  readonly id: string;
  streamMessage(options: ProviderStreamOptions): AsyncIterable<ProviderStreamEvent>;
}

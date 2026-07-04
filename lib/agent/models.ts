/**
 * Models the in-app AI builder can use.
 *
 * This module has no server-only imports so it can be shared between the client
 * (model picker UI) and the server (request validation). The actual default is
 * still resolved server-side from settings/env in `lib/agent/config.ts`.
 */

export interface AgentModelOption {
  id: string;
  label: string;
}

export const AGENT_MODELS: AgentModelOption[] = [
  { id: 'claude-sonnet-5', label: 'Sonnet 5' },
  { id: 'claude-opus-4-8', label: 'Opus 4.8' },
];

/**
 * Model selected by default in the picker. Opus is the strongest builder model,
 * matching the default users expect from comparable AI site builders. Users can
 * switch to a cheaper model from the dropdown.
 */
export const DEFAULT_AGENT_MODEL = 'claude-opus-4-8';

/** Whether a requested model id is one the agent is allowed to use. */
export function isAllowedModel(id: string): boolean {
  return AGENT_MODELS.some((model) => model.id === id);
}

/** USD per million tokens, split by how Anthropic bills each token class. */
interface ModelPricing {
  input: number;
  output: number;
  /** Ephemeral (5-minute) cache writes are billed at 1.25x input. */
  cacheWrite: number;
  /** Cache reads are billed at 0.1x input. */
  cacheRead: number;
}

/**
 * Anthropic list prices (USD / MTok), used for the approximate session cost in
 * the usage badge. Estimates only — not billing data.
 *
 * claude-sonnet-5 uses the introductory rate in effect through Aug 31, 2026
 * ($2/$10); it moves to $3/$15 on Sep 1, 2026.
 */
const MODEL_PRICING: Record<string, ModelPricing> = {
  'claude-sonnet-5': { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  'claude-opus-4-8': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
};

export interface TokenUsageBreakdown {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
}

/**
 * Approximate USD cost of a usage report for a given model, or null when the
 * model isn't in the pricing table (e.g. a custom ANTHROPIC_MODEL override) —
 * callers should hide the estimate rather than show a wrong number.
 */
export function estimateCostUsd(model: string, usage: TokenUsageBreakdown): number | null {
  const pricing = MODEL_PRICING[model];
  if (!pricing) return null;

  return (
    (usage.inputTokens * pricing.input +
      usage.outputTokens * pricing.output +
      usage.cacheWriteTokens * pricing.cacheWrite +
      usage.cacheReadTokens * pricing.cacheRead) / 1_000_000
  );
}

/**
 * Models and providers the in-app AI builder can use.
 *
 * This module has no server-only imports so it can be shared between the client
 * (model picker UI) and the server (request validation). The actual default is
 * still resolved server-side from settings/env in `lib/agent/config.ts`.
 */

export type AgentProviderId = 'anthropic' | 'openai' | 'google';

export interface AgentProviderOption {
  id: AgentProviderId;
  label: string;
  /** Env var that supplies the key when no setting is stored. */
  envVar: string;
  /** Input placeholder hint for the key field. */
  keyPlaceholder: string;
  /** Where the user creates an API key. */
  consoleUrl: string;
  consoleLabel: string;
}

export const AGENT_PROVIDERS: AgentProviderOption[] = [
  {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    envVar: 'ANTHROPIC_API_KEY',
    keyPlaceholder: 'sk-ant-...',
    consoleUrl: 'https://console.anthropic.com/settings/keys',
    consoleLabel: 'Anthropic Console',
  },
  {
    id: 'openai',
    label: 'OpenAI (ChatGPT)',
    envVar: 'OPENAI_API_KEY',
    keyPlaceholder: 'sk-...',
    consoleUrl: 'https://platform.openai.com/api-keys',
    consoleLabel: 'OpenAI Platform',
  },
  {
    id: 'google',
    label: 'Google Gemini',
    envVar: 'GEMINI_API_KEY',
    keyPlaceholder: 'AIza...',
    consoleUrl: 'https://aistudio.google.com/apikey',
    consoleLabel: 'Google AI Studio',
  },
];

export interface AgentModelOption {
  id: string;
  label: string;
  provider: AgentProviderId;
}

export const AGENT_MODELS: AgentModelOption[] = [
  { id: 'claude-sonnet-5', label: 'Sonnet 5', provider: 'anthropic' },
  { id: 'claude-opus-4-8', label: 'Opus 4.8', provider: 'anthropic' },
  { id: 'gpt-5.5', label: 'GPT-5.5', provider: 'openai' },
  { id: 'gpt-5-mini', label: 'GPT-5 Mini', provider: 'openai' },
  { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro', provider: 'google' },
  { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', provider: 'google' },
];

/**
 * Model selected by default in the picker. Sonnet handles the builder workload
 * well at ~2.5x lower cost than Opus; users who want a different model (or
 * provider) can switch from the dropdown.
 */
export const DEFAULT_AGENT_MODEL = 'claude-sonnet-5';

/**
 * Model for the automatic visual self-review pass, per provider. Critiquing a
 * screenshot and making small fixes doesn't need the strongest builder model,
 * and the review turn re-runs the full system + tools prompt — on a flagship
 * model that doubles an already expensive turn. Each provider's review model is
 * a genuinely faster/cheaper tier than its builder default, so the review pass
 * adds far less wall-clock time. The review stays on the same provider as the
 * main turn so it never requires a second API key.
 *
 * Some of these ids (e.g. the Anthropic Haiku tier) are intentionally NOT in the
 * user-facing picker (AGENT_MODELS) — they're review-only, so getAgentProvider
 * honors them via isReviewModel even though they aren't selectable models.
 */
const REVIEW_MODEL_BY_PROVIDER: Record<AgentProviderId, string> = {
  anthropic: 'claude-haiku-4-5',
  openai: 'gpt-5-mini',
  google: 'gemini-3.5-flash',
};

/** The self-review model matching the given main model's provider. */
export function reviewModelFor(model: string | null): string {
  const provider = providerOfModel(model ?? DEFAULT_AGENT_MODEL) ?? 'anthropic';
  return REVIEW_MODEL_BY_PROVIDER[provider];
}

/** Models used only for the auto-review pass. Some aren't in the picker
 * allowlist, so getAgentProvider accepts them for review requests specifically
 * (still requiring the provider's key). */
export const REVIEW_MODELS: ReadonlySet<string> = new Set(Object.values(REVIEW_MODEL_BY_PROVIDER));

/** Whether a model id is a review-only model the server should honor even when
 * it isn't a selectable (allowlisted/enabled) picker model. */
export function isReviewModel(id: string): boolean {
  return REVIEW_MODELS.has(id);
}

/** Which provider serves a model id, or null for unknown/custom models.
 * Resolves both picker models (AGENT_MODELS) and review-only models (which are
 * intentionally absent from the picker) so key/provider checks work for both. */
export function providerOfModel(id: string): AgentProviderId | null {
  const pickerProvider = AGENT_MODELS.find((model) => model.id === id)?.provider;
  if (pickerProvider) return pickerProvider;
  const reviewEntry = (Object.entries(REVIEW_MODEL_BY_PROVIDER) as Array<[AgentProviderId, string]>)
    .find(([, modelId]) => modelId === id);
  return reviewEntry ? reviewEntry[0] : null;
}

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
 * Provider list prices (USD / MTok), used for the approximate session cost in
 * the usage badge. Estimates only — not billing data.
 *
 * claude-sonnet-5 uses the introductory rate in effect through Aug 31, 2026
 * ($2/$10); it moves to $3/$15 on Sep 1, 2026.
 *
 * OpenAI and Google cache automatically and don't bill cache writes, so their
 * cacheWrite matches the plain input rate (a cache-writing input token costs
 * the same as an uncached one).
 */
const MODEL_PRICING: Record<string, ModelPricing> = {
  'claude-sonnet-5': { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  'claude-opus-4-8': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  // Review-only fast tier (not in the picker). Estimate for the cost badge.
  'claude-haiku-4-5': { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  'gpt-5.5': { input: 5, output: 30, cacheWrite: 5, cacheRead: 0.5 },
  'gpt-5-mini': { input: 0.25, output: 2, cacheWrite: 0.25, cacheRead: 0.025 },
  'gemini-3.1-pro-preview': { input: 2, output: 12, cacheWrite: 2, cacheRead: 0.2 },
  'gemini-3.5-flash': { input: 1.5, output: 9, cacheWrite: 1.5, cacheRead: 0.15 },
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

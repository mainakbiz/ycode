import { AGENT_MODELS, AGENT_PROVIDERS, DEFAULT_AGENT_MODEL, providerOfModel } from '@/lib/agent/models';
import { getSettingsByKeys } from '@/lib/repositories/settingsRepository';

import type { AgentProviderId } from '@/lib/agent/models';

/**
 * Resolution of which model/key the in-app agent uses.
 *
 * For self-hosters (BYOK), each provider's API key comes from the settings
 * store or the environment; the model is configurable with a sensible default.
 * The Ycode Cloud overlay supplies its own hosted resolution.
 */

/** Default model when nothing is configured. Overridable via ANTHROPIC_MODEL or settings. */
export const DEFAULT_ANTHROPIC_MODEL = DEFAULT_AGENT_MODEL;

/** Max tokens per assistant turn. */
export const DEFAULT_MAX_TOKENS = 8192;

/** Hard ceiling on tool-calling round trips per user message, to bound runaway loops. */
export const MAX_TOOL_TURNS = 24;

/**
 * Cross-turn conversation history budget, applied before the agent runs so a long
 * chat can't blow past the model's context window (the failure where the agent
 * silently stops editing on big histories). The oldest turns are dropped first.
 * `MAX_HISTORY_CHARS` is a rough proxy for tokens (~chars/4) and leaves headroom
 * for the system prompt, tool schemas, the injected page snapshot, and the
 * in-turn tool-loop growth.
 */
export const MAX_HISTORY_MESSAGES = 24;
export const MAX_HISTORY_CHARS = 160_000;

/** Settings keys holding each provider's API key. */
export const PROVIDER_KEY_SETTINGS: Record<AgentProviderId, string> = {
  anthropic: 'ai_anthropic_api_key',
  openai: 'ai_openai_api_key',
  google: 'ai_google_api_key',
};

export const SETTING_MODEL = 'ai_model';
export const SETTING_ENABLED_MODELS = 'ai_enabled_models';
export const SETTING_AGENT_ENABLED = 'ai_agent_enabled';

/** All settings keys that store a provider secret. */
export const AI_SECRET_SETTING_KEYS: string[] = Object.values(PROVIDER_KEY_SETTINGS);

/**
 * Settings key holding a user's personal (only-me) key for a provider.
 * Shared project keys live at the plain PROVIDER_KEY_SETTINGS key; personal
 * keys are suffixed with the owner's user id and shadow the shared key for
 * that user only.
 */
export function personalKeySetting(provider: AgentProviderId, userId: string): string {
  return `${PROVIDER_KEY_SETTINGS[provider]}:${userId}`;
}

/**
 * True for any settings key holding a provider secret — shared
 * ("ai_anthropic_api_key") or per-user ("ai_anthropic_api_key:<userId>").
 * Use this instead of exact-match checks wherever secrets must be filtered.
 */
export function isAgentSecretSettingKey(key: string): boolean {
  return AI_SECRET_SETTING_KEYS.some(
    (secret) => key === secret || key.startsWith(`${secret}:`),
  );
}

export type KeySource = 'setting' | 'env';

/** Who a configured key is available to. */
export type AgentKeyScope = 'all' | 'personal';

export interface ResolvedProviderKey {
  apiKey: string | null;
  /** Where the active key comes from, for the settings UI status display. */
  source: KeySource | null;
  /** Availability of the active key: 'personal' = only the current user,
   * 'all' = everyone on the project (stored shared key or env var). */
  scope: AgentKeyScope | null;
}

export interface ResolvedAgentConfig {
  /** Per-provider key resolution. */
  providers: Record<AgentProviderId, ResolvedProviderKey>;
  /** True when at least one provider has a usable key. */
  configured: boolean;
  /** Whether the agent is enabled at all. Defaults to true; when false the
   * builder hides the Agent tab and the chat API refuses to run. */
  agentEnabled: boolean;
  /** Default model: always allowed, enabled, and served by a configured provider
   * — unless it's a custom env override outside the allowlist. */
  model: string;
  /** Model ids the builder may use. Always a non-empty subset of AGENT_MODELS. */
  enabledModels: string[];
}

/** Env var(s) each provider's key can come from. */
const PROVIDER_ENV_KEYS: Record<AgentProviderId, string[]> = {
  anthropic: ['ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  // GOOGLE_API_KEY is the older alias the Google SDK also honors.
  google: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
};

/**
 * Resolve the BYOK configuration for all providers.
 *
 * Key precedence per provider: the user's personal key (when `userId` is
 * given), then the shared settings key, then the env var.
 * Model precedence: settings override, then ANTHROPIC_MODEL env var, then the
 * first enabled model of a configured provider.
 * Enabled models come from settings; an empty/invalid value means "all models".
 */
export async function resolveAgentConfig(userId?: string | null): Promise<ResolvedAgentConfig> {
  const personalKeys = userId
    ? AGENT_PROVIDERS.map((provider) => personalKeySetting(provider.id, userId))
    : [];
  const settings = await getSettingsByKeys([
    ...AI_SECRET_SETTING_KEYS,
    ...personalKeys,
    SETTING_MODEL,
    SETTING_ENABLED_MODELS,
    SETTING_AGENT_ENABLED,
  ]).catch(() => ({} as Record<string, unknown>));

  const providers = {} as Record<AgentProviderId, ResolvedProviderKey>;
  for (const provider of AGENT_PROVIDERS) {
    const personalKey = userId
      ? asNonEmptyString(settings[personalKeySetting(provider.id, userId)])
      : null;
    const sharedKey = asNonEmptyString(settings[PROVIDER_KEY_SETTINGS[provider.id]]);
    const envKey = PROVIDER_ENV_KEYS[provider.id]
      .map((name) => asNonEmptyString(process.env[name]))
      .find((value) => value !== null) ?? null;
    providers[provider.id] = {
      apiKey: personalKey ?? sharedKey ?? envKey,
      source: personalKey || sharedKey ? 'setting' : envKey ? 'env' : null,
      scope: personalKey ? 'personal' : sharedKey || envKey ? 'all' : null,
    };
  }

  const configured = AGENT_PROVIDERS.some((provider) => providers[provider.id].apiKey !== null);
  // Opt-out flag: only an explicit `false` disables the agent, so existing
  // projects (no row stored) keep the agent on.
  const agentEnabled = settings[SETTING_AGENT_ENABLED] !== false;
  const enabledModels = sanitizeEnabledModels(settings[SETTING_ENABLED_MODELS]);

  let model = asNonEmptyString(settings[SETTING_MODEL])
    ?? asNonEmptyString(process.env.ANTHROPIC_MODEL)
    ?? DEFAULT_AGENT_MODEL;

  // Keep the default usable: it must be enabled AND its provider must have a
  // key. Custom env overrides (models outside the allowlist) are left alone —
  // that's a self-hoster power feature that bypasses the picker entirely.
  if (isAllowedModelId(model)) {
    const usable = (id: string) => {
      if (!enabledModels.includes(id)) return false;
      const provider = providerOfModel(id);
      return provider !== null && providers[provider].apiKey !== null;
    };
    if (!usable(model)) {
      model = enabledModels.find(usable) ?? enabledModels[0];
    }
  }

  return { providers, configured, agentEnabled, model, enabledModels };
}

/** Coerce a stored enabled-models value into a valid non-empty allowlist subset. */
export function sanitizeEnabledModels(value: unknown): string[] {
  const allIds = AGENT_MODELS.map((option) => option.id);
  if (!Array.isArray(value)) return allIds;
  const valid = allIds.filter((id) => value.includes(id));
  return valid.length > 0 ? valid : allIds;
}

function isAllowedModelId(id: string): boolean {
  return AGENT_MODELS.some((option) => option.id === id);
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

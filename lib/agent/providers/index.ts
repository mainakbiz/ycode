import { resolveAgentConfig } from '@/lib/agent/config';
import { isAllowedModel, isReviewModel, providerOfModel } from '@/lib/agent/models';

import { createAnthropicProvider } from './anthropic';
import { createGoogleProvider } from './google';
import { createOpenAiProvider } from './openai';

import type { AgentProviderId } from '@/lib/agent/models';
import type { AgentProvider } from './types';

/**
 * Provider selection.
 *
 * The open-source build ships BYOK providers for Anthropic, OpenAI, and Google
 * Gemini, picked by the model the request runs on. The Ycode Cloud overlay
 * calls `registerHostedProvider` at startup to take over for hosted tenants —
 * so the hosted implementation lives entirely in the overlay and is simply
 * absent from self-host builds.
 */

export class AgentConfigurationError extends Error {}

type HostedProviderFactory = () => Promise<AgentProvider | null>;

let hostedProviderFactory: HostedProviderFactory | null = null;

/** Called by the Cloud overlay to provide a hosted (managed-key) backend. */
export function registerHostedProvider(factory: HostedProviderFactory): void {
  hostedProviderFactory = factory;
}

const PROVIDER_FACTORIES: Record<AgentProviderId, (apiKey: string) => AgentProvider> = {
  anthropic: createAnthropicProvider,
  openai: createOpenAiProvider,
  google: createGoogleProvider,
};

const PROVIDER_LABELS: Record<AgentProviderId, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google Gemini',
};

/**
 * Resolve the active provider for the current request.
 *
 * Prefers a registered hosted provider (Cloud); otherwise picks the BYOK
 * backend that serves the resolved model. A client-requested model is honored
 * only when it's in the allowlist, enabled in the agent settings, AND its
 * provider has a key; otherwise the server-resolved default applies. Throws
 * AgentConfigurationError when no usable backend is configured, so the API
 * route can surface a clear message.
 *
 * `userId` scopes key resolution to the requesting user, so personal
 * (only-me) provider keys are honored alongside shared project keys.
 */
export async function getAgentProvider(
  requestedModel?: string | null,
  userId?: string | null,
): Promise<{
  provider: AgentProvider;
  model: string;
  enabledModels: string[];
}> {
  const config = await resolveAgentConfig(userId);

  if (!config.agentEnabled) {
    throw new AgentConfigurationError(
      'The AI agent is turned off for this project. Enable it in Settings → Agent to use the AI builder.',
    );
  }

  let model = config.model;
  if (
    requestedModel &&
    isAllowedModel(requestedModel) &&
    config.enabledModels.includes(requestedModel) &&
    hasKeyForModel(config.providers, requestedModel)
  ) {
    model = requestedModel;
  } else if (
    // Review-only models aren't in the picker allowlist, so they skip the
    // enabled-models check — but still require the provider's key so the review
    // pass never needs a second credential.
    requestedModel &&
    isReviewModel(requestedModel) &&
    hasKeyForModel(config.providers, requestedModel)
  ) {
    model = requestedModel;
  }

  if (hostedProviderFactory) {
    const hosted = await hostedProviderFactory();
    if (hosted) return { provider: hosted, model, enabledModels: config.enabledModels };
  }

  if (!config.configured) {
    throw new AgentConfigurationError(
      'No AI agent connected. Add an Anthropic, OpenAI, or Google Gemini API key in Settings → Agent to use the AI builder.',
    );
  }

  // Custom model ids outside the allowlist (self-hoster env override) run on
  // Anthropic, matching the ANTHROPIC_MODEL escape hatch they're set through.
  const providerId = providerOfModel(model) ?? 'anthropic';
  const apiKey = config.providers[providerId].apiKey;
  if (!apiKey) {
    throw new AgentConfigurationError(
      `No API key configured for ${PROVIDER_LABELS[providerId]}. Add one in Settings → Agent or pick a model from a connected provider.`,
    );
  }

  return {
    provider: PROVIDER_FACTORIES[providerId](apiKey),
    model,
    enabledModels: config.enabledModels,
  };
}

function hasKeyForModel(
  providers: Awaited<ReturnType<typeof resolveAgentConfig>>['providers'],
  model: string,
): boolean {
  const providerId = providerOfModel(model);
  return providerId !== null && providers[providerId].apiKey !== null;
}

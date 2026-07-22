import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import {
  personalKeySetting,
  PROVIDER_KEY_SETTINGS,
  resolveAgentConfig,
  sanitizeEnabledModels,
  SETTING_AGENT_ENABLED,
  SETTING_ENABLED_MODELS,
  SETTING_MODEL,
} from '@/lib/agent/config';
import { AGENT_MODELS, AGENT_PROVIDERS } from '@/lib/agent/models';
import { getAuthUser } from '@/lib/supabase-auth';
import { getSettingsByKeys, setSettings } from '@/lib/repositories/settingsRepository';

import type { ResolvedAgentConfig } from '@/lib/agent/config';
import type { AgentProviderId } from '@/lib/agent/models';

/**
 * GET /ycode/api/settings/agent
 *
 * Agent (AI builder) configuration status for the current user. API keys are
 * never returned in full — only a masked hint per provider — so they can't
 * leak into client state.
 */
export async function GET() {
  try {
    const auth = await getAuthUser();
    const config = await resolveAgentConfig(auth?.user.id);
    return NextResponse.json({ data: toStatusPayload(config) });
  } catch (error) {
    console.error('[API] Error fetching agent settings:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch agent settings' },
      { status: 500 }
    );
  }
}

const providerIds = ['anthropic', 'openai', 'google'] as const;

const scopeSchema = z.enum(['all', 'personal']);

const putSchema = z.object({
  // Per-provider keys: undefined = keep current; null / "" = remove stored key.
  keys: z
    .object({
      anthropic: z.string().nullish(),
      openai: z.string().nullish(),
      google: z.string().nullish(),
    })
    .partial()
    .optional(),
  // Per-provider availability. With a new key: where to store it. Without a
  // key: moves the currently stored key to the given scope.
  keyScopes: z
    .object({
      anthropic: scopeSchema.optional(),
      openai: scopeSchema.optional(),
      google: scopeSchema.optional(),
    })
    .partial()
    .optional(),
  model: z.string().optional(),
  enabledModels: z.array(z.string()).optional(),
  agentEnabled: z.boolean().optional(),
});

/**
 * PUT /ycode/api/settings/agent
 *
 * Save agent configuration. Only provided fields are updated. These are
 * builder-only settings, so no public-page cache invalidation is needed.
 *
 * Keys can be scoped per provider: "all" stores them in the shared project
 * setting; "personal" stores them under the current user's id so only they
 * can use that key (their personal key shadows the shared one).
 */
export async function PUT(request: NextRequest) {
  try {
    const body = putSchema.parse(await request.json());
    const auth = await getAuthUser();
    const userId = auth?.user.id ?? null;

    if (!userId && hasPersonalIntent(body)) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const updates: Record<string, unknown> = {};

    // Current stored rows (shared + this user's personal) so key writes,
    // deletes, and scope moves can target the right row.
    const stored = await getSettingsByKeys([
      ...providerIds.map((id) => PROVIDER_KEY_SETTINGS[id]),
      ...(userId ? providerIds.map((id) => personalKeySetting(id, userId)) : []),
    ]);

    for (const providerId of providerIds) {
      const sharedSettingKey = PROVIDER_KEY_SETTINGS[providerId];
      const personalSettingKey = userId ? personalKeySetting(providerId, userId) : null;
      const hasPersonal = personalSettingKey !== null && isNonEmpty(stored[personalSettingKey]);
      const hasShared = isNonEmpty(stored[sharedSettingKey]);

      const key = body.keys?.[providerId];
      const requestedScope = body.keyScopes?.[providerId];

      if (key !== undefined) {
        const trimmed = key?.trim() ?? '';

        if (trimmed.length === 0) {
          // Disconnect: remove the row the current user's resolution points to.
          if (hasPersonal && personalSettingKey) {
            updates[personalSettingKey] = null;
          } else {
            updates[sharedSettingKey] = null;
          }
          continue;
        }

        // New key: store at the requested scope, defaulting to the scope of
        // the key it replaces (so "Replace key" keeps the availability).
        const scope = requestedScope ?? (hasPersonal ? 'personal' : 'all');
        if (scope === 'personal' && personalSettingKey) {
          updates[personalSettingKey] = trimmed;
        } else {
          updates[sharedSettingKey] = trimmed;
          // A leftover personal key would shadow the just-saved shared key
          // for this user — saving "for all users" replaces it.
          if (hasPersonal && personalSettingKey) {
            updates[personalSettingKey] = null;
          }
        }
        continue;
      }

      // Scope change without a new key: move the stored key between rows.
      if (requestedScope !== undefined && personalSettingKey) {
        if (requestedScope === 'personal' && !hasPersonal && hasShared) {
          updates[personalSettingKey] = stored[sharedSettingKey];
          updates[sharedSettingKey] = null;
        } else if (requestedScope === 'all' && hasPersonal) {
          updates[sharedSettingKey] = stored[personalSettingKey];
          updates[personalSettingKey] = null;
        }
      }
    }

    if (body.model !== undefined) {
      if (!AGENT_MODELS.some((option) => option.id === body.model)) {
        return NextResponse.json({ error: 'Unknown model' }, { status: 400 });
      }
      updates[SETTING_MODEL] = body.model;
    }

    if (body.enabledModels !== undefined) {
      const enabled = sanitizeEnabledModels(body.enabledModels);
      if (enabled.length !== body.enabledModels.length) {
        return NextResponse.json(
          { error: 'At least one valid model must be enabled' },
          { status: 400 }
        );
      }
      updates[SETTING_ENABLED_MODELS] = enabled;
    }

    if (body.agentEnabled !== undefined) {
      // Store only the opt-out; `null` deletes the row so "on" stays the default.
      updates[SETTING_AGENT_ENABLED] = body.agentEnabled ? null : false;
    }

    if (Object.keys(updates).length > 0) {
      await setSettings(updates);
    }

    const config = await resolveAgentConfig(userId);

    return NextResponse.json({
      data: toStatusPayload(config),
      message: 'Agent settings updated successfully',
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }
    console.error('[API] Error updating agent settings:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to update agent settings' },
      { status: 500 }
    );
  }
}

/** True when the request wants a personal key but we couldn't resolve the user. */
function hasPersonalIntent(body: z.infer<typeof putSchema>): boolean {
  return Object.values(body.keyScopes ?? {}).some((scope) => scope === 'personal');
}

function isNonEmpty(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function toStatusPayload(config: ResolvedAgentConfig) {
  const providers = {} as Record<AgentProviderId, {
    configured: boolean;
    source: 'setting' | 'env' | null;
    scope: 'all' | 'personal' | null;
    maskedKey: string | null;
  }>;
  for (const provider of AGENT_PROVIDERS) {
    const resolved = config.providers[provider.id];
    providers[provider.id] = {
      configured: resolved.apiKey !== null,
      source: resolved.source,
      scope: resolved.scope,
      maskedKey: resolved.apiKey ? maskKey(resolved.apiKey) : null,
    };
  }
  return {
    configured: config.configured,
    agentEnabled: config.agentEnabled,
    providers,
    model: config.model,
    enabledModels: config.enabledModels,
  };
}

/** "sk-ant-...wxyz" — enough to recognize the key without exposing it. */
function maskKey(key: string): string {
  if (key.length <= 8) return '••••';
  return `${key.slice(0, 7)}...${key.slice(-4)}`;
}

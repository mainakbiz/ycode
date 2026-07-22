'use client';

import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { agentSettingsApi } from '@/lib/api';
import { useAgentSettingsStore } from '@/stores/useAgentSettingsStore';

import type { AgentProviderOption } from '@/lib/agent/models';
import type { AgentKeyScope } from '@/types';

interface AgentKeyFormProps {
  provider: AgentProviderOption;
  submitLabel: string;
  /** Where to store the key: 'all' (project-wide) or 'personal' (only the
   * current user). Omit to keep the scope of the key being replaced. */
  keyScope?: AgentKeyScope;
  onDone: () => void;
  onCancel?: () => void;
}

/**
 * Provider API-key input with a verify-then-save submit: the key is tested
 * against the provider's API first and only stored when valid. If verification
 * fails (e.g. a network restriction on the server), a "save anyway" escape hatch
 * appears. Shared by Settings → Agent and the in-panel connect dialog.
 */
export default function AgentKeyForm({ provider, submitLabel, keyScope, onDone, onCancel }: AgentKeyFormProps) {
  const saveSettings = useAgentSettingsStore((s) => s.saveSettings);

  const [keyInput, setKeyInput] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [allowUnverified, setAllowUnverified] = useState(false);

  const inputId = `${provider.id}-key-input`;

  const handleSubmit = async (skipVerification: boolean) => {
    const trimmed = keyInput.trim();
    if (!trimmed) return;

    try {
      setIsSubmitting(true);
      setError(null);

      if (!skipVerification) {
        const test = await agentSettingsApi.testKey(provider.id, trimmed);
        if (test.error) {
          setError(test.error);
          setAllowUnverified(true);
          return;
        }
      }

      const success = await saveSettings({
        keys: { [provider.id]: trimmed },
        ...(keyScope ? { keyScopes: { [provider.id]: keyScope } } : {}),
      });
      if (!success) {
        setError(useAgentSettingsStore.getState().error ?? 'Failed to save API key');
        return;
      }
      onDone();
    } catch (err) {
      console.error('Error saving API key:', err);
      setError(err instanceof Error ? err.message : 'Failed to save API key');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Field>
      <FieldLabel htmlFor={inputId}>API key</FieldLabel>
      <FieldDescription>
        Create a key in the{' '}
        <a
          href={provider.consoleUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          {provider.consoleLabel}
        </a>
        .
      </FieldDescription>
      <div className="flex gap-2">
        <Input
          id={inputId}
          type="password"
          placeholder={provider.keyPlaceholder}
          value={keyInput}
          onChange={(e) => {
            setKeyInput(e.target.value);
            setError(null);
            setAllowUnverified(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !isSubmitting && keyInput.trim()) {
              void handleSubmit(false);
            }
          }}
          autoComplete="off"
          disabled={isSubmitting}
          className="flex-1"
        />
        <Button
          onClick={() => handleSubmit(false)}
          disabled={isSubmitting || !keyInput.trim()}
        >
          {isSubmitting ? <Spinner className="size-4" /> : submitLabel}
        </Button>
        {onCancel && (
          <Button
            variant="secondary"
            onClick={onCancel}
            disabled={isSubmitting}
          >
            Cancel
          </Button>
        )}
      </div>
      {error && (
        <div className="flex items-center gap-2">
          <p className="text-xs text-destructive">{error}</p>
          {allowUnverified && (
            <button
              type="button"
              className="text-xs underline text-muted-foreground hover:text-foreground"
              onClick={() => handleSubmit(true)}
              disabled={isSubmitting}
            >
              Save anyway
            </button>
          )}
        </div>
      )}
    </Field>
  );
}

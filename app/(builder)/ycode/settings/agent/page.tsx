'use client';

import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Field,
  FieldDescription,
  FieldLabel,
  FieldLegend,
} from '@/components/ui/field';
import { Icon } from '@/components/ui/icon';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import AgentKeyForm from '@/app/(builder)/ycode/components/ai/AgentKeyForm';
import { agentSettingsApi } from '@/lib/api';
import { AGENT_MODELS, AGENT_PROVIDERS } from '@/lib/agent/models';
import { cn } from '@/lib/utils';
import { useAgentSettingsStore } from '@/stores/useAgentSettingsStore';

import type { AgentProviderOption } from '@/lib/agent/models';
import type { AgentProviderId } from '@/types';

interface KeyFeedback {
  success: boolean;
  message: string;
}

export default function AgentSettingsPage() {
  const status = useAgentSettingsStore((s) => s.status);
  const isLoading = useAgentSettingsStore((s) => s.isLoading);
  const loadStatus = useAgentSettingsStore((s) => s.loadStatus);
  const saveSettings = useAgentSettingsStore((s) => s.saveSettings);

  const [isAddOpen, setIsAddOpen] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [isSavingModels, setIsSavingModels] = useState(false);
  const [isSavingDefault, setIsSavingDefault] = useState(false);
  const [providerToRemove, setProviderToRemove] = useState<AgentProviderOption | null>(null);
  const [isRemoving, setIsRemoving] = useState(false);

  useEffect(() => {
    void loadStatus(true);
  }, [loadStatus]);

  const connectedProviders = AGENT_PROVIDERS.filter(
    (provider) => status?.providers[provider.id]?.configured,
  );
  const availableProviders = AGENT_PROVIDERS.filter(
    (provider) => !status?.providers[provider.id]?.configured,
  );

  const enabledModels = status?.enabledModels ?? [];
  // Models the agent can actually run: enabled AND from a connected provider.
  const usableModels = AGENT_MODELS.filter(
    (option) =>
      enabledModels.includes(option.id) &&
      status?.providers[option.provider]?.configured,
  );

  const handleToggleModel = async (modelId: string, checked: boolean) => {
    if (!status) return;
    setModelsError(null);

    const next = checked
      ? [...new Set([...enabledModels, modelId])]
      : enabledModels.filter((id) => id !== modelId);

    const nextUsable = AGENT_MODELS.filter(
      (option) => next.includes(option.id) && status.providers[option.provider]?.configured,
    );
    if (nextUsable.length === 0) {
      setModelsError('At least one model must stay enabled.');
      return;
    }

    try {
      setIsSavingModels(true);
      const success = await saveSettings({ enabledModels: next });
      if (!success) {
        setModelsError(useAgentSettingsStore.getState().error ?? 'Failed to save models');
      }
    } finally {
      setIsSavingModels(false);
    }
  };

  const handleDefaultModelChange = async (value: string) => {
    setModelsError(null);
    try {
      setIsSavingDefault(true);
      const success = await saveSettings({ model: value });
      if (!success) {
        setModelsError(useAgentSettingsStore.getState().error ?? 'Failed to save default model');
      }
    } finally {
      setIsSavingDefault(false);
    }
  };

  const handleRemoveProvider = async () => {
    if (!providerToRemove) return;
    try {
      setIsRemoving(true);
      await saveSettings({ keys: { [providerToRemove.id]: null } });
    } finally {
      setIsRemoving(false);
      setProviderToRemove(null);
    }
  };

  if (isLoading && !status) {
    return (
      <div className="p-8">
        <div className="max-w-3xl mx-auto">
          <header className="pt-8 pb-3">
            <span className="text-base font-medium">Agent</span>
          </header>
          <div className="flex justify-center py-16">
            <Spinner />
          </div>
        </div>
      </div>
    );
  }

  const showAddForm = isAddOpen || connectedProviders.length === 0;

  return (
    <div className="p-8">
      <div className="max-w-3xl mx-auto">
        <header className="pt-8 pb-3">
          <span className="text-base font-medium">Agent</span>
        </header>

        <p className="text-sm text-muted-foreground pb-5">
          Connect your own AI to build and edit pages with the agent. Add one provider at a
          time — usage is billed directly to your account with that provider.
        </p>

        <div className="flex flex-col gap-4">
          {connectedProviders.map((provider) => (
            <ProviderCard
              key={provider.id}
              provider={provider}
              status={status}
              enabledModels={enabledModels}
              isSavingModels={isSavingModels}
              onToggleModel={handleToggleModel}
              onRemove={() => setProviderToRemove(provider)}
            />
          ))}

          {showAddForm && availableProviders.length > 0 ? (
            <AddProviderCard
              providers={availableProviders}
              isFirst={connectedProviders.length === 0}
              onDone={() => setIsAddOpen(false)}
              onCancel={connectedProviders.length > 0 ? () => setIsAddOpen(false) : undefined}
            />
          ) : availableProviders.length > 0 ? (
            <div>
              <Button
                variant="secondary"
                onClick={() => setIsAddOpen(true)}
              >
                <Icon name="plus" />
                Add new
              </Button>
            </div>
          ) : null}
        </div>

        {connectedProviders.length > 0 && (
          <>
            <header className="pt-10 pb-3">
              <span className="text-base font-medium">Preferences</span>
            </header>

            <div className="flex flex-col gap-6 bg-secondary/20 p-8 rounded-lg">
              <Field>
                <FieldLabel htmlFor="agent-default-model">Default model</FieldLabel>
                <FieldDescription>
                  Preselected in the agent panel — you can still switch per chat
                </FieldDescription>
                <div className="flex items-center gap-2">
                  <Select
                    value={usableModels.some((option) => option.id === status?.model) ? status?.model : usableModels[0]?.id ?? ''}
                    onValueChange={handleDefaultModelChange}
                    disabled={isSavingDefault || usableModels.length === 0}
                  >
                    <SelectTrigger id="agent-default-model" className="w-full max-w-xs">
                      <SelectValue placeholder="Select model" />
                    </SelectTrigger>
                    <SelectContent>
                      {usableModels.map((option) => (
                        <SelectItem key={option.id} value={option.id}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {isSavingDefault && <Spinner className="size-4" />}
                </div>
              </Field>

              {modelsError && (
                <p className="text-xs text-destructive">{modelsError}</p>
              )}
            </div>
          </>
        )}

        <ConfirmDialog
          open={providerToRemove !== null}
          onOpenChange={(open) => {
            if (!open) setProviderToRemove(null);
          }}
          title={`Disconnect ${providerToRemove?.label}?`}
          description="This removes the stored API key. Models from this provider will no longer be available in the agent panel."
          confirmLabel={isRemoving ? 'Disconnecting…' : 'Disconnect'}
          cancelLabel="Keep"
          confirmVariant="destructive"
          onConfirm={handleRemoveProvider}
          onCancel={() => setProviderToRemove(null)}
        />
      </div>
    </div>
  );
}

// ── Connected provider card ──────────────────────────────────────────────────

interface ProviderCardProps {
  provider: AgentProviderOption;
  status: ReturnType<typeof useAgentSettingsStore.getState>['status'];
  enabledModels: string[];
  isSavingModels: boolean;
  onToggleModel: (modelId: string, checked: boolean) => void;
  onRemove: () => void;
}

function ProviderCard({
  provider,
  status,
  enabledModels,
  isSavingModels,
  onToggleModel,
  onRemove,
}: ProviderCardProps) {
  const [isReplacing, setIsReplacing] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [feedback, setFeedback] = useState<KeyFeedback | null>(null);

  const keyStatus = status?.providers[provider.id];
  const usesEnvKey = keyStatus?.source === 'env';
  const models = AGENT_MODELS.filter((option) => option.provider === provider.id);

  const handleTest = async () => {
    try {
      setIsTesting(true);
      setFeedback(null);
      const response = await agentSettingsApi.testKey(provider.id);
      setFeedback(
        response.error
          ? { success: false, message: response.error }
          : { success: true, message: 'API key is valid' },
      );
    } catch {
      setFeedback({ success: false, message: 'Failed to test API key' });
    } finally {
      setIsTesting(false);
    }
  };

  return (
    <div className="flex flex-col bg-secondary/20 p-8 rounded-lg">
      <div className="flex items-start gap-4">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-secondary">
          <Icon name="sparkles" className="size-4 text-muted-foreground" />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <FieldLegend className="mb-0">{provider.label}</FieldLegend>
            <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground bg-secondary px-1.5 py-0.5 rounded">
              <span className="size-1.5 rounded-full bg-green-500" />
              Connected
            </span>
            {usesEnvKey && (
              <span className="text-[10px] text-muted-foreground bg-secondary px-1.5 py-0.5 rounded">
                {provider.envVar}
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground truncate">
            {usesEnvKey
              ? 'Key provided by an environment variable on your server.'
              : `API key ${keyStatus?.maskedKey ?? ''} — stored on your server, never sent to the browser.`}
          </p>
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="secondary"
              size="xs"
              aria-label={`${provider.label} options`}
            >
              {isTesting ? <Spinner className="size-3.5" /> : <Icon name="more" />}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={handleTest}>
              Test API key
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                setFeedback(null);
                setIsReplacing(true);
              }}
            >
              {usesEnvKey ? 'Override key' : 'Replace key'}
            </DropdownMenuItem>
            {!usesEnvKey && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onClick={onRemove}
                >
                  Disconnect
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {feedback && (
        <p
          className={cn(
            'text-xs mt-3',
            feedback.success ? 'text-green-600 dark:text-green-400' : 'text-destructive',
          )}
        >
          {feedback.message}
        </p>
      )}

      {isReplacing && (
        <div className="mt-4">
          <AgentKeyForm
            provider={provider}
            submitLabel="Save key"
            onDone={() => setIsReplacing(false)}
            onCancel={() => setIsReplacing(false)}
          />
        </div>
      )}

      <div className="border-t mt-6 pt-5">
        <div className="flex items-center gap-2 mb-1">
          <FieldLabel className="mb-0">Models</FieldLabel>
          {isSavingModels && <Spinner className="size-3.5" />}
        </div>
        <FieldDescription className="mb-3">
          Choose which {provider.label} models can be selected in the agent panel
        </FieldDescription>
        <div className="flex flex-col gap-2">
          {models.map((option) => (
            <label
              key={option.id}
              className="flex items-center gap-2 text-sm cursor-pointer w-fit"
            >
              <Checkbox
                checked={enabledModels.includes(option.id)}
                disabled={isSavingModels}
                onCheckedChange={(checked) => onToggleModel(option.id, checked === true)}
              />
              {option.label}
              {status?.model === option.id && (
                <span className="text-[10px] text-muted-foreground bg-secondary px-1.5 py-0.5 rounded">
                  Default
                </span>
              )}
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Add provider card ────────────────────────────────────────────────────────

interface AddProviderCardProps {
  providers: AgentProviderOption[];
  isFirst: boolean;
  onDone: () => void;
  onCancel?: () => void;
}

function AddProviderCard({ providers, isFirst, onDone, onCancel }: AddProviderCardProps) {
  const [providerId, setProviderId] = useState<AgentProviderId>(providers[0].id);

  // The previously selected provider may have just been connected (and dropped
  // from the list); snap to the first still-available one.
  const provider = providers.find((option) => option.id === providerId) ?? providers[0];

  return (
    <div className="flex flex-col gap-6 bg-secondary/20 p-8 rounded-lg">
      <header>
        <FieldLegend>{isFirst ? 'Connect your AI' : 'Add AI provider'}</FieldLegend>
        <FieldDescription>
          {isFirst
            ? 'No AI is connected yet. Pick a provider and paste an API key to enable the agent.'
            : 'Connect another provider to unlock its models in the agent panel.'}
        </FieldDescription>
      </header>

      <Field>
        <FieldLabel htmlFor="add-provider">Provider</FieldLabel>
        <Select
          value={provider.id}
          onValueChange={(value) => setProviderId(value as AgentProviderId)}
        >
          <SelectTrigger id="add-provider" className="w-full max-w-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {providers.map((option) => (
              <SelectItem key={option.id} value={option.id}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <AgentKeyForm
        key={provider.id}
        provider={provider}
        submitLabel="Connect"
        onDone={onDone}
        onCancel={onCancel}
      />
    </div>
  );
}

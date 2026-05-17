'use client';

import { useState, useEffect, useCallback } from 'react';
import { useSearchParams, usePathname, useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import {
  Field,
  FieldDescription,
  FieldLabel,
  FieldLegend,
} from '@/components/ui/field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import Icon from '@/components/ui/icon';
import Image from 'next/image';
import { toast } from 'sonner';

import type { AppCategory } from '@/lib/apps/registry';
import { APP_CATEGORIES } from '@/lib/apps/registry';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { MAILERLITE_SUBSCRIBER_FIELDS } from '@/lib/apps/mailerlite/types';
import type { MailerLiteConnection, MailerLiteFieldMapping } from '@/lib/apps/mailerlite/types';
import AirtableSettings from './airtable-settings';
import WebflowSettings from './webflow-settings';
import StaticExportSettings from './static-export-settings';

// =============================================================================
// Types
// =============================================================================

interface AppWithStatus {
  id: string;
  name: string;
  description: string;
  logo: { src: string; width: number; height: number };
  categories: AppCategory[];
  implemented: boolean;
  connected: boolean;
}

interface MailerLiteGroup {
  id: string;
  name: string;
  active_count: number;
}

interface FormSummary {
  form_id: string;
  submission_count: number;
  new_count: number;
}

interface TokenAppState {
  token: string;
  savedToken: string;
  isSaving: boolean;
  isConnected: boolean;
  isLoading: boolean;
  showDisconnect: boolean;
}

interface TokenAppConfig {
  appId: string;
  label: string;
  settingKey: string;
  tokenKey: string;
  placeholder: string;
  description: React.ReactNode;
  dashboardUrl: string;
  dashboardLabel: string;
  disconnectMessage: string;
}

const TOKEN_APP_CONFIGS: Record<string, TokenAppConfig> = {
  mapbox: {
    appId: 'mapbox',
    label: 'Mapbox',
    settingKey: 'mapbox_access_token',
    tokenKey: 'access_token',
    placeholder: 'pk.eyJ1Ijo...',
    description: 'Required for Map elements using Mapbox.',
    dashboardUrl: 'https://account.mapbox.com/access-tokens/',
    dashboardLabel: 'Mapbox dashboard',
    disconnectMessage: 'This will remove your access token. Map elements using Mapbox will stop rendering until a new token is configured.',
  },
  'google-maps-embed': {
    appId: 'google-maps-embed',
    label: 'Google Map',
    settingKey: 'google_maps_embed_api_key',
    tokenKey: 'api_key',
    placeholder: 'AIzaSy...',
    description: (
      <>
        Required for Map elements using Google Embedded Map. Make sure to enable the{' '}
        <a
          href="https://console.cloud.google.com/apis/library/maps-embed-backend.googleapis.com"
          target="_blank"
          rel="noopener noreferrer"
          className="text-foreground underline"
        >Maps Embed API</a>
        {' '}and{' '}
        <a
          href="https://console.cloud.google.com/apis/library/places.googleapis.com"
          target="_blank"
          rel="noopener noreferrer"
          className="text-foreground underline"
        >Places API</a>
        {' '}on your project.
      </>
    ),
    dashboardUrl: 'https://console.cloud.google.com/apis/credentials',
    dashboardLabel: 'Google Cloud Console',
    disconnectMessage: 'This will remove your API key. Map elements using Google Embedded Map will stop rendering until a new key is configured.',
  },
};

const DEFAULT_TOKEN_APP_STATE: TokenAppState = {
  token: '',
  savedToken: '',
  isSaving: false,
  isConnected: false,
  isLoading: false,
  showDisconnect: false,
};

// =============================================================================
// App Card Component
// =============================================================================

interface AppCardProps {
  app: AppWithStatus;
  onOpenSettings: (appId: string) => void;
}

function AppCard({ app, onOpenSettings }: AppCardProps) {
  const handleClick = () => {
    if (app.implemented) {
      onOpenSettings(app.id);
    }
  };

  return (
    <div
      onClick={handleClick}
      role={app.implemented ? 'button' : undefined}
      tabIndex={app.implemented ? 0 : undefined}
      className={`flex items-start gap-3 p-4 bg-secondary/20 rounded-lg transition-colors text-left ${app.implemented ? 'hover:bg-secondary/40 cursor-pointer' : 'opacity-50 cursor-not-allowed'}`}
    >
      <div className="flex items-center justify-center size-10 rounded-lg bg-secondary shrink-0 overflow-hidden">
        <Image
          src={app.logo}
          alt={`${app.name} logo`}
          width={24}
          height={24}
          className="size-6 object-contain rounded-sm"
        />
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span className="font-medium text-sm">{app.name}</span>
          {app.connected && (
            <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
              Connected
            </Badge>
          )}
          {!app.implemented && (
            <Badge variant="outline" className="text-[10px]">
              Coming soon
            </Badge>
          )}
        </div>
        <p className="text-xs text-muted-foreground line-clamp-2">
          {app.description}
        </p>
      </div>
    </div>
  );
}

// =============================================================================
// Main Component
// =============================================================================

export default function AppsPage() {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const updateSetting = useSettingsStore((s) => s.updateSetting);
  const getSettingByKey = useSettingsStore((s) => s.getSettingByKey);

  // App list state
  const [apps, setApps] = useState<AppWithStatus[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const validCategories = new Set(APP_CATEGORIES.map((c) => c.value));
  const [selectedCategory, setSelectedCategory] = useState<AppCategory>(() => {
    const typeParam = searchParams.get('type') as AppCategory | null;
    return typeParam && validCategories.has(typeParam) ? typeParam : 'popular';
  });

  const router = useRouter();

  // Sheet state
  const [selectedAppId, setSelectedAppId] = useState<string | null>(null);
  const [isSheetMounted, setIsSheetMounted] = useState(true);

  // MailerLite state
  const [apiKey, setApiKey] = useState('');
  const [savedApiKey, setSavedApiKey] = useState('');
  const [isTesting, setIsTesting] = useState(false);
  const [isSavingKey, setIsSavingKey] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [isLoadingSettings, setIsLoadingSettings] = useState(false);

  // Token-based app state (Mapbox, Google Map, etc.)
  const [tokenApps, setTokenApps] = useState<Record<string, TokenAppState>>({});

  // Connections state
  const [connections, setConnections] = useState<MailerLiteConnection[]>([]);
  const [isSavingConnections, setIsSavingConnections] = useState(false);

  // Inline connection editing state
  const [expandedConnectionId, setExpandedConnectionId] = useState<string | null>(null);
  const [editingConnectionId, setEditingConnectionId] = useState<string | null>(null);
  const [connectionFormId, setConnectionFormId] = useState('');
  const [connectionGroupId, setConnectionGroupId] = useState('');
  const [connectionGroupName, setConnectionGroupName] = useState('');
  const [connectionFieldMappings, setConnectionFieldMappings] = useState<MailerLiteFieldMapping[]>([
    { formField: '', mailerliteField: 'email' },
  ]);

  // Data for connection dialog selects
  const [groups, setGroups] = useState<MailerLiteGroup[]>([]);
  const [forms, setForms] = useState<FormSummary[]>([]);
  const [isLoadingGroups, setIsLoadingGroups] = useState(false);
  const [isLoadingForms, setIsLoadingForms] = useState(false);

  // Disconnect state
  const [showDisconnectDialog, setShowDisconnectDialog] = useState(false);

  // Delete connection state
  const [connectionToDelete, setConnectionToDelete] = useState<MailerLiteConnection | null>(null);

  const updateAppStatus = (appId: string, connected: boolean) => {
    setApps((prev) =>
      prev.map((a) => (a.id === appId ? { ...a, connected } : a))
    );
  };

  /** Build URL with optional type and app params */
  const buildUrl = useCallback(
    (params: { type?: string; app?: string | null }) => {
      const sp = new URLSearchParams();
      const type = params.type ?? selectedCategory;
      if (type && type !== 'popular') sp.set('type', type);
      if (params.app) sp.set('app', params.app);
      const qs = sp.toString();
      return qs ? `${pathname}?${qs}` : pathname;
    },
    [pathname, selectedCategory]
  );

  const handleCategoryChange = useCallback(
    (value: AppCategory) => {
      setSelectedCategory(value);
      window.history.replaceState(null, '', buildUrl({ type: value }));
    },
    [buildUrl]
  );

  // =========================================================================
  // Load apps on mount
  // =========================================================================

  useEffect(() => {
    fetchApps();
  }, []);

  // Auto-open app settings from ?app= query param (e.g. /ycode/integrations/apps?app=mapbox)
  useEffect(() => {
    if (isLoading) return;
    const appParam = searchParams.get('app');
    if (appParam && apps.some((a) => a.id === appParam)) {
      openAppSettings(appParam);
    }
  }, [isLoading]); // eslint-disable-line react-hooks/exhaustive-deps

  const fetchApps = async () => {
    try {
      const response = await fetch('/ycode/api/apps');
      const result = await response.json();
      if (result.data) {
        const enriched = (result.data as AppWithStatus[]).map((app) => {
          const config = TOKEN_APP_CONFIGS[app.id];
          if (config && !app.connected && getSettingByKey(config.settingKey)) {
            return { ...app, connected: true };
          }
          return app;
        });
        setApps(enriched);
      }
    } catch (error) {
      console.error('Failed to fetch apps:', error);
    } finally {
      setIsLoading(false);
    }
  };

  // =========================================================================
  // App sheet open/close
  // =========================================================================

  const openAppSettings = (appId: string) => {
    setIsSheetMounted(true);
    setSelectedAppId(appId);
    window.history.replaceState(null, '', buildUrl({ app: appId }));

    if (appId === 'mailerlite') {
      loadMailerLiteSettings();
      loadGroupsAndForms();
    } else if (appId === 'airtable') {
      // AirtableSettings handles its own loading
    } else if (appId === 'webflow') {
      // WebflowSettings handles its own loading
    } else if (TOKEN_APP_CONFIGS[appId]) {
      loadTokenApp(appId);
    }
  };

  const closeAppSettings = () => {
    setSelectedAppId(null);
    window.history.replaceState(null, '', buildUrl({ app: null }));
    setApiKey('');
    setSavedApiKey('');
    setIsConnected(false);
    setConnections([]);
    setExpandedConnectionId(null);
    resetConnectionForm();
    setTokenApps({});
  };

  // =========================================================================
  // MailerLite settings
  // =========================================================================

  const loadMailerLiteSettings = async () => {
    setIsLoadingSettings(true);
    try {
      const response = await fetch('/ycode/api/apps/mailerlite/settings');
      const result = await response.json();

      if (result.data) {
        if (result.data.api_key) {
          setSavedApiKey(result.data.api_key);
          setApiKey(result.data.api_key);
          setIsConnected(true);
        }
        if (result.data.connections) {
          setConnections(result.data.connections);
        }
      }
    } catch (error) {
      console.error('Failed to load settings:', error);
    } finally {
      setIsLoadingSettings(false);
    }
  };

  const handleTestApiKey = async () => {
    if (!apiKey.trim()) return;

    setIsTesting(true);
    try {
      const response = await fetch('/ycode/api/apps/mailerlite/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: apiKey.trim() }),
      });

      const result = await response.json();

      if (result.data?.valid) {
        toast.success('API key is valid');
      } else {
        toast.error(result.data?.error || 'Invalid API key');
      }
    } catch (error) {
      toast.error('Failed to test API key');
    } finally {
      setIsTesting(false);
    }
  };

  const handleSaveApiKey = async () => {
    if (!apiKey.trim()) return;

    setIsSavingKey(true);
    try {
      const response = await fetch('/ycode/api/apps/mailerlite/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: apiKey.trim() }),
      });

      const result = await response.json();

      if (result.data) {
        setSavedApiKey(apiKey.trim());
        setIsConnected(true);
        toast.success('API key saved');
        updateAppStatus('mailerlite', true);
      } else {
        toast.error(result.error || 'Failed to save API key');
      }
    } catch (error) {
      toast.error('Failed to save API key');
    } finally {
      setIsSavingKey(false);
    }
  };

  const handleDisconnect = async () => {
    try {
      await fetch('/ycode/api/apps/mailerlite/settings', {
        method: 'DELETE',
      });

      setApiKey('');
      setSavedApiKey('');
      setIsConnected(false);
      setConnections([]);
      setShowDisconnectDialog(false);
      toast.success('MailerLite disconnected');
      updateAppStatus('mailerlite', false);
    } catch (error) {
      toast.error('Failed to disconnect');
    }
  };

  // =========================================================================
  // Token-based app settings (Mapbox, Google Map, etc.)
  // =========================================================================

  const getTokenAppState = (appId: string): TokenAppState =>
    tokenApps[appId] || DEFAULT_TOKEN_APP_STATE;

  const updateTokenAppState = (appId: string, updates: Partial<TokenAppState>) => {
    setTokenApps((prev) => ({
      ...prev,
      [appId]: { ...(prev[appId] || DEFAULT_TOKEN_APP_STATE), ...updates },
    }));
  };

  const loadTokenApp = async (appId: string) => {
    const config = TOKEN_APP_CONFIGS[appId];
    if (!config) return;

    updateTokenAppState(appId, { isLoading: true });
    try {
      const response = await fetch(`/ycode/api/apps/${appId}/settings`);
      const result = await response.json();
      const value = result.data?.[config.tokenKey];

      if (value) {
        updateTokenAppState(appId, { token: value, savedToken: value, isConnected: true });
      }
    } catch (error) {
      console.error(`Failed to load ${config.label} settings:`, error);
    } finally {
      updateTokenAppState(appId, { isLoading: false });
    }
  };

  const handleSaveTokenApp = async (appId: string) => {
    const config = TOKEN_APP_CONFIGS[appId];
    const state = getTokenAppState(appId);
    if (!config || !state.token.trim()) return;

    updateTokenAppState(appId, { isSaving: true });
    try {
      const response = await fetch(`/ycode/api/apps/${appId}/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [config.tokenKey]: state.token.trim() }),
      });

      if (response.ok) {
        updateTokenAppState(appId, {
          savedToken: state.token.trim(),
          isConnected: true,
        });
        updateAppStatus(appId, true);
        updateSetting(config.settingKey, state.token.trim());
      } else {
        toast.error('Failed to save token');
      }
    } catch {
      toast.error('Failed to save token');
    } finally {
      updateTokenAppState(appId, { isSaving: false });
    }
  };

  const handleDisconnectTokenApp = async (appId: string) => {
    const config = TOKEN_APP_CONFIGS[appId];
    if (!config) return;

    try {
      await fetch(`/ycode/api/apps/${appId}/settings`, { method: 'DELETE' });
      updateTokenAppState(appId, {
        token: '',
        savedToken: '',
        isConnected: false,
        showDisconnect: false,
      });
      updateAppStatus(appId, false);
      updateSetting(config.settingKey, null);
    } catch {
      toast.error('Failed to disconnect');
    }
  };

  // =========================================================================
  // Connection actions
  // =========================================================================

  const loadGroupsAndForms = useCallback(async () => {
    setIsLoadingGroups(true);
    setIsLoadingForms(true);

    try {
      const [groupsRes, formsRes] = await Promise.all([
        fetch('/ycode/api/apps/mailerlite/groups'),
        fetch('/ycode/api/form-submissions?summary=true'),
      ]);

      const groupsResult = await groupsRes.json();
      const formsResult = await formsRes.json();

      if (groupsResult.data) {
        setGroups(groupsResult.data);
      }
      if (formsResult.data) {
        setForms(formsResult.data);
      }
    } catch (error) {
      console.error('Failed to load groups/forms:', error);
      toast.error('Failed to load data for connection setup');
    } finally {
      setIsLoadingGroups(false);
      setIsLoadingForms(false);
    }
  }, []);

  const resetConnectionForm = () => {
    setEditingConnectionId(null);
    setConnectionFormId('');
    setConnectionGroupId('');
    setConnectionGroupName('');
    setConnectionFieldMappings([{ formField: '', mailerliteField: 'email' }]);
  };

  const expandConnection = (connection: MailerLiteConnection) => {
    if (expandedConnectionId === connection.id) {
      setExpandedConnectionId(null);
      resetConnectionForm();
      return;
    }
    setEditingConnectionId(connection.id);
    setConnectionFormId(connection.formId);
    setConnectionGroupId(connection.groupId);
    setConnectionGroupName(connection.groupName);
    setConnectionFieldMappings(
      connection.fieldMappings.length > 0
        ? connection.fieldMappings
        : [{ formField: '', mailerliteField: 'email' }]
    );
    setExpandedConnectionId(connection.id);
  };

  const addNewConnection = () => {
    const newId = `new-${Date.now()}`;
    resetConnectionForm();
    setEditingConnectionId(null);
    setExpandedConnectionId(newId);
  };

  const handleSaveConnection = async () => {
    if (!connectionFormId || !connectionGroupId) {
      toast.error('Please select a form and a group');
      return;
    }

    const emailMapping = connectionFieldMappings.find((m) => m.mailerliteField === 'email');
    if (!emailMapping || !emailMapping.formField) {
      toast.error('Email field mapping is required');
      return;
    }

    const validMappings = connectionFieldMappings.filter(
      (m) => m.formField && m.mailerliteField
    );

    const connection: MailerLiteConnection = {
      id: editingConnectionId || crypto.randomUUID(),
      formId: connectionFormId,
      groupId: connectionGroupId,
      groupName: connectionGroupName,
      fieldMappings: validMappings,
      enabled: true,
    };

    let updatedConnections: MailerLiteConnection[];

    if (editingConnectionId) {
      updatedConnections = connections.map((c) =>
        c.id === editingConnectionId ? { ...connection, enabled: c.enabled } : c
      );
    } else {
      updatedConnections = [...connections, connection];
    }

    setIsSavingConnections(true);
    try {
      const response = await fetch('/ycode/api/apps/mailerlite/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connections: updatedConnections }),
      });

      const result = await response.json();

      if (result.data) {
        setConnections(updatedConnections);
        setExpandedConnectionId(null);
        resetConnectionForm();
        toast.success(editingConnectionId ? 'Connection updated' : 'Connection added');
      } else {
        toast.error(result.error || 'Failed to save connection');
      }
    } catch (error) {
      toast.error('Failed to save connection');
    } finally {
      setIsSavingConnections(false);
    }
  };

  const handleToggleConnection = async (connectionId: string, enabled: boolean) => {
    const updatedConnections = connections.map((c) =>
      c.id === connectionId ? { ...c, enabled } : c
    );

    try {
      await fetch('/ycode/api/apps/mailerlite/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connections: updatedConnections }),
      });

      setConnections(updatedConnections);
    } catch (error) {
      toast.error('Failed to update connection');
    }
  };

  const handleDeleteConnection = async () => {
    if (!connectionToDelete) return;

    const updatedConnections = connections.filter(
      (c) => c.id !== connectionToDelete.id
    );

    try {
      await fetch('/ycode/api/apps/mailerlite/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connections: updatedConnections }),
      });

      setConnections(updatedConnections);
      setConnectionToDelete(null);
      toast.success('Connection deleted');
    } catch (error) {
      toast.error('Failed to delete connection');
    }
  };

  // =========================================================================
  // Field mapping helpers
  // =========================================================================

  const addFieldMapping = () => {
    const usedFields = new Set(connectionFieldMappings.map((m) => m.mailerliteField));
    const availableField = MAILERLITE_SUBSCRIBER_FIELDS.find(
      (f) => !usedFields.has(f.key) && !f.required
    );

    setConnectionFieldMappings([
      ...connectionFieldMappings,
      { formField: '', mailerliteField: availableField?.key || '' },
    ]);
  };

  const removeFieldMapping = (index: number) => {
    setConnectionFieldMappings(connectionFieldMappings.filter((_, i) => i !== index));
  };

  const updateFieldMapping = (
    index: number,
    field: 'formField' | 'mailerliteField',
    value: string
  ) => {
    const updated = [...connectionFieldMappings];
    updated[index] = { ...updated[index], [field]: value };
    setConnectionFieldMappings(updated);
  };

  // =========================================================================
  // Connection form (reusable for both new and editing)
  // =========================================================================

  const renderConnectionForm = () => (
    <>
      {/* Form Selection */}
      <Field>
        <FieldLabel>Ycode Form</FieldLabel>
        {isLoadingForms ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground py-1">
            <Spinner /> Loading forms...
          </div>
        ) : forms.length === 0 ? (
          <p className="text-xs text-muted-foreground py-1">
            No forms found. Submit a form first.
          </p>
        ) : (
          <Select
            value={connectionFormId}
            onValueChange={setConnectionFormId}
          >
            <SelectTrigger className="text-xs">
              <SelectValue placeholder="Select a form" />
            </SelectTrigger>
            <SelectContent>
              {forms.map((form) => (
                <SelectItem
                  key={form.form_id}
                  value={form.form_id}
                >
                  {form.form_id} ({form.submission_count} submissions)
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </Field>

      {/* Group Selection */}
      <Field>
        <FieldLabel>MailerLite Group</FieldLabel>
        {isLoadingGroups ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground py-1">
            <Spinner /> Loading groups...
          </div>
        ) : groups.length === 0 ? (
          <p className="text-xs text-muted-foreground py-1">
            No groups found. Create a group in MailerLite first.
          </p>
        ) : (
          <Select
            value={connectionGroupId}
            onValueChange={(value) => {
              setConnectionGroupId(value);
              const group = groups.find((g) => g.id === value);
              setConnectionGroupName(group?.name || '');
            }}
          >
            <SelectTrigger className="text-xs">
              <SelectValue placeholder="Select a group" />
            </SelectTrigger>
            <SelectContent>
              {groups.map((group) => (
                <SelectItem
                  key={group.id}
                  value={group.id}
                >
                  {group.name} ({group.active_count} subscribers)
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </Field>

      {/* Field Mappings */}
      <Field>
        <div className="flex items-center justify-between">
          <FieldLabel>Field Mappings</FieldLabel>
          <Button
            variant="ghost"
            size="xs"
            onClick={addFieldMapping}
            disabled={connectionFieldMappings.length >= MAILERLITE_SUBSCRIBER_FIELDS.length}
          >
            <Icon name="plus" className="size-3 mr-1" />
            Add field
          </Button>
        </div>
        <FieldDescription>
          Map form fields to MailerLite fields. Email is required.
        </FieldDescription>

        <div className="space-y-2 mt-2">
          <div className="grid grid-cols-[1fr_auto_1fr_auto] gap-2 items-center text-[11px] text-muted-foreground px-1">
            <span>Form field</span>
            <span />
            <span>MailerLite field</span>
            <span className="w-7" />
          </div>

          {connectionFieldMappings.map((mapping, index) => {
            const isEmailField = mapping.mailerliteField === 'email';

            return (
              <div
                key={index}
                className="grid grid-cols-[1fr_auto_1fr_auto] gap-2 items-center"
              >
                <Input
                  placeholder="e.g., email"
                  value={mapping.formField}
                  onChange={(e) =>
                    updateFieldMapping(index, 'formField', e.target.value)
                  }
                  className="text-xs"
                />

                <Icon
                  name="arrowLeft"
                  className="size-3 text-muted-foreground rotate-180"
                />

                <Select
                  value={mapping.mailerliteField}
                  onValueChange={(value) =>
                    updateFieldMapping(index, 'mailerliteField', value)
                  }
                >
                  <SelectTrigger className="text-xs">
                    <SelectValue placeholder="Select field" />
                  </SelectTrigger>
                  <SelectContent>
                    {MAILERLITE_SUBSCRIBER_FIELDS.map((field) => (
                      <SelectItem
                        key={field.key}
                        value={field.key}
                      >
                        {field.label}
                        {field.required && ' *'}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <div className="w-7 flex justify-center">
                  {!isEmailField && (
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() => removeFieldMapping(index)}
                    >
                      <Icon name="x" className="size-3" />
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </Field>
    </>
  );

  // =========================================================================
  // Render
  // =========================================================================

  // Derived data
  const connectedApps = apps.filter((app) => app.connected);
  const connectedIds = new Set(connectedApps.map((app) => app.id));
  const filteredApps = apps
    .filter((app) => !connectedIds.has(app.id) && app.categories.includes(selectedCategory))
    .sort((a, b) => Number(b.implemented) - Number(a.implemented));

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-16">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="p-8">
      <div className="max-w-3xl mx-auto">

        <header className="pt-8 pb-3">
          <span className="text-base font-medium">Apps</span>
        </header>

        <p className="text-sm text-muted-foreground mb-6">
          Connect third-party apps and services to extend your website&apos;s functionality.
        </p>

        {/* Connected Apps Section */}
        {connectedApps.length > 0 && (
          <div className="mb-8">
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">
              Connected
            </h3>
            <div className="grid grid-cols-2 gap-3">
              {connectedApps.map((app) => (
                <AppCard
                  key={app.id}
                  app={app}
                  onOpenSettings={openAppSettings}
                />
              ))}
            </div>
          </div>
        )}

        {/* All Apps Section */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              All Apps
            </h3>
            <Select
              value={selectedCategory}
              onValueChange={(value) => handleCategoryChange(value as AppCategory)}
            >
              <SelectTrigger className="w-35 h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {APP_CATEGORIES.map((cat) => (
                  <SelectItem
                    key={cat.value}
                    value={cat.value}
                  >
                    {cat.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {filteredApps.length === 0 ? (
            <div className="py-12 text-center text-muted-foreground text-sm border border-dashed rounded-lg">
              There are no other apps in this category.
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              {filteredApps.map((app) => (
                <AppCard
                  key={app.id}
                  app={app}
                  onOpenSettings={openAppSettings}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* App Settings Sheet */}
      {isSheetMounted && (
        <Sheet
          open={!!selectedAppId}
          onOpenChange={(open: boolean) => {
            if (!open) closeAppSettings();
          }}
        >
          <SheetContent className="sm:max-w-lg overflow-y-auto">
            {selectedAppId && TOKEN_APP_CONFIGS[selectedAppId] && (() => {
              const config = TOKEN_APP_CONFIGS[selectedAppId];
              const state = getTokenAppState(selectedAppId);
              return (
                <>
                  <SheetHeader>
                    <SheetTitle className="mr-auto">
                      {config.label}
                    </SheetTitle>
                    {state.isConnected && state.savedToken && (
                      <Button
                        variant="secondary"
                        size="xs"
                        onClick={() => updateTokenAppState(selectedAppId, { showDisconnect: true })}
                      >
                        Disconnect
                      </Button>
                    )}
                    <SheetDescription className="sr-only">
                      {config.label} integration settings
                    </SheetDescription>
                  </SheetHeader>

                  {state.isLoading ? (
                    <div className="flex items-center justify-center py-12">
                      <Spinner />
                    </div>
                  ) : (
                    <div className="mt-3 space-y-8">
                      <div className="space-y-4">
                        <FieldDescription className="flex flex-col gap-2">
                          <span>{config.description}</span>
                          <span>
                            Get your key from the{' '}
                            <a
                              href={config.dashboardUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-foreground underline"
                            >
                              {config.dashboardLabel}
                            </a>.
                          </span>
                        </FieldDescription>

                        <Field>
                          <FieldLabel htmlFor={`${selectedAppId}-token`}>API Key</FieldLabel>
                          <Input
                            id={`${selectedAppId}-token`}
                            type="password"
                            placeholder={
                              !state.savedToken && getSettingByKey(config.settingKey)
                                ? 'The default API key is already provided by this server.'
                                : config.placeholder
                            }
                            value={state.token}
                            onChange={(e) => updateTokenAppState(selectedAppId, { token: e.target.value })}
                            className="font-mono text-xs"
                          />
                          <div className="flex gap-2 mt-2">
                            <Button
                              size="sm"
                              onClick={() => handleSaveTokenApp(selectedAppId)}
                              disabled={!state.token.trim() || state.token === state.savedToken || state.isSaving}
                            >
                              {state.isSaving ? 'Saving...' : 'Save'}
                            </Button>
                          </div>
                        </Field>
                      </div>
                    </div>
                  )}
                </>
              );
            })()}

            {selectedAppId === 'airtable' && (
              <AirtableSettings
                onDisconnect={() => updateAppStatus('airtable', false)}
                onConnectionChange={(connected) => updateAppStatus('airtable', connected)}
                onCloseAndNavigate={(path) => {
                  setIsSheetMounted(false);
                  closeAppSettings();
                  router.push(path);
                }}
              />
            )}

            {selectedAppId === 'webflow' && (
              <WebflowSettings
                onDisconnect={() => updateAppStatus('webflow', false)}
                onConnectionChange={(connected) => updateAppStatus('webflow', connected)}
                onCloseAndNavigate={(path) => {
                  setIsSheetMounted(false);
                  closeAppSettings();
                  router.push(path);
                }}
              />
            )}

            {selectedAppId === 'static-export' && (
              <StaticExportSettings />
            )}

            {selectedAppId === 'mailerlite' && (
              <>
                <SheetHeader>
                  <SheetTitle className="mr-auto">
                    MailerLite
                  </SheetTitle>
                  {isConnected && (
                    <Button
                      variant="secondary"
                      size="xs"
                      onClick={() => setShowDisconnectDialog(true)}
                    >
                      Disconnect
                    </Button>
                  )}
                  <SheetDescription className="sr-only">
                    MailerLite integration settings
                  </SheetDescription>
                </SheetHeader>

                {isLoadingSettings ? (
                  <div className="flex items-center justify-center py-12">
                    <Spinner />
                  </div>
                ) : (
                  <div className="mt-3 space-y-8">

                    {/* API Key Section */}
                    <div className="space-y-4">
                      <FieldDescription>
                        Enter your MailerLite API key. Find it in{' '}
                        <span className="text-foreground">MailerLite &rarr; Integrations &rarr; API</span>.
                      </FieldDescription>

                      <Field>
                        <FieldLabel htmlFor="api-key">API Key</FieldLabel>
                        <Input
                          id="api-key"
                          type="password"
                          placeholder="Enter your MailerLite API key"
                          value={apiKey}
                          onChange={(e) => setApiKey(e.target.value)}
                          className="font-mono text-xs"
                        />
                        <div className="flex gap-2 mt-2">
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={handleTestApiKey}
                            disabled={!apiKey.trim() || isTesting}
                          >
                            {isTesting ? 'Testing...' : 'Test connection'}
                          </Button>
                          <Button
                            size="sm"
                            onClick={handleSaveApiKey}
                            disabled={!apiKey.trim() || apiKey === savedApiKey || isSavingKey}
                          >
                            {isSavingKey ? 'Saving...' : 'Save'}
                          </Button>
                        </div>
                      </Field>
                    </div>

                    {/* Connections Section */}
                    {isConnected && (
                      <div className="space-y-4 border-t pt-6">
                        <div className="flex items-center justify-between">
                          <FieldLegend>Connections</FieldLegend>
                          <Button
                            variant="secondary"
                            size="xs"
                            onClick={addNewConnection}
                          >
                            <Icon name="plus" className="size-3 mr-1" />
                            Add
                          </Button>
                        </div>
                        <FieldDescription>
                          Map form submissions to MailerLite subscriber groups.
                        </FieldDescription>

                        {connections.length > 0 ? (
                          <div className="space-y-2">
                            {connections.map((connection) => (
                              <Collapsible
                                key={connection.id}
                                open={expandedConnectionId === connection.id}
                                onOpenChange={(open: boolean) => {
                                  if (open) {
                                    expandConnection(connection);
                                  } else {
                                    setExpandedConnectionId(null);
                                    resetConnectionForm();
                                  }
                                }}
                              >
                                <div className="border rounded-lg overflow-hidden">
                                  <CollapsibleTrigger asChild>
                                    <div
                                      role="button"
                                      tabIndex={0}
                                      className="w-full flex items-center gap-3 p-3 text-left hover:bg-secondary/30 transition-colors cursor-pointer"
                                    >
                                      <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-1.5 mb-0.5">
                                          <Label className="font-medium text-xs pointer-events-none">
                                            {connection.formId}
                                          </Label>
                                          <span className="text-muted-foreground text-xs">&rarr;</span>
                                          <span className="text-xs text-muted-foreground truncate">
                                            {connection.groupName}
                                          </span>
                                        </div>
                                        <div className="text-[11px] text-muted-foreground">
                                          {connection.fieldMappings.length} field{connection.fieldMappings.length !== 1 ? 's' : ''} mapped
                                        </div>
                                      </div>

                                      <Switch
                                        checked={connection.enabled}
                                        onClick={(e) => e.stopPropagation()}
                                        onCheckedChange={(enabled) =>
                                          handleToggleConnection(connection.id, enabled)
                                        }
                                      />

                                      <Icon
                                        name="chevronRight"
                                        className={`size-3 text-muted-foreground transition-transform ${expandedConnectionId === connection.id ? 'rotate-90' : ''}`}
                                      />
                                    </div>
                                  </CollapsibleTrigger>

                                  <CollapsibleContent>
                                    <div className="border-t px-3 pb-3 pt-3 space-y-4">
                                      {renderConnectionForm()}

                                      <div className="flex items-center justify-between pt-2">
                                        <Button
                                          variant="ghost"
                                          size="sm"
                                          className="text-destructive hover:text-destructive"
                                          onClick={() => setConnectionToDelete(connection)}
                                        >
                                          Delete connection
                                        </Button>
                                        <Button
                                          size="sm"
                                          onClick={handleSaveConnection}
                                          disabled={
                                            !connectionFormId ||
                                            !connectionGroupId ||
                                            !connectionFieldMappings.some(
                                              (m) => m.mailerliteField === 'email' && m.formField
                                            ) ||
                                            isSavingConnections
                                          }
                                        >
                                          {isSavingConnections ? 'Saving...' : 'Save changes'}
                                        </Button>
                                      </div>
                                    </div>
                                  </CollapsibleContent>
                                </div>
                              </Collapsible>
                            ))}
                          </div>
                        ) : expandedConnectionId ? null : (
                          <div className="py-6 text-center text-muted-foreground text-xs border border-dashed rounded-lg">
                            No connections yet. Add one to start sending form data to MailerLite.
                          </div>
                        )}

                        {/* New connection form (not yet saved) */}
                        {expandedConnectionId?.startsWith('new-') && (
                          <div className="border rounded-lg overflow-hidden">
                            <div className="p-3 bg-secondary/20">
                              <Label className="font-medium text-xs">New connection</Label>
                            </div>
                            <div className="border-t px-3 pb-3 pt-3 space-y-4">
                              {renderConnectionForm()}

                              <div className="flex items-center justify-between pt-2">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => {
                                    setExpandedConnectionId(null);
                                    resetConnectionForm();
                                  }}
                                >
                                  Cancel
                                </Button>
                                <Button
                                  size="sm"
                                  onClick={handleSaveConnection}
                                  disabled={
                                    !connectionFormId ||
                                    !connectionGroupId ||
                                    !connectionFieldMappings.some(
                                      (m) => m.mailerliteField === 'email' && m.formField
                                    ) ||
                                    isSavingConnections
                                  }
                                >
                                  {isSavingConnections ? 'Saving...' : 'Add connection'}
                                </Button>
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </SheetContent>
        </Sheet>
      )}

      {/* Disconnect Confirmation Dialog */}
      <ConfirmDialog
        open={showDisconnectDialog}
        onOpenChange={setShowDisconnectDialog}
        title="Disconnect MailerLite?"
        description="This will remove your API key and all connections. Form submissions will no longer be sent to MailerLite."
        confirmLabel="Disconnect"
        cancelLabel="Cancel"
        confirmVariant="destructive"
        onConfirm={handleDisconnect}
        onCancel={() => setShowDisconnectDialog(false)}
      />

      {/* Token App Disconnect Confirmation Dialogs */}
      {Object.entries(TOKEN_APP_CONFIGS).map(([appId, config]) => {
        const state = getTokenAppState(appId);
        return (
          <ConfirmDialog
            key={appId}
            open={state.showDisconnect}
            onOpenChange={(open: boolean) =>
              updateTokenAppState(appId, { showDisconnect: open })
            }
            title={`Disconnect ${config.label}?`}
            description={config.disconnectMessage}
            confirmLabel="Disconnect"
            cancelLabel="Cancel"
            confirmVariant="destructive"
            onConfirm={() => handleDisconnectTokenApp(appId)}
            onCancel={() => updateTokenAppState(appId, { showDisconnect: false })}
          />
        );
      })}

      {/* Delete Connection Confirmation Dialog */}
      <ConfirmDialog
        open={!!connectionToDelete}
        onOpenChange={(open: boolean) => {
          if (!open) setConnectionToDelete(null);
        }}
        title="Delete connection?"
        description={`This will remove the connection between form "${connectionToDelete?.formId}" and MailerLite group "${connectionToDelete?.groupName}".`}
        confirmLabel="Delete"
        cancelLabel="Cancel"
        confirmVariant="destructive"
        onConfirm={handleDeleteConnection}
        onCancel={() => setConnectionToDelete(null)}
      />
    </div>
  );
}

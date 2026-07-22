'use client';

import { create } from 'zustand';

import { agentSettingsApi } from '@/lib/api';
import type { AgentSettingsStatus, UpdateAgentSettingsData } from '@/types';

interface AgentSettingsState {
  /** Null until the first load completes. */
  status: AgentSettingsStatus | null;
  isLoading: boolean;
  error: string | null;
}

interface AgentSettingsActions {
  /** Fetch the agent configuration status (de-duped after the first success). */
  loadStatus: (force?: boolean) => Promise<void>;
  /** Save agent settings and refresh the cached status. */
  saveSettings: (data: UpdateAgentSettingsData) => Promise<boolean>;
}

type AgentSettingsStore = AgentSettingsState & AgentSettingsActions;

export const useAgentSettingsStore = create<AgentSettingsStore>((set, get) => ({
  status: null,
  isLoading: false,
  error: null,

  loadStatus: async (force = false) => {
    const { status, isLoading } = get();
    if (isLoading || (status && !force)) return;

    try {
      set({ isLoading: true, error: null });
      const response = await agentSettingsApi.getStatus();
      if (response.error || !response.data) {
        set({ error: response.error ?? 'Failed to load agent settings' });
        return;
      }
      set({ status: response.data });
    } catch (error) {
      console.error('Error loading agent settings:', error);
      set({ error: error instanceof Error ? error.message : 'Failed to load agent settings' });
    } finally {
      set({ isLoading: false });
    }
  },

  saveSettings: async (data) => {
    try {
      set({ error: null });
      const response = await agentSettingsApi.update(data);
      if (response.error || !response.data) {
        set({ error: response.error ?? 'Failed to save agent settings' });
        return false;
      }
      set({ status: response.data });
      return true;
    } catch (error) {
      console.error('Error saving agent settings:', error);
      set({ error: error instanceof Error ? error.message : 'Failed to save agent settings' });
      return false;
    }
  },
}));

'use client';

import React, { useEffect } from 'react';

import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAgentSettingsStore } from '@/stores/useAgentSettingsStore';
import { useAiChatStore } from '@/stores/useAiChatStore';

import AiChatPanel from './ai/AiChatPanel';
import RightSidebar from './RightSidebar';

import type { Layer } from '@/types';

interface RightPanelProps {
  onLayerUpdate: (layerId: string, updates: Partial<Layer>) => void;
}

/**
 * Right-hand column shell hosting the top-level Human / Agent switch.
 * "Human" surfaces the manual property editor (Design / Settings /
 * Interactions) that lives in RightSidebar; "Agent" surfaces the AI chat.
 *
 * When the agent is turned off in Settings → Agent, the switch is hidden
 * entirely and only the manual editor is rendered.
 */
export default function RightPanel({ onLayerUpdate }: RightPanelProps) {
  const isAgent = useAiChatStore((state) => state.isOpen);
  const open = useAiChatStore((state) => state.open);
  const close = useAiChatStore((state) => state.close);
  const agentEnabled = useAgentSettingsStore((state) => state.status?.agentEnabled ?? true);
  const loadStatus = useAgentSettingsStore((state) => state.loadStatus);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const handleModeChange = (value: string) => {
    if (value === 'agent') {
      open();
    } else {
      close();
    }
  };

  if (!agentEnabled) {
    return <RightSidebar onLayerUpdate={onLayerUpdate} />;
  }

  return (
    <div className="w-64 shrink-0 bg-background border-l flex flex-col h-full overflow-hidden">
      <div className="px-4 pt-4 shrink-0">
        <Tabs value={isAgent ? 'agent' : 'human'} onValueChange={handleModeChange}>
          <TabsList className="w-full">
            <TabsTrigger value="human" className="flex-1">Human</TabsTrigger>
            <TabsTrigger value="agent" className="flex-1">Agent</TabsTrigger>
          </TabsList>
        </Tabs>
        <hr className="mt-4" />
      </div>

      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        {isAgent ? (
          <AiChatPanel embedded />
        ) : (
          <RightSidebar embedded onLayerUpdate={onLayerUpdate} />
        )}
      </div>
    </div>
  );
}

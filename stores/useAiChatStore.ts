'use client';

import { create } from 'zustand';

import { useEditorStore } from '@/stores/useEditorStore';

/** A tool the agent invoked during an assistant turn, shown as a status line. */
export interface ChatToolCall {
  id: string;
  name: string;
  ok?: boolean;
}

/** A preview of an image the user attached to a message. */
export interface ChatImage {
  id: string;
  dataUrl: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  toolCalls: ChatToolCall[];
  images?: ChatImage[];
}

type ChatStatus = 'idle' | 'streaming';

interface AiChatState {
  isOpen: boolean;
  messages: ChatMessage[];
  status: ChatStatus;
  error: string | null;
}

/** A layer the user explicitly attached as context for a message. */
export interface SelectedLayerRef {
  id: string;
  name: string;
}

/** An image the user attached to a message, ready to send to the model. */
export interface ImageAttachment {
  /** MIME type, e.g. "image/png". */
  mediaType: string;
  /** Base64-encoded bytes (no data: URL prefix). */
  data: string;
  /** Full data URL, used only for local preview. */
  dataUrl: string;
}

/** Extra context attached to a single message from the composer. */
export interface MessageAttachment {
  selectedLayers?: SelectedLayerRef[];
  images?: ImageAttachment[];
}

interface AiChatActions {
  open: () => void;
  close: () => void;
  toggle: () => void;
  clear: () => void;
  stop: () => void;
  sendMessage: (text: string, attachment?: MessageAttachment) => Promise<void>;
}

type AiChatStore = AiChatState & AiChatActions;

/** Server-sent runtime events, mirrored from lib/agent/runtime.ts RuntimeEvent. */
type RuntimeEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; id: string; name: string; ok: boolean }
  | { type: 'done'; stopReason: string | null }
  | { type: 'error'; message: string };

let abortController: AbortController | null = null;

function newId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export const useAiChatStore = create<AiChatStore>((set, get) => ({
  isOpen: false,
  messages: [],
  status: 'idle',
  error: null,

  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
  toggle: () => set((state) => ({ isOpen: !state.isOpen })),

  clear: () => {
    get().stop();
    set({ messages: [], error: null });
  },

  stop: () => {
    abortController?.abort();
    abortController = null;
    set({ status: 'idle' });
  },

  sendMessage: async (text: string, attachment?: MessageAttachment) => {
    const trimmed = text.trim();
    const images = attachment?.images ?? [];
    if ((!trimmed && images.length === 0) || get().status === 'streaming') return;

    const promptText = trimmed || 'Use the attached image(s) as a reference for what to build.';
    const userMessage: ChatMessage = {
      id: newId(),
      role: 'user',
      text: trimmed,
      toolCalls: [],
      images: images.length > 0 ? images.map((img) => ({ id: newId(), dataUrl: img.dataUrl })) : undefined,
    };
    const assistantMessage: ChatMessage = { id: newId(), role: 'assistant', text: '', toolCalls: [] };

    // History to send: prior text-bearing turns plus this new user message.
    const history = get().messages
      .filter((message) => message.text.trim().length > 0)
      .map((message) => ({ role: message.role, content: message.text }));

    set((state) => ({
      messages: [...state.messages, userMessage, assistantMessage],
      status: 'streaming',
      error: null,
    }));

    const editor = useEditorStore.getState();
    abortController = new AbortController();

    // The new user turn carries text plus any attached images as content blocks;
    // prior turns are sent as plain text (history images are not re-sent).
    const userContent =
      images.length > 0
        ? [
          { type: 'text' as const, text: promptText },
          ...images.map((img) => ({ type: 'image' as const, mediaType: img.mediaType, data: img.data })),
        ]
        : promptText;

    const patchAssistant = (updater: (message: ChatMessage) => ChatMessage) => {
      set((state) => ({
        messages: state.messages.map((message) =>
          message.id === assistantMessage.id ? updater(message) : message,
        ),
      }));
    };

    try {
      const response = await fetch('/ycode/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [...history, { role: 'user', content: userContent }],
          pageId: editor.currentPageId,
          selectedLayers: attachment?.selectedLayers ?? [],
        }),
        signal: abortController.signal,
      });

      if (!response.ok || !response.body) {
        const message = await safeErrorMessage(response);
        patchAssistant((m) => ({ ...m, text: m.text || message }));
        set({ error: message, status: 'idle' });
        return;
      }

      await consumeSse(response.body, (event) => applyEvent(event, patchAssistant, set));
    } catch (error) {
      if ((error as Error).name === 'AbortError') return;
      const message = error instanceof Error ? error.message : 'Something went wrong';
      set({ error: message });
    } finally {
      abortController = null;
      set({ status: 'idle' });
    }
  },
}));

function applyEvent(
  event: RuntimeEvent,
  patchAssistant: (updater: (message: ChatMessage) => ChatMessage) => void,
  set: (partial: Partial<AiChatState>) => void,
): void {
  switch (event.type) {
    case 'text':
      patchAssistant((m) => ({ ...m, text: m.text + event.text }));
      break;
    case 'tool_call':
      patchAssistant((m) => ({ ...m, toolCalls: [...m.toolCalls, { id: event.id, name: event.name }] }));
      break;
    case 'tool_result':
      patchAssistant((m) => ({
        ...m,
        toolCalls: m.toolCalls.map((call) => (call.id === event.id ? { ...call, ok: event.ok } : call)),
      }));
      break;
    case 'error':
      set({ error: event.message });
      break;
    case 'done':
    default:
      break;
  }
}

async function consumeSse(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: RuntimeEvent) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split('\n\n');
    buffer = chunks.pop() ?? '';

    for (const chunk of chunks) {
      const line = chunk.trim();
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        onEvent(JSON.parse(payload) as RuntimeEvent);
      } catch {
        // Ignore malformed frames.
      }
    }
  }
}

async function safeErrorMessage(response: Response): Promise<string> {
  try {
    const data = await response.json();
    return typeof data?.error === 'string' ? data.error : `Request failed (${response.status})`;
  } catch {
    return `Request failed (${response.status})`;
  }
}

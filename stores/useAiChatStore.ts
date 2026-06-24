'use client';

import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import { DEFAULT_AGENT_MODEL } from '@/lib/agent/models';
import { useComponentsStore } from '@/stores/useComponentsStore';
import { useEditorStore } from '@/stores/useEditorStore';
import { usePagesStore } from '@/stores/usePagesStore';
import type { Layer } from '@/types';

/** A tool the agent invoked during an assistant turn, shown as a status line. */
export interface ChatToolCall {
  id: string;
  name: string;
  ok?: boolean;
}

/**
 * An ordered fragment of an assistant turn. Tracking text and tool calls as a
 * single chronological list (rather than separate fields) lets the UI render
 * them interleaved in the order they streamed in, instead of always hoisting
 * the tool checklist above the reply.
 */
export type ChatMessagePart =
  | { type: 'text'; text: string }
  | { type: 'tool'; call: ChatToolCall };

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
  /**
   * Ordered text/tool fragments for assistant turns, used for rendering. `text`
   * and `toolCalls` are kept in sync for history, persistence, and review logic.
   */
  parts?: ChatMessagePart[];
  images?: ChatImage[];
  /** True for the auto-generated visual self-review turn (rendered compactly). */
  review?: boolean;
  /** True while a pre-turn page snapshot exists and can be restored (not persisted). */
  canRevert?: boolean;
  /** True once this turn's changes have been reverted. */
  reverted?: boolean;
}

type ChatStatus = 'idle' | 'streaming';

/** Running token totals for the active chat session (not persisted). */
export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
}

const EMPTY_USAGE: SessionUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheWriteTokens: 0,
  cacheReadTokens: 0,
};

/** A saved conversation, shown in the chat-history dropdown. */
export interface ChatSession {
  id: string;
  /** Derived from the first user message; shown in the history list. */
  title: string;
  messages: ChatMessage[];
  /** Last activity, used for ordering and the relative-time label. */
  updatedAt: number;
}

interface AiChatState {
  isOpen: boolean;
  /** Live messages for the active chat (mirrors the current session). */
  messages: ChatMessage[];
  /** Id of the active chat session. */
  currentChatId: string;
  /** Saved conversations (including the active one once it has messages). */
  chats: ChatSession[];
  status: ChatStatus;
  error: string | null;
  /** Cumulative token usage for the active session, shown in the panel header. */
  sessionUsage: SessionUsage;
  /** When on, the agent screenshots its work and critiques/fixes it automatically. */
  autoReview: boolean;
  /** Chosen model id, or null to use the server-resolved default. */
  model: string | null;
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

/** A page, collection, or layer the user referenced via @-mention. */
export interface Mention {
  type: 'page' | 'collection' | 'layer';
  id: string;
  label: string;
}

/** Extra context attached to a single message from the composer. */
export interface MessageAttachment {
  selectedLayers?: SelectedLayerRef[];
  images?: ImageAttachment[];
  mentions?: Mention[];
  referenceUrls?: string[];
}

interface AiChatActions {
  open: () => void;
  close: () => void;
  toggle: () => void;
  clear: () => void;
  /** Save the active chat to history and start a fresh, empty conversation. */
  newChat: () => void;
  /** Save the active chat, then load a previous conversation by id. */
  loadChat: (id: string) => void;
  /** Remove a conversation from history (starts fresh if it was active). */
  deleteChat: (id: string) => void;
  stop: () => void;
  setAutoReview: (value: boolean) => void;
  setModel: (model: string | null) => void;
  sendMessage: (text: string, attachment?: MessageAttachment) => Promise<void>;
  revertTurn: (messageId: string) => Promise<void>;
}

type AiChatStore = AiChatState & AiChatActions;

/** Server-sent runtime events, mirrored from lib/agent/runtime.ts RuntimeEvent. */
type RuntimeEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; id: string; name: string; ok: boolean }
  | { type: 'usage'; inputTokens: number; outputTokens: number; cacheWriteTokens: number; cacheReadTokens: number }
  | { type: 'done'; stopReason: string | null }
  | { type: 'error'; message: string };

let abortController: AbortController | null = null;

/**
 * Pre-turn page snapshots, keyed by the user message id, enabling a one-click
 * revert of a turn's layout changes. Kept in memory only (never persisted) to
 * avoid bloating storage and because stale snapshots aren't useful after reload.
 */
const turnCheckpoints = new Map<string, { pageId: string; layers: Layer[] }>();

/**
 * Page ids the agent visually edited during the in-progress turn. Used to point
 * the visual self-review at the page that actually changed (not whatever page is
 * currently open on the canvas). Reset at the start of each top-level turn.
 */
const turnEditedPageIds = new Set<string>();

/** How many automatic review passes to run after a user turn. */
const MAX_REVIEW_DEPTH = 1;

/** Instruction sent alongside the screenshot during an auto-review pass. Names
 * the page explicitly so the agent reviews the page it actually edited and
 * doesn't mistake it for whatever was last open in the canvas. */
function buildReviewPrompt(pageId: string): string {
  const page = usePagesStore.getState().pages.find((p) => p.id === pageId);
  const pageLabel = page?.name ? `the "${page.name}" page (id: ${pageId})` : `the page you edited (id: ${pageId})`;
  return (
    `Here is a screenshot of ${pageLabel} after your changes — this is the page these edits belong to, so review it as that page. ` +
    'Critically review it against my request and good design principles — layout, spacing, alignment, contrast, overflow, readability, and visual hierarchy. ' +
    'If anything looks wrong or low quality, fix it with the tools (using this page id). ' +
    'If it already looks good, just briefly confirm you are done (do not make changes for the sake of it).'
  );
}

const READONLY_TOOL_PREFIXES = ['get_', 'list_', 'export_', 'search_'];

/** Tools that change data/settings but not the current page's visual layout. */
const NON_VISUAL_TOOLS = new Set([
  'publish',
  'update_page_settings',
  'update_page',
  'create_page',
  'update_form_settings',
  'update_form_submission_status',
  'add_redirect',
  'update_redirect',
  'delete_redirect',
  'set_setting',
  'set_translation',
  'set_rich_text_translation',
  'batch_set_translations',
  'create_locale',
]);

/** Whether a tool call likely changed how the current page looks. */
function isVisualMutation(name: string): boolean {
  if (READONLY_TOOL_PREFIXES.some((prefix) => name.startsWith(prefix))) return false;
  if (NON_VISUAL_TOOLS.has(name)) return false;
  return true;
}

/** Capture a specific page's draft layers as a base64 image for the agent to
 * review. The page must have loaded drafts (returns null otherwise). */
async function capturePageImage(pageId: string): Promise<ImageAttachment | null> {
  const layers = usePagesStore.getState().draftsByPageId[pageId]?.layers;
  if (!layers || layers.length === 0) return null;

  try {
    const { captureLayersImage } = await import('@/lib/client/thumbnail-capture');
    const components = useComponentsStore.getState().components;
    const shot = await captureLayersImage(layers, components);
    if (!shot) return null;
    return { mediaType: shot.mediaType, data: shot.data, dataUrl: shot.dataUrl };
  } catch (error) {
    console.error('Visual review capture failed:', error);
    return null;
  }
}

/**
 * Pick which page the auto-review should screenshot — the page the agent
 * actually edited, so the critique never targets the wrong page. Returns null
 * (skip review) when that can't be done safely: the edited page's drafts aren't
 * loaded, or several pages were edited and there's no single clear target.
 *
 * This guards the reported failure where the agent edits page A but the review
 * screenshots the page currently open in the canvas (B) — e.g. the user
 * navigated mid-run, or the edit targeted an @-mentioned page — making the agent
 * "fix" the wrong page.
 */
function resolveReviewPageId(pinnedPageId: string | null): string | null {
  const editedPages = [...turnEditedPageIds];
  const drafts = usePagesStore.getState().draftsByPageId;

  // Prefer the page the user was editing when they sent the message, if the
  // agent actually changed it and its drafts are available to screenshot.
  if (pinnedPageId && editedPages.includes(pinnedPageId) && drafts[pinnedPageId]) {
    return pinnedPageId;
  }
  // Otherwise review only when exactly one page was edited and it's loaded.
  if (editedPages.length === 1 && drafts[editedPages[0]]) {
    return editedPages[0];
  }
  return null;
}

function newId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Keep only durable message fields for localStorage (drops image data, etc.). */
function stripMessageForStorage(message: ChatMessage): ChatMessage {
  return {
    id: message.id,
    role: message.role,
    text: message.text,
    toolCalls: message.toolCalls,
    parts: message.parts,
    review: message.review,
  };
}

const MAX_TITLE_LENGTH = 48;

/** Build a short history title from the first real user message. */
function deriveChatTitle(messages: ChatMessage[]): string {
  const firstUser = messages.find((message) => message.role === 'user' && !message.review);
  const text = firstUser?.text.trim() ?? '';
  if (!text) return 'New chat';
  return text.length > MAX_TITLE_LENGTH ? `${text.slice(0, MAX_TITLE_LENGTH).trimEnd()}…` : text;
}

/**
 * Fold the active chat's live messages back into the saved `chats` list (newest
 * first). An empty active chat is dropped rather than saved, so clicking "new
 * chat" repeatedly never litters the history with blanks.
 */
function commitActiveChat(state: Pick<AiChatState, 'chats' | 'currentChatId' | 'messages'>): ChatSession[] {
  const others = state.chats.filter((chat) => chat.id !== state.currentChatId);
  if (state.messages.length === 0) return others;
  const session: ChatSession = {
    id: state.currentChatId,
    title: deriveChatTitle(state.messages),
    messages: state.messages,
    updatedAt: Date.now(),
  };
  return [session, ...others];
}

export const useAiChatStore = create<AiChatStore>()(
  persist(
    (set, get) => {
      /**
   * Stream a single agent turn into a new assistant message. After a turn that
   * makes visual edits, optionally captures the page and recurses for one
   * automatic self-review pass (bounded by MAX_REVIEW_DEPTH).
   */
      const runTurn = async (
        text: string,
        attachment: MessageAttachment | undefined,
        reviewDepth: number,
        // Page context pinned for the whole turn. Captured once when the user
        // sends the message and threaded through review passes so mid-run
        // navigation can't drift the edit/review target to the wrong page.
        pageId: string | null,
      ): Promise<void> => {
        const trimmed = text.trim();
        const images = attachment?.images ?? [];
        if (!trimmed && images.length === 0) return;

        const isReview = reviewDepth > 0;
        const promptText = trimmed || 'Use the attached image(s) as a reference for what to build.';

        const userMessage: ChatMessage = {
          id: newId(),
          role: 'user',
          text: promptText,
          toolCalls: [],
          images: images.length > 0 ? images.map((img) => ({ id: newId(), dataUrl: img.dataUrl })) : undefined,
          review: isReview || undefined,
        };
        const assistantMessage: ChatMessage = { id: newId(), role: 'assistant', text: '', toolCalls: [], parts: [] };

        // Snapshot the active page before a real (non-review) turn so the user can
        // revert this turn's layout changes in one click.
        if (!isReview && pageId) {
          const snapshot = usePagesStore.getState().draftsByPageId[pageId]?.layers;
          if (snapshot) {
            turnCheckpoints.set(userMessage.id, {
              pageId,
              layers: structuredClone(snapshot),
            });
            userMessage.canRevert = true;
          }
        }

        // History: prior turns as text. Assistant turns that only ran tools still
        // contribute a placeholder so user/assistant roles keep alternating.
        const history = get()
          .messages.map((message) => ({
            role: message.role,
            content:
          message.text.trim() ||
          (message.role === 'assistant' && message.toolCalls.length > 0 ? '(made the requested edits)' : ''),
          }))
          .filter((message) => message.content.length > 0);

        set((state) => ({ messages: [...state.messages, userMessage, assistantMessage], error: null }));

        abortController = new AbortController();
        const signal = abortController.signal;

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
              pageId,
              selectedLayers: attachment?.selectedLayers ?? [],
              mentions: attachment?.mentions ?? [],
              referenceUrls: attachment?.referenceUrls ?? [],
              model: get().model ?? undefined,
            }),
            signal,
          });

          if (!response.ok || !response.body) {
            const message = await safeErrorMessage(response);
            patchAssistant((m) => ({ ...m, text: m.text || message }));
            set({ error: message });
            return;
          }

          await consumeSse(response.body, (event) => applyEvent(event, patchAssistant, set));
        } catch (error) {
          if ((error as Error).name === 'AbortError') return;
          set({ error: error instanceof Error ? error.message : 'Something went wrong' });
          return;
        }

        // Visual self-review: if this turn changed the page, screenshot it and let
        // the agent critique and fix its own work (one pass).
        if (get().autoReview && reviewDepth < MAX_REVIEW_DEPTH && !signal.aborted) {
          const completed = get().messages.find((m) => m.id === assistantMessage.id);
          const changedVisuals = completed?.toolCalls.some((call) => isVisualMutation(call.name)) ?? false;
          // Review the page the agent actually edited, not whatever is open on the
          // canvas — otherwise the agent critiques the wrong page and "fixes" it.
          const reviewPageId = resolveReviewPageId(pageId);
          if (changedVisuals && reviewPageId) {
            const shot = await capturePageImage(reviewPageId);
            if (shot && !signal.aborted) {
              await runTurn(buildReviewPrompt(reviewPageId), { images: [shot] }, reviewDepth + 1, reviewPageId);
            }
          }
        }
      };

      return {
        isOpen: false,
        messages: [],
        currentChatId: newId(),
        chats: [],
        status: 'idle',
        error: null,
        sessionUsage: EMPTY_USAGE,
        autoReview: true,
        model: DEFAULT_AGENT_MODEL,

        open: () => set({ isOpen: true }),
        close: () => set({ isOpen: false }),
        toggle: () => set((state) => ({ isOpen: !state.isOpen })),

        setAutoReview: (value: boolean) => set({ autoReview: value }),
        setModel: (model: string | null) => set({ model }),

        clear: () => {
          get().stop();
          turnCheckpoints.clear();
          set({ messages: [], error: null, sessionUsage: EMPTY_USAGE });
        },

        newChat: () => {
          get().stop();
          turnCheckpoints.clear();
          set((state) => ({
            chats: commitActiveChat(state),
            currentChatId: newId(),
            messages: [],
            error: null,
            sessionUsage: EMPTY_USAGE,
          }));
        },

        loadChat: (id: string) => {
          if (id === get().currentChatId) return;
          get().stop();
          turnCheckpoints.clear();
          set((state) => {
            const chats = commitActiveChat(state);
            const target = chats.find((chat) => chat.id === id);
            if (!target) return { chats };
            return { chats, currentChatId: id, messages: target.messages, error: null, sessionUsage: EMPTY_USAGE };
          });
        },

        deleteChat: (id: string) => {
          set((state) => {
            const chats = state.chats.filter((chat) => chat.id !== id);
            if (id !== state.currentChatId) return { chats };
            get().stop();
            turnCheckpoints.clear();
            return { chats, currentChatId: newId(), messages: [], error: null, sessionUsage: EMPTY_USAGE };
          });
        },

        revertTurn: async (messageId: string) => {
          const checkpoint = turnCheckpoints.get(messageId);
          if (!checkpoint || get().status !== 'idle') return;

          const pages = usePagesStore.getState();
          pages.setDraftLayers(checkpoint.pageId, checkpoint.layers);
          await pages.saveDraft(checkpoint.pageId);

          turnCheckpoints.delete(messageId);
          set((state) => ({
            messages: state.messages.map((message) =>
              message.id === messageId ? { ...message, canRevert: false, reverted: true } : message,
            ),
          }));
        },

        stop: () => {
          abortController?.abort();
          abortController = null;
          clearAiActiveLayerIds();
          set({ status: 'idle' });
        },

        sendMessage: async (text: string, attachment?: MessageAttachment) => {
          const hasContent = text.trim().length > 0 || (attachment?.images?.length ?? 0) > 0;
          if (!hasContent || get().status !== 'idle') return;

          // Pin the page context for the whole turn (including review passes) so
          // mid-run navigation can't drift edits/review to the wrong page.
          const pinnedPageId = useEditorStore.getState().currentPageId ?? null;
          turnEditedPageIds.clear();

          set({ status: 'streaming', error: null });
          try {
            await runTurn(text, attachment, 0, pinnedPageId);
          } finally {
            abortController = null;
            clearAiActiveLayerIds();
            // Fold the just-updated messages into the history list so the chat
            // dropdown shows an up-to-date title and timestamp.
            set((state) => ({ status: 'idle', chats: commitActiveChat(state) }));
          }
        },
      };
    },
    {
      name: 'ycode-ai-chat',
      version: 2,
      // v2 dropped the "Default" picker option in favour of an explicit model.
      // Map the legacy `null` (= "use server default") onto the new default so
      // returning users land on Opus like everyone else; leave any explicit
      // model choice (e.g. Sonnet) untouched.
      migrate: (persisted, fromVersion) => {
        const state = (persisted ?? {}) as Partial<AiChatState>;
        if (fromVersion < 2 && (state.model === null || state.model === undefined)) {
          return { ...state, model: DEFAULT_AGENT_MODEL };
        }
        return state;
      },
      storage: createJSONStorage(() =>
        typeof window !== 'undefined'
          ? window.localStorage
          : { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
      ),
      // After reload, make sure the restored active conversation is represented in
      // the history list (also upgrades the legacy single-conversation format).
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        if (state.messages.length > 0 && !state.chats.some((chat) => chat.id === state.currentChatId)) {
          state.chats = commitActiveChat(state);
        }
      },
      // Persist only the durable, lightweight bits. Image data and per-turn revert
      // checkpoints are intentionally dropped to stay under localStorage quota.
      partialize: (state) => ({
        isOpen: state.isOpen,
        autoReview: state.autoReview,
        model: state.model,
        currentChatId: state.currentChatId,
        messages: state.messages.map(stripMessageForStorage),
        chats: state.chats.map((chat) => ({
          id: chat.id,
          title: chat.title,
          updatedAt: chat.updatedAt,
          messages: chat.messages.map(stripMessageForStorage),
        })),
      }),
    },
  ),
);

/**
 * Append streamed text to the ordered parts list, merging into the trailing
 * text fragment when the last part is text so a contiguous reply stays a single
 * markdown block.
 */
function appendTextPart(parts: ChatMessagePart[] | undefined, text: string): ChatMessagePart[] {
  const next = parts ? [...parts] : [];
  const last = next[next.length - 1];
  if (last && last.type === 'text') {
    next[next.length - 1] = { type: 'text', text: last.text + text };
  } else {
    next.push({ type: 'text', text });
  }
  return next;
}

/**
 * Tool-input keys whose string values reference a layer in the page tree.
 * Used to light up the canvas shimmer overlay on the layers a tool touches.
 */
const LAYER_ID_INPUT_KEYS = new Set(['layer_id', 'parent_layer_id', 'new_parent_id', 'anchor_layer_id']);

/** Recursively collect every layer ID referenced by a tool call's input
 * (handles nested `operations` arrays from `batch_operations`). */
function collectLayerIds(input: unknown): string[] {
  const ids = new Set<string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(walk);
    } else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if (typeof child === 'string' && LAYER_ID_INPUT_KEYS.has(key)) {
          ids.add(child);
        } else {
          walk(child);
        }
      }
    }
  };
  walk(input);
  return [...ids];
}

/** Recursively collect every `page_id` referenced by a tool call's input
 * (handles nested `operations` arrays from `batch_operations`). */
function collectPageIds(input: unknown): string[] {
  const ids = new Set<string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(walk);
    } else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if (typeof child === 'string' && key === 'page_id') {
          ids.add(child);
        } else {
          walk(child);
        }
      }
    }
  };
  walk(input);
  return [...ids];
}

/** Layer IDs per in-flight tool call (cleared as each result arrives). */
const inFlightToolLayerIds = new Map<string, string[]>();

/** Push the union of all in-flight layer IDs to the editor store so the canvas
 * overlay can shimmer the layers the agent is currently working on. */
function syncAiActiveLayerIds(): void {
  const union = new Set<string>();
  for (const ids of inFlightToolLayerIds.values()) {
    for (const id of ids) union.add(id);
  }
  useEditorStore.getState().setAiActiveLayerIds([...union]);
}

/** Clear all AI activity highlights (turn ended or aborted). */
function clearAiActiveLayerIds(): void {
  inFlightToolLayerIds.clear();
  useEditorStore.getState().setAiActiveLayerIds([]);
}

function applyEvent(
  event: RuntimeEvent,
  patchAssistant: (updater: (message: ChatMessage) => ChatMessage) => void,
  set: (partial: Partial<AiChatState> | ((state: AiChatState) => Partial<AiChatState>)) => void,
): void {
  switch (event.type) {
    case 'text':
      patchAssistant((m) => ({
        ...m,
        text: m.text + event.text,
        parts: appendTextPart(m.parts, event.text),
      }));
      break;
    case 'tool_call': {
      const layerIds = collectLayerIds(event.input);
      if (layerIds.length > 0) {
        inFlightToolLayerIds.set(event.id, layerIds);
        syncAiActiveLayerIds();
      }
      // Remember which page(s) the agent edited so the visual self-review targets
      // the right page instead of whatever is currently open on the canvas.
      if (isVisualMutation(event.name)) {
        for (const pageId of collectPageIds(event.input)) turnEditedPageIds.add(pageId);
      }
      patchAssistant((m) => {
        const call: ChatToolCall = { id: event.id, name: event.name };
        return {
          ...m,
          toolCalls: [...m.toolCalls, call],
          parts: [...(m.parts ?? []), { type: 'tool', call }],
        };
      });
      break;
    }
    case 'tool_result':
      if (inFlightToolLayerIds.delete(event.id)) {
        syncAiActiveLayerIds();
      }
      patchAssistant((m) => ({
        ...m,
        toolCalls: m.toolCalls.map((call) => (call.id === event.id ? { ...call, ok: event.ok } : call)),
        parts: (m.parts ?? []).map((part) =>
          part.type === 'tool' && part.call.id === event.id
            ? { type: 'tool', call: { ...part.call, ok: event.ok } }
            : part,
        ),
      }));
      break;
    case 'usage':
      set((state) => ({
        sessionUsage: {
          inputTokens: state.sessionUsage.inputTokens + event.inputTokens,
          outputTokens: state.sessionUsage.outputTokens + event.outputTokens,
          cacheWriteTokens: state.sessionUsage.cacheWriteTokens + event.cacheWriteTokens,
          cacheReadTokens: state.sessionUsage.cacheReadTokens + event.cacheReadTokens,
        },
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

'use client';

import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import { DEFAULT_AGENT_MODEL } from '@/lib/agent/models';
import { syncLayerAssets } from '@/lib/canvas-asset-sync';
import { findAddedLayerIds } from '@/lib/layer-utils';
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

/** A page the agent edited during a turn, with how many of its layers changed. */
export interface TurnChange {
  pageId: string;
  pageName: string;
  layerCount: number;
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
  /** Layer/page/collection references the user attached as inline pills. */
  mentions?: Mention[];
  /** Wall-clock duration of the turn, shown as "Thought for Ns". */
  thinkingMs?: number;
  /** Pages this turn edited, with per-page affected layer counts (Changes card). */
  changes?: TurnChange[];
  /** True for the auto-generated visual self-review turn (rendered compactly). */
  review?: boolean;
  /** True while a turn checkpoint exists and can be restored (not persisted). */
  canRevert?: boolean;
  /** True once this turn's changes have been reverted (Redo re-applies them). */
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
  redoTurn: (messageId: string) => Promise<void>;
}

type AiChatStore = AiChatState & AiChatActions;

/** Server-sent runtime events, mirrored from lib/agent/runtime.ts RuntimeEvent. */
type RuntimeEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; id: string; name: string; ok: boolean }
  | { type: 'usage'; inputTokens: number; outputTokens: number; cacheWriteTokens: number; cacheReadTokens: number }
  | { type: 'page_changed'; pageId: string; layerCount: number; layers: Layer[]; layersBefore?: Layer[] }
  | { type: 'done'; stopReason: string | null }
  | { type: 'error'; message: string };

let abortController: AbortController | null = null;

/**
 * Pre/post-turn page snapshots, keyed by the assistant message id (the one that
 * renders the Changes card), enabling one-click Undo (restore `before`) and Redo
 * (restore `after`) of every page a turn changed. Kept in memory only (never
 * persisted) to avoid bloating storage and because stale snapshots aren't useful
 * after reload.
 */
const turnCheckpoints = new Map<
  string,
  { pages: Array<{ pageId: string; before: Layer[]; after: Layer[] }> }
>();

/**
 * Per-turn pre-edit layer trees, keyed by page id. Seeded with the active page
 * at turn start (fallback) and overridden by the authoritative `layersBefore`
 * the server streams in page_changed. Drained into a `turnCheckpoints` entry
 * after the turn so Undo can restore each changed page. Reset every runTurn.
 */
const turnCheckpointPages = new Map<string, Layer[]>();

/**
 * Per-turn post-edit layer trees, keyed by page id. Captured from the
 * authoritative `layers` the server streams in page_changed, so Redo can
 * re-apply the turn's result after an Undo. Reset every runTurn.
 */
const turnCheckpointPagesAfter = new Map<string, Layer[]>();

/** Apply a set of saved page layer trees to the drafts, loading any page that
 * isn't open client-side first (setDraftLayers/saveDraft no-op without a loaded
 * draft). Shared by Undo (restore `before`) and Redo (restore `after`). */
async function restoreCheckpointPages(pages: Array<{ pageId: string; layers: Layer[] }>): Promise<void> {
  const store = usePagesStore.getState();
  for (const { pageId, layers } of pages) {
    if (!store.draftsByPageId[pageId]) {
      await store.loadDraft(pageId);
    }
    store.setDraftLayers(pageId, layers);
    await store.saveDraft(pageId);
  }
}

/**
 * Page ids the agent visually edited during the in-progress turn. Used to point
 * the visual self-review at the page that actually changed (not whatever page is
 * currently open on the canvas). Reset at the start of each top-level turn.
 */
const turnEditedPageIds = new Set<string>();

/**
 * Per-turn Changes-card entries, keyed by page id. Populated from the
 * authoritative `page_changed` events the server streams at the end of a turn
 * (it diffs its own cache, so the client never races the realtime broadcast).
 * Reset at the start of every runTurn so the main turn and each review pass get
 * a fresh baseline.
 */
const turnChanges = new Map<string, TurnChange>();

/** How many automatic review passes to run after a user turn. */
const MAX_REVIEW_DEPTH = 1;

/**
 * Max prior turns sent with a request, bounding the wire payload. The server
 * re-trims authoritatively against the model's context window (see
 * MAX_HISTORY_MESSAGES in lib/agent/config.ts), so this is a soft client cap;
 * keep it aligned with that server value.
 */
const MAX_HISTORY_MESSAGES = 24;

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
    'If it already looks good, do not make changes for the sake of it. ' +
    'Do not narrate your review, describe the screenshot, or list what looks good or what you checked. ' +
    'Reply with at most one short sentence (e.g. "Tightened the nav spacing." or "Looks good — no changes needed."), nothing more.'
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
    thinkingMs: message.thinkingMs,
    changes: message.changes,
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

        // Fresh per-turn baseline for the Changes card, Undo checkpoint, and
        // "Thought for Ns".
        turnChanges.clear();
        turnCheckpointPages.clear();
        turnCheckpointPagesAfter.clear();
        const startedAt = Date.now();

        const isReview = reviewDepth > 0;
        const promptText = trimmed || 'Use the attached image(s) as a reference for what to build.';

        const userMessage: ChatMessage = {
          id: newId(),
          role: 'user',
          text: promptText,
          toolCalls: [],
          images: images.length > 0 ? images.map((img) => ({ id: newId(), dataUrl: img.dataUrl })) : undefined,
          mentions: attachment?.mentions && attachment.mentions.length > 0 ? attachment.mentions : undefined,
          review: isReview || undefined,
        };
        const assistantMessage: ChatMessage = { id: newId(), role: 'assistant', text: '', toolCalls: [], parts: [] };

        // Fallback Undo baseline: snapshot the active page before the turn in case
        // the server can't supply authoritative before-layers (page_changed
        // overrides this per page). The checkpoint is finalized after the turn,
        // keyed by the assistant message that renders the Changes card.
        if (!isReview && pageId) {
          const snapshot = usePagesStore.getState().draftsByPageId[pageId]?.layers;
          if (snapshot) {
            turnCheckpointPages.set(pageId, structuredClone(snapshot));
          }
        }

        // History: prior turns as text. Assistant turns that only ran tools still
        // contribute a placeholder so user/assistant roles keep alternating.
        // Cap to the most recent turns to bound the wire payload (the server
        // re-trims authoritatively against the model's context window).
        const history = get()
          .messages.map((message) => ({
            role: message.role,
            content:
          message.text.trim() ||
          (message.role === 'assistant' && message.toolCalls.length > 0 ? '(made the requested edits)' : ''),
          }))
          .filter((message) => message.content.length > 0)
          .slice(-MAX_HISTORY_MESSAGES);

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

        // Summarize this turn: how long it ran ("Thought for Ns") and which pages
        // it changed, with a per-page count of affected layers (the Changes card).
        // The server already diffed its authoritative cache and streamed one
        // page_changed event per edited page, so we just read the accumulator.
        const changes = [...turnChanges.values()];

        // Stash the pre/post-turn layers of every changed page (server-
        // authoritative, falling back to the turn-start snapshot for `before`) so
        // the card can offer Undo (restore before) and Redo (restore after).
        const checkpointPages = changes
          .map((change) => ({
            pageId: change.pageId,
            before: turnCheckpointPages.get(change.pageId),
            after: turnCheckpointPagesAfter.get(change.pageId),
          }))
          .filter(
            (entry): entry is { pageId: string; before: Layer[]; after: Layer[] } =>
              !!entry.before && !!entry.after,
          );
        const canRevert = checkpointPages.length > 0;
        if (canRevert) {
          turnCheckpoints.set(assistantMessage.id, { pages: checkpointPages });
        }

        patchAssistant((m) => ({
          ...m,
          thinkingMs: Date.now() - startedAt,
          changes: changes.length > 0 ? changes : undefined,
          canRevert: canRevert || undefined,
        }));

        // Visual self-review: if this turn actually changed layers, screenshot the
        // edited page and let the agent critique and fix its own work (one pass).
        if (get().autoReview && reviewDepth < MAX_REVIEW_DEPTH && !signal.aborted) {
          const changedVisuals = changes.length > 0;
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

          // Restore every changed page to its pre-turn state, then flag the turn
          // as reverted (the checkpoint is kept so Redo can re-apply the result).
          await restoreCheckpointPages(checkpoint.pages.map((p) => ({ pageId: p.pageId, layers: p.before })));
          set((state) => ({
            messages: state.messages.map((message) =>
              message.id === messageId ? { ...message, reverted: true } : message,
            ),
          }));
        },

        redoTurn: async (messageId: string) => {
          const checkpoint = turnCheckpoints.get(messageId);
          if (!checkpoint || get().status !== 'idle') return;

          // Re-apply the turn's result (post-edit state) to every changed page.
          await restoreCheckpointPages(checkpoint.pages.map((p) => ({ pageId: p.pageId, layers: p.after })));
          set((state) => ({
            messages: state.messages.map((message) =>
              message.id === messageId ? { ...message, reverted: false } : message,
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
          turnTouchedLayerIds.clear();

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
 * Tool-input keys whose value references a layer in the page tree (scalar string
 * or an array of strings, e.g. animation `targets`). Used to light up the canvas
 * shimmer overlay on the layers a tool touches.
 */
const LAYER_ID_INPUT_KEYS = new Set([
  'layer_id', 'parent_layer_id', 'new_parent_id', 'anchor_layer_id', 'targets', 'layer_ids',
]);

/** Recursively collect every layer ID referenced by a tool call's input
 * (handles nested `operations` arrays from `batch_operations`, and both scalar
 * and array-valued layer-id keys). */
function collectLayerIds(input: unknown): string[] {
  const ids = new Set<string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(walk);
    } else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if (LAYER_ID_INPUT_KEYS.has(key)) {
          if (typeof child === 'string') {
            ids.add(child);
          } else if (Array.isArray(child)) {
            for (const entry of child) {
              if (typeof entry === 'string') ids.add(entry);
            }
          }
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

/**
 * Every layer the agent has touched during the current turn. Accumulated across
 * all tool calls and kept lit until the turn ends, so the user clearly sees the
 * full scope of what the AI is working on rather than a single layer flashing
 * for one in-flight tool call.
 */
const turnTouchedLayerIds = new Set<string>();

/** Push every layer touched this turn to the editor store so the canvas overlay
 * can shimmer the full set of layers the agent is working on. */
function syncAiActiveLayerIds(): void {
  useEditorStore.getState().setAiActiveLayerIds([...turnTouchedLayerIds]);
}

/** Clear all AI activity highlights (turn ended or aborted). */
function clearAiActiveLayerIds(): void {
  turnTouchedLayerIds.clear();
  const editor = useEditorStore.getState();
  editor.setAiActiveLayerIds([]);
  editor.setAiBuildingPageId(null);
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
        for (const id of layerIds) turnTouchedLayerIds.add(id);
        syncAiActiveLayerIds();
      }
      // Remember which page(s) the agent edited so the visual self-review targets
      // the right page instead of whatever is currently open on the canvas. The
      // authoritative Changes-card counts come later from page_changed events.
      if (isVisualMutation(event.name)) {
        const editedPageIds = collectPageIds(event.input);
        for (const pageId of editedPageIds) {
          turnEditedPageIds.add(pageId);
        }
        // First visual edit of the turn: flag the page being built so the canvas
        // shows an instant skeleton placeholder (until real layers stream in).
        // Prefer the open page when the agent is editing it.
        const editor = useEditorStore.getState();
        if (!editor.aiBuildingPageId) {
          const openPageId = editor.currentPageId;
          const buildingPageId = openPageId && editedPageIds.includes(openPageId)
            ? openPageId
            : editedPageIds[0] ?? openPageId ?? null;
          if (buildingPageId) editor.setAiBuildingPageId(buildingPageId);
        }
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
      // Leave touched layers lit — they stay highlighted for the whole turn so
      // the user sees the full scope of the agent's work, not a brief flash.
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
    case 'page_changed': {
      // Authoritative post-turn snapshot from the server. Force the client draft
      // in sync so the canvas and the review screenshot reflect the edit without
      // waiting on the realtime broadcast. Record the per-page affected layer
      // count for the card.
      const pagesStore = usePagesStore.getState();
      const existingDraft = pagesStore.draftsByPageId[event.pageId];

      if (existingDraft) {
        // Diff against the current draft (before replacing it) so the canvas can
        // step-reveal the layers this turn added. De-duped downstream against ids
        // the realtime broadcast already animated, so the snapshot won't replay.
        const addedIds = findAddedLayerIds(existingDraft.layers ?? [], event.layers);
        pagesStore.setDraftLayers(event.pageId, event.layers);
        if (addedIds.length > 0) {
          useEditorStore.getState().markLayersEntering(addedIds);
        }
      } else {
        // The agent edited a page the user hasn't opened, so there's no draft to
        // update yet. Load it first (the auto-switch effect triggers this too;
        // loadDraft de-dupes), then apply the authoritative layers so the canvas
        // shows the final result once the page is open.
        void (async () => {
          await pagesStore.loadDraft(event.pageId);
          if (usePagesStore.getState().draftsByPageId[event.pageId]) {
            usePagesStore.getState().setDraftLayers(event.pageId, event.layers);
          }
        })();
      }
      // Load any assets these layers reference that aren't cached yet (e.g.
      // images the AI just uploaded) so they show without a manual refresh.
      void syncLayerAssets(event.layers);
      turnEditedPageIds.add(event.pageId);
      if (event.layerCount > 0) {
        const pageName = pagesStore.pages.find((p) => p.id === event.pageId)?.name ?? 'Page';
        turnChanges.set(event.pageId, { pageId: event.pageId, pageName, layerCount: event.layerCount });
      }
      // Authoritative pre-turn tree for Undo (overrides the turn-start fallback)
      // and post-turn tree for Redo.
      if (event.layersBefore) {
        turnCheckpointPages.set(event.pageId, event.layersBefore);
      }
      turnCheckpointPagesAfter.set(event.pageId, event.layers);
      break;
    }
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

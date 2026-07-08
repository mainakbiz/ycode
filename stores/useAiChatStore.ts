'use client';

import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import { DEFAULT_AGENT_MODEL, reviewModelFor } from '@/lib/agent/models';
import { syncLayerAssets } from '@/lib/canvas-asset-sync';
import { findAddedLayerIds } from '@/lib/layer-utils';
import { useComponentsStore } from '@/stores/useComponentsStore';
import { useCollectionsStore } from '@/stores/useCollectionsStore';
import { useEditorStore } from '@/stores/useEditorStore';
import { usePagesStore } from '@/stores/usePagesStore';
import type { Component, ComponentVariant, Layer } from '@/types';

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
  /** Approximate list-price cost in USD; null once any turn had no pricing data. */
  costUsd: number | null;
}

const EMPTY_USAGE: SessionUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheWriteTokens: 0,
  cacheReadTokens: 0,
  costUsd: 0,
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

/** A page, collection, layer, or component the user referenced via @-mention. */
export interface Mention {
  type: 'page' | 'collection' | 'layer' | 'component';
  id: string;
  label: string;
  /** Display-only: the referenced layer is a component instance (has a
   * componentId). Kept a `layer` mention semantically (the id is the layer id),
   * but rendered with the component icon so users can tell it apart. */
  isComponentInstance?: boolean;
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
  | { type: 'usage'; inputTokens: number; outputTokens: number; cacheWriteTokens: number; cacheReadTokens: number; costUsd: number | null }
  | { type: 'page_changed'; pageId: string; layerCount: number; layers: Layer[]; layersBefore?: Layer[]; generatedCss?: string }
  | { type: 'component_changed'; componentId: string; name: string; variants: ComponentVariant[] }
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
 * Skip the self-review pass when a turn touched fewer layers than this. A
 * review turn re-runs the full agent (system prompt + tools + screenshot), so
 * spending it on a one-layer tweak (a text edit, a color change) costs more
 * than it catches. Section builds and layout work clear this easily.
 */
const MIN_CHANGED_LAYERS_FOR_REVIEW = 3;

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
    // Keep the reference metadata so @page/component/layer badges re-render
    // when a chat is reloaded from history (the raw "@label" text alone can't
    // reconstruct the pill's type/icon).
    mentions: message.mentions,
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
        // Component context pinned for the turn: when the user is editing a
        // component, the agent needs to know which component/variant so "this
        // component" resolves and edits go through the component tools.
        componentId: string | null,
        variantId: string | null,
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
              componentId,
              variantId,
              selectedLayers: attachment?.selectedLayers ?? [],
              mentions: attachment?.mentions ?? [],
              referenceUrls: attachment?.referenceUrls ?? [],
              // Review passes run on the cheaper review model of the same
              // provider; the user's pick only applies to the main turn.
              model: isReview ? reviewModelFor(get().model) : get().model ?? undefined,
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

        // Visual self-review: if this turn changed enough layers to warrant a
        // second look, screenshot the edited page and let the agent critique
        // and fix its own work (one pass). Tiny tweaks skip it — the review
        // costs a full extra agent turn.
        if (get().autoReview && reviewDepth < MAX_REVIEW_DEPTH && !signal.aborted) {
          const changedLayerCount = changes.reduce((total, change) => total + change.layerCount, 0);
          const changedVisuals = changedLayerCount >= MIN_CHANGED_LAYERS_FOR_REVIEW;
          // Review the page the agent actually edited, not whatever is open on the
          // canvas — otherwise the agent critiques the wrong page and "fixes" it.
          const reviewPageId = resolveReviewPageId(pageId);
          if (changedVisuals && reviewPageId) {
            const shot = await capturePageImage(reviewPageId);
            if (shot && !signal.aborted) {
              // The self-review screenshots a page, so it runs with page context
              // only — never carry the component context into the review pass.
              await runTurn(buildReviewPrompt(reviewPageId), { images: [shot] }, reviewDepth + 1, reviewPageId, null, null);
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

          // Flip the button label immediately (the checkpoint is kept so Redo can
          // re-apply the result), then restore each changed page to its pre-turn
          // state — the async draft load/save shouldn't delay the UI feedback.
          set((state) => ({
            messages: state.messages.map((message) =>
              message.id === messageId ? { ...message, reverted: true } : message,
            ),
          }));
          await restoreCheckpointPages(checkpoint.pages.map((p) => ({ pageId: p.pageId, layers: p.before })));
        },

        redoTurn: async (messageId: string) => {
          const checkpoint = turnCheckpoints.get(messageId);
          if (!checkpoint || get().status !== 'idle') return;

          // Flip the button label immediately, then re-apply the turn's result
          // (post-edit state) to every changed page.
          set((state) => ({
            messages: state.messages.map((message) =>
              message.id === messageId ? { ...message, reverted: false } : message,
            ),
          }));
          await restoreCheckpointPages(checkpoint.pages.map((p) => ({ pageId: p.pageId, layers: p.after })));
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

          // Pin the page + component context for the whole turn (including review
          // passes) so mid-run navigation can't drift edits/review to the wrong
          // target. When a component is open, the agent is told to edit it.
          const editorState = useEditorStore.getState();
          const pinnedPageId = editorState.currentPageId ?? null;
          const pinnedComponentId = editorState.editingComponentId ?? null;
          const pinnedVariantId = editorState.editingComponentVariantId ?? null;
          turnEditedPageIds.clear();
          turnTouchedLayerIds.clear();
          turnTouchedCollectionIds.clear();
          turnTouchedItemIds.clear();

          set({ status: 'streaming', error: null });
          try {
            await runTurn(text, attachment, 0, pinnedPageId, pinnedComponentId, pinnedVariantId);
          } finally {
            abortController = null;
            // Pull any CMS changes into the store before clearing the shimmer so
            // the user sees the updated collection data once activity settles.
            await refreshTouchedCollections();
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
      version: 3,
      // v2 dropped the "Default" picker option in favour of an explicit model.
      // Map the legacy `null` (= "use server default") onto the current default;
      // leave any explicit model choice untouched.
      // v3 changed the default from Opus to Sonnet. Persisted "claude-opus-4-8"
      // is almost always the old default rather than a deliberate pick (Opus was
      // preselected for everyone), so remap it once; anyone who really wants
      // Opus can re-select it from the dropdown.
      migrate: (persisted, fromVersion) => {
        let state = (persisted ?? {}) as Partial<AiChatState>;
        if (fromVersion < 2 && (state.model === null || state.model === undefined)) {
          state = { ...state, model: DEFAULT_AGENT_MODEL };
        }
        if (fromVersion < 3 && state.model === 'claude-opus-4-8') {
          state = { ...state, model: DEFAULT_AGENT_MODEL };
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

/** Component-definition editing tools. Only these should auto-open component
 * edit mode. Read-only lookups (get_component), page-level instantiation
 * (add_component_instance / replace_layer_with_component), and rich-text
 * component embeds all reference a `component_id` but must NOT switch the canvas
 * into component edit mode. */
const COMPONENT_EDIT_TOOL_NAMES = new Set([
  'update_component_layers',
  'update_component',
  'create_component_variant',
  'update_component_variant',
  'delete_component_variant',
]);

/** Recursively collect every `component_id` referenced by a tool call's input
 * (handles nested `operations` arrays from update_component_layers). */
function collectComponentIds(input: unknown): string[] {
  const ids = new Set<string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(walk);
    } else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if (typeof child === 'string' && key === 'component_id') {
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

/** Mutating CMS tools whose `collection_id` / `item_id` inputs indicate the AI is
 * actively working inside the CMS, so the matching collection (and item rows) can
 * shimmer. Read-only tools (list_/get_) are intentionally excluded. */
const CMS_COLLECTION_TOOL_NAMES = new Set([
  'create_collection',
  'update_collection',
  'delete_collection',
  'add_collection_field',
  'update_collection_field',
  'delete_collection_field',
  'reorder_collection_fields',
  'create_collection_item',
  'update_collection_item',
  'delete_collection_item',
  'set_collection_item_order',
]);

/** Collect `collection_id` / `item_id` values from a CMS tool call's input. */
function collectCmsIds(input: unknown): { collectionIds: string[]; itemIds: string[] } {
  const collectionIds = new Set<string>();
  const itemIds = new Set<string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(walk);
    } else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if (typeof child === 'string' && key === 'collection_id') {
          collectionIds.add(child);
        } else if (typeof child === 'string' && key === 'item_id') {
          itemIds.add(child);
        } else {
          walk(child);
        }
      }
    }
  };
  walk(input);
  return { collectionIds: [...collectionIds], itemIds: [...itemIds] };
}

/**
 * Every layer the agent has touched during the current turn. Accumulated across
 * all tool calls and kept lit until the turn ends, so the user clearly sees the
 * full scope of what the AI is working on rather than a single layer flashing
 * for one in-flight tool call.
 */
const turnTouchedLayerIds = new Set<string>();

/** Collections / items the agent has touched this turn — kept lit in the CMS view
 * until the turn ends, mirroring the canvas layer shimmer. */
const turnTouchedCollectionIds = new Set<string>();
const turnTouchedItemIds = new Set<string>();

/** Push every layer touched this turn to the editor store so the canvas overlay
 * can shimmer the full set of layers the agent is working on. */
function syncAiActiveLayerIds(): void {
  useEditorStore.getState().setAiActiveLayerIds([...turnTouchedLayerIds]);
}

/** Push every collection/item touched this turn to the editor store so the CMS
 * view can shimmer the collections (and item rows) the agent is working on. */
function syncAiActiveCmsIds(): void {
  const editor = useEditorStore.getState();
  editor.setAiActiveCollectionIds([...turnTouchedCollectionIds]);
  editor.setAiActiveItemIds([...turnTouchedItemIds]);
}

/** Reload the CMS data for every collection the agent touched this turn so the
 * changes (new/updated/deleted items, renamed collections) appear without a
 * manual refresh. Best-effort: failures are swallowed so they never block the
 * turn from settling. */
async function refreshTouchedCollections(): Promise<void> {
  if (turnTouchedCollectionIds.size === 0) return;
  const ids = [...turnTouchedCollectionIds];
  const collectionsStore = useCollectionsStore.getState();
  // Refresh the collection list/counts once (covers created/deleted/renamed
  // collections), then reload fields + items for each touched collection.
  try {
    await collectionsStore.loadCollections();
  } catch {
    // Ignore — per-collection reloads below still refresh the visible data.
  }
  await Promise.allSettled(
    ids.map(async (collectionId) => {
      const q = useCollectionsStore.getState().lastItemsQuery[collectionId] || {};
      await useCollectionsStore.getState().loadFields(collectionId);
      await useCollectionsStore.getState().loadItems(collectionId, q.page, q.limit, q.sortBy, q.sortOrder);
    }),
  );
}

/** Clear all AI activity highlights (turn ended or aborted). */
function clearAiActiveLayerIds(): void {
  turnTouchedLayerIds.clear();
  turnTouchedCollectionIds.clear();
  turnTouchedItemIds.clear();
  const editor = useEditorStore.getState();
  editor.setAiActiveLayerIds([]);
  editor.setAiActiveCollectionIds([]);
  editor.setAiActiveItemIds([]);
  editor.setAiBuildingPageId(null);
  editor.setAiBuildingComponentId(null);
  // If the AI opened component edit mode this turn (the user wasn't already
  // editing it), return them to their page now that the turn is done.
  if (editor.aiOpenedComponentEdit) {
    editor.setPendingAiComponentExit(true);
    editor.setAiOpenedComponentEdit(false);
  }
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
      // CMS shimmer: light up the collection (and any item rows) the agent is
      // working on. Only mutating CMS tools count — read-only listing tools and
      // canvas binding tools that also carry collection_id are excluded.
      if (CMS_COLLECTION_TOOL_NAMES.has(event.name)) {
        const { collectionIds, itemIds } = collectCmsIds(event.input);
        if (collectionIds.length > 0 || itemIds.length > 0) {
          for (const id of collectionIds) turnTouchedCollectionIds.add(id);
          for (const id of itemIds) turnTouchedItemIds.add(id);
          syncAiActiveCmsIds();
        }
      }
      // When the agent EDITS a component's definition, flag it so the canvas
      // auto-opens that component's edit mode (mirrors aiBuildingPageId). Only
      // real component-editing tools count — inspecting (get_component) or
      // instantiating a component on a page must not yank the user into edit
      // mode. The first edited component wins for the turn.
      if (COMPONENT_EDIT_TOOL_NAMES.has(event.name)) {
        const componentIds = collectComponentIds(event.input);
        if (componentIds.length > 0) {
          const editor = useEditorStore.getState();
          if (!editor.aiBuildingComponentId) {
            editor.setAiBuildingComponentId(componentIds[0], editor.editingComponentVariantId ?? null);
          }
        }
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
        // Inject the freshly compiled stylesheet so the canvas shows the AI's
        // colors/styles immediately instead of relying on the flaky Tailwind CDN.
        if (event.generatedCss !== undefined) {
          pagesStore.setDraftGeneratedCss(event.pageId, event.generatedCss);
        }
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
            if (event.generatedCss !== undefined) {
              usePagesStore.getState().setDraftGeneratedCss(event.pageId, event.generatedCss);
            }
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
    case 'component_changed': {
      // Authoritative post-turn component snapshot. Rebuild the client drafts so
      // the open component canvas reflects the AI's edit without a reload (the
      // realtime broadcast ignores the acting user's own edits). Merge onto the
      // existing component record so unrelated fields (variables etc.) survive.
      const componentsStore = useComponentsStore.getState();
      const existing = componentsStore.getComponentById(event.componentId);
      const merged: Component = {
        ...(existing as Component),
        id: event.componentId,
        name: event.name,
        variants: event.variants,
        layers: event.variants[0]?.layers ?? existing?.layers ?? [],
      };
      componentsStore.applyServerComponent(merged);
      // Load any assets referenced by the new component layers so they show
      // without a manual refresh.
      for (const variant of event.variants) {
        void syncLayerAssets(variant.layers ?? []);
      }
      break;
    }
    case 'usage':
      set((state) => ({
        sessionUsage: {
          inputTokens: state.sessionUsage.inputTokens + event.inputTokens,
          outputTokens: state.sessionUsage.outputTokens + event.outputTokens,
          cacheWriteTokens: state.sessionUsage.cacheWriteTokens + event.cacheWriteTokens,
          cacheReadTokens: state.sessionUsage.cacheReadTokens + event.cacheReadTokens,
          // Once any turn lacks pricing data, the session total would be
          // misleading — show no estimate instead of a wrong one.
          costUsd:
            state.sessionUsage.costUsd === null || event.costUsd === null
              ? null
              : state.sessionUsage.costUsd + event.costUsd,
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

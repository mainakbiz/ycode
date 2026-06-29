'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import DOMPurify from 'dompurify';
import { marked } from 'marked';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Icon } from '@/components/ui/icon';
import { Spinner } from '@/components/ui/spinner';
import { getLayerName } from '@/lib/layer-display-utils';
import { findLayerById } from '@/lib/layer-utils';
import { cn } from '@/lib/utils';
import { useAiChatStore } from '@/stores/useAiChatStore';
import type { ChatMessage, ChatMessagePart, ChatSession, ChatToolCall, ImageAttachment, Mention, SelectedLayerRef, SessionUsage, TurnChange } from '@/stores/useAiChatStore';
import { useCollectionsStore } from '@/stores/useCollectionsStore';
import { useEditorStore } from '@/stores/useEditorStore';
import { usePagesStore } from '@/stores/usePagesStore';
import type { Layer } from '@/types';

import { toolCallLabel } from './ai-tool-labels';
import ChatComposer from './ChatComposer';

const SUGGESTIONS = [
  'Add a hero section with a headline and a call to action',
  'Create a 3-column features section',
  'Add a contact form at the bottom of this page',
];

const URL_REGEX = /\bhttps?:\/\/[^\s]+/gi;

function parseUrls(text: string): string[] {
  return Array.from(new Set(text.match(URL_REGEX) ?? [])).map((url) => url.replace(/[.,)]+$/, ''));
}

let markdownLinkHookRegistered = false;

/** Render assistant markdown to sanitized HTML (links open in a new tab). */
function renderMarkdown(text: string): string {
  if (!markdownLinkHookRegistered) {
    markdownLinkHookRegistered = true;
    DOMPurify.addHook('afterSanitizeAttributes', (node) => {
      if (node.tagName === 'A') {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
      }
    });
  }
  const html = marked.parse(replaceLayerIdsWithBadges(text), { gfm: true, breaks: true, async: false }) as string;
  return DOMPurify.sanitize(html);
}

/** Flatten a layer tree into mention candidates (skips the root Body layer). */
function flattenLayerMentions(layers: Layer[], acc: Mention[] = []): Mention[] {
  for (const layer of layers) {
    if (layer.id !== 'body') {
      acc.push({ type: 'layer', id: layer.id, label: getLayerName(layer) });
    }
    if (layer.children?.length) flattenLayerMentions(layer.children, acc);
  }
  return acc;
}

/** Resolve a layer id to its display name by searching every loaded page draft. */
function resolveLayerName(id: string): string | null {
  const drafts = usePagesStore.getState().draftsByPageId;
  for (const pageId in drafts) {
    const layer = findLayerById(drafts[pageId].layers, id);
    if (layer) return getLayerName(layer);
  }
  return null;
}

// Match an "lyr-..." id, optionally wrapped in backticks. The model often writes
// ids as inline code (`lyr-...`); we must swallow those backticks so the badge
// HTML isn't injected inside a markdown code span (which marked would escape and
// render as literal text instead of a styled badge).
const LAYER_ID_REGEX = /`?(lyr-[0-9a-z]+)`?/gi;

const LAYER_BADGE_HTML_CLASS =
  'inline-flex items-center align-middle rounded-md bg-secondary px-1 text-[0.92em] font-normal text-secondary-foreground/80';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Swap raw "lyr-..." ids in assistant text for a name badge (falls back to the
 * generic label when the layer can't be resolved in a loaded draft). */
function replaceLayerIdsWithBadges(text: string): string {
  if (!text.includes('lyr-')) return text;
  return text.replace(LAYER_ID_REGEX, (_match, id: string) => {
    const name = resolveLayerName(id) ?? 'layer';
    return `<span class="${LAYER_BADGE_HTML_CLASS}">${escapeHtml(name)}</span>`;
  });
}

const MENTION_ICON: Record<Mention['type'], 'page' | 'database' | 'layers'> = {
  page: 'page',
  collection: 'database',
  layer: 'layers',
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Inline reference badge shown inside a sent user message (read-only). */
function MentionBadge({ type, label }: { type: Mention['type']; label: string }) {
  return (
    <Badge
      variant="secondary"
      className="h-[1.125rem] gap-1 rounded-md px-1 align-middle text-[12px] font-normal [&>svg]:size-2.5"
    >
      <Icon name={MENTION_ICON[type] ?? 'layers'} className="shrink-0" />
      <span className="max-w-[140px] truncate">{label}</span>
    </Badge>
  );
}

/** Render a sent message, swapping each "@label" token for its reference badge. */
function MessageTextWithMentions({ text, mentions }: { text: string; mentions?: Mention[] }) {
  if (!mentions || mentions.length === 0) return <>{text}</>;

  const byLabel = new Map(mentions.map((mention) => [mention.label, mention]));
  // Longest-first so "@Hero Section" wins over a shorter "@Hero" prefix.
  const labels = [...new Set(mentions.map((mention) => mention.label))]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp);
  if (labels.length === 0) return <>{text}</>;

  const regex = new RegExp(`@(${labels.join('|')})`, 'g');
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    const mention = byLabel.get(match[1]);
    nodes.push(
      <MentionBadge
        key={key++} type={mention?.type ?? 'layer'}
        label={match[1]}
      />,
    );
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return <>{nodes}</>;
}

interface AiChatPanelProps {
  embedded?: boolean;
}

export default function AiChatPanel({ embedded = false }: AiChatPanelProps) {
  const messages = useAiChatStore((s) => s.messages);
  const status = useAiChatStore((s) => s.status);
  const error = useAiChatStore((s) => s.error);
  const autoReview = useAiChatStore((s) => s.autoReview);
  const model = useAiChatStore((s) => s.model);
  const sendMessage = useAiChatStore((s) => s.sendMessage);
  const setAutoReview = useAiChatStore((s) => s.setAutoReview);
  const setModel = useAiChatStore((s) => s.setModel);
  const revertTurn = useAiChatStore((s) => s.revertTurn);
  const redoTurn = useAiChatStore((s) => s.redoTurn);
  const stop = useAiChatStore((s) => s.stop);
  const close = useAiChatStore((s) => s.close);
  const sessionUsage = useAiChatStore((s) => s.sessionUsage);
  const chats = useAiChatStore((s) => s.chats);
  const currentChatId = useAiChatStore((s) => s.currentChatId);
  const newChat = useAiChatStore((s) => s.newChat);
  const loadChat = useAiChatStore((s) => s.loadChat);
  const deleteChat = useAiChatStore((s) => s.deleteChat);

  const selectedLayerIds = useEditorStore((s) => s.selectedLayerIds);
  const currentPageId = useEditorStore((s) => s.currentPageId);
  const draftLayers = usePagesStore((s) =>
    currentPageId ? s.draftsByPageId[currentPageId]?.layers : undefined,
  );
  const pages = usePagesStore((s) => s.pages);
  const collections = useCollectionsStore((s) => s.collections);

  const scrollRef = useRef<HTMLDivElement>(null);

  const isStreaming = status === 'streaming';

  const mentionCandidates = useMemo<Mention[]>(() => {
    const fromPages: Mention[] = pages.map((page) => ({ type: 'page', id: page.id, label: page.name }));
    const fromCollections: Mention[] = collections.map((collection) => ({
      type: 'collection',
      id: collection.id,
      label: collection.name,
    }));
    const fromLayers: Mention[] = draftLayers ? flattenLayerMentions(draftLayers) : [];
    return [...fromPages, ...fromCollections, ...fromLayers];
  }, [pages, collections, draftLayers]);

  const layerMentions = useMemo<Mention[]>(
    () => (draftLayers ? flattenLayerMentions(draftLayers) : []),
    [draftLayers],
  );

  // The canvas selection is sent to the agent as background context only — it is
  // not shown as a pill. Explicit pills come from the composer's @ menu / picker.
  const selectedRefs = useMemo<SelectedLayerRef[]>(() => {
    if (!selectedLayerIds.length || !draftLayers) return [];
    return selectedLayerIds
      .map((id) => {
        const layer = findLayerById(draftLayers, id);
        return layer ? { id, name: getLayerName(layer) } : null;
      })
      .filter((ref): ref is SelectedLayerRef => ref !== null);
  }, [selectedLayerIds, draftLayers]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, status]);

  const submit = (text: string, mentions: Mention[] = [], images: ImageAttachment[] = []) => {
    if ((!text.trim() && images.length === 0) || isStreaming) return;
    void sendMessage(text, {
      selectedLayers: selectedRefs,
      images,
      mentions,
      referenceUrls: parseUrls(text),
    });
  };

  return (
    <div
      className={cn(
        'flex flex-col overflow-hidden',
        embedded
          ? 'flex-1 min-h-0'
          : 'w-80 shrink-0 bg-background border-l h-full',
      )}
    >
      {embedded ? (
        <div className="flex items-center justify-between gap-2 px-4 pt-3 shrink-0">
          <ChatHistoryMenu
            chats={chats}
            currentChatId={currentChatId}
            onSelect={loadChat}
            onDelete={deleteChat}
          />
          <div className="flex items-center gap-1 shrink-0">
            <SessionUsageBadge usage={sessionUsage} />
            <Button
              size="sm"
              variant="ghost"
              className="size-7 p-0"
              onClick={newChat}
              aria-label="New chat"
              title="New chat"
            >
              <Icon name="plus" className="size-3.5" />
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-2 px-4 h-12 shrink-0 border-b">
          <ChatHistoryMenu
            chats={chats}
            currentChatId={currentChatId}
            onSelect={loadChat}
            onDelete={deleteChat}
          />
          <div className="flex items-center gap-1 shrink-0">
            <SessionUsageBadge usage={sessionUsage} />
            <Button
              size="sm"
              variant="ghost"
              className="size-7 p-0"
              onClick={newChat}
              aria-label="New chat"
              title="New chat"
            >
              <Icon name="plus" className="size-3.5" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="size-7 p-0"
              onClick={close}
              aria-label="Close AI panel"
              title="Close"
            >
              <Icon name="x" className="size-3.5" />
            </Button>
          </div>
        </div>
      )}

      <div ref={scrollRef} className="flex-1 overflow-y-auto no-scrollbar px-4 py-4 flex flex-col gap-4">
        {messages.length === 0 ? (
          <EmptyState onPick={submit} disabled={isStreaming} />
        ) : (
          messages.map((message) => (
            <MessageBubble
              key={message.id} message={message}
              isStreaming={isStreaming}
              onRevert={revertTurn}
              onRedo={redoTurn}
            />
          ))
        )}

        {error && (
          <div className="text-xs text-destructive bg-destructive/10 rounded-lg px-3 py-2">
            {error}
          </div>
        )}
      </div>

      <div className="border-t p-3 shrink-0">
        <ChatComposer
          model={model}
          onModelChange={setModel}
          isStreaming={isStreaming}
          onStop={stop}
          onSubmit={submit}
          mentionCandidates={mentionCandidates}
          layerMentions={layerMentions}
        />
      </div>
    </div>
  );
}

function MarkdownText({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return (
    <div
      className="text-xs leading-relaxed break-words [&_p]:my-1.5 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_ul]:my-1.5 [&_ul]:ml-4 [&_ul]:list-disc [&_ol]:my-1.5 [&_ol]:ml-4 [&_ol]:list-decimal [&_li]:my-0.5 [&_h1]:mt-2 [&_h1]:mb-1 [&_h1]:text-sm [&_h1]:font-semibold [&_h2]:mt-2 [&_h2]:mb-1 [&_h2]:text-xs [&_h2]:font-semibold [&_h3]:font-semibold [&_a]:underline [&_a]:underline-offset-2 [&_strong]:font-semibold [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[11px] [&_pre]:my-1.5 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-2 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_blockquote]:border-l-2 [&_blockquote]:pl-2 [&_blockquote]:text-muted-foreground"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/** Compact token count, e.g. 950 → "950", 12_300 → "12.3k", 2_100_000 → "2.1M". */
function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) {
    const k = count / 1000;
    return `${k < 10 ? k.toFixed(1) : Math.round(k)}k`;
  }
  const m = count / 1_000_000;
  return `${m < 10 ? m.toFixed(1) : Math.round(m)}M`;
}

/** Running token total for the active session, with a per-category tooltip. */
function SessionUsageBadge({ usage }: { usage: SessionUsage }) {
  const total =
    usage.inputTokens + usage.outputTokens + usage.cacheWriteTokens + usage.cacheReadTokens;
  if (total === 0) return null;

  const tooltip = [
    'Session tokens',
    `Input: ${usage.inputTokens.toLocaleString()}`,
    `Output: ${usage.outputTokens.toLocaleString()}`,
    `Cache write: ${usage.cacheWriteTokens.toLocaleString()}`,
    `Cache read: ${usage.cacheReadTokens.toLocaleString()}`,
  ].join('\n');

  return (
    <span
      title={tooltip}
      className="flex items-center gap-1 px-1.5 text-[11px] tabular-nums text-muted-foreground"
    >
      <Icon name="sparkles" className="size-3" />
      {formatTokens(total)}
    </span>
  );
}

/** Compact relative timestamp for the history list, e.g. "6h", "7d", "now". */
function compactTime(timestamp: number): string {
  const diffSecs = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (diffSecs < 60) return 'now';
  const mins = Math.floor(diffSecs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (days < 30) return `${weeks}w`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.floor(days / 365)}y`;
}

function ChatHistoryMenu({
  chats,
  currentChatId,
  onSelect,
  onDelete,
}: {
  chats: ChatSession[];
  currentChatId: string;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const currentTitle = chats.find((chat) => chat.id === currentChatId)?.title ?? 'New chat';

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="sm"
          variant="secondary"
          className="h-8 min-w-0 flex-1 justify-between gap-2 px-2.5 text-xs font-medium"
        >
          <span className="truncate">{currentTitle}</span>
          <Icon name="chevronDown" className="size-3 shrink-0 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[var(--radix-dropdown-menu-trigger-width)] min-w-56">
        {chats.length === 0 ? (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">No previous chats</div>
        ) : (
          chats.map((chat) => (
            <DropdownMenuItem
              key={chat.id}
              onSelect={() => onSelect(chat.id)}
              className={cn('group gap-2 pr-1.5', chat.id === currentChatId && 'bg-accent')}
            >
              <span className="flex-1 truncate text-xs">{chat.title}</span>
              <span className="shrink-0 text-[11px] text-muted-foreground group-hover:hidden">
                {compactTime(chat.updatedAt)}
              </span>
              <button
                type="button"
                aria-label="Delete chat"
                title="Delete chat"
                className="hidden size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground group-hover:flex"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onDelete(chat.id);
                }}
              >
                <Icon name="trash" className="size-3" />
              </button>
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function EmptyState({ onPick, disabled }: { onPick: (text: string) => void; disabled: boolean }) {
  return (
    <div className="flex flex-col gap-3 mt-2">
      <p className="text-xs text-muted-foreground">
        Describe what you want to build. The AI can create sections, edit elements, manage content, and more.
      </p>
      <div className="flex flex-col gap-2">
        {SUGGESTIONS.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            disabled={disabled}
            onClick={() => onPick(suggestion)}
            className="text-left text-xs rounded-lg border bg-muted/40 hover:bg-muted px-3 py-2 transition-colors disabled:opacity-50"
          >
            {suggestion}
          </button>
        ))}
      </div>
    </div>
  );
}

function MessageBubble({
  message,
  isStreaming,
  onRevert,
  onRedo,
}: {
  message: ChatMessage;
  isStreaming: boolean;
  onRevert: (messageId: string) => void;
  onRedo: (messageId: string) => void;
}) {
  if (message.role === 'user' && message.review) {
    return (
      <div className="self-stretch flex items-center gap-2 text-[11px] text-muted-foreground">
        <Icon name="eye" className="size-3 shrink-0" />
        <span>Reviewing the result…</span>
        {message.images?.[0] && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={message.images[0].dataUrl}
            alt="Review screenshot"
            className="ml-auto size-8 rounded object-cover border"
          />
        )}
      </div>
    );
  }

  if (message.role === 'user') {
    return (
      <div className="self-end max-w-[100%] flex flex-col items-end gap-1.5">
        {message.images && message.images.length > 0 && (
          <div className="flex flex-wrap justify-end gap-1.5">
            {message.images.map((image) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={image.id}
                src={image.dataUrl}
                alt="Attachment"
                className="size-20 rounded-lg object-cover border"
              />
            ))}
          </div>
        )}
        {message.text && (
          <div className="rounded-xl rounded-br-sm bg-secondary border border-border text-current px-3 py-2 text-xs whitespace-pre-wrap break-words">
            <MessageTextWithMentions text={message.text} mentions={message.mentions} />
          </div>
        )}
      </div>
    );
  }

  // Fall back to text/toolCalls for legacy messages that predate `parts`.
  const parts: ChatMessagePart[] =
    message.parts && message.parts.length > 0
      ? message.parts
      : [
        ...message.toolCalls.map((call) => ({ type: 'tool' as const, call })),
        ...(message.text ? [{ type: 'text' as const, text: message.text }] : []),
      ];

  // Once a turn runs tools, the whole transcript (narration, tool steps, and the
  // model's full closing text) collapses under "Thought for Ns". Only a compact
  // Changes card + a one-line summary stay visible so finished replies are short.
  // Turns with no tools (e.g. a clarifying question) render as plain text.
  const hasToolParts = parts.some((part) => part.type === 'tool');
  const lastPart = parts[parts.length - 1];
  const closingText = hasToolParts && lastPart?.type === 'text' ? lastPart.text.trim() : '';
  const shortSummary = clipSummary(closingText);
  const plainText = hasToolParts ? '' : message.text.trim();

  // Global status is shared across bubbles; only the unfinished (no thinkingMs)
  // turn is the one actually streaming right now.
  const isActivelyStreaming = isStreaming && message.thinkingMs === undefined;

  return (
    <div className="flex flex-col gap-2">
      {(hasToolParts || isActivelyStreaming) && (
        <ThoughtDisclosure
          parts={parts} thinkingMs={message.thinkingMs}
          streaming={isActivelyStreaming}
        />
      )}

      {!isActivelyStreaming && message.changes && message.changes.length > 0 && (
        <ChangesCard
          changes={message.changes}
          canRevert={message.canRevert}
          reverted={message.reverted}
          disabled={isStreaming}
          onUndo={() => onRevert(message.id)}
          onRedo={() => onRedo(message.id)}
        />
      )}

      {!isActivelyStreaming && shortSummary && <MarkdownText text={shortSummary} />}

      {!isActivelyStreaming && plainText && <MarkdownText text={plainText} />}
    </div>
  );
}

function ToolCallRow({ call }: { call: ChatToolCall }) {
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      {call.ok === undefined ? (
        <Spinner className="size-3" />
      ) : (
        <Icon
          name={call.ok ? 'check' : 'x'}
          className={cn('size-3', call.ok ? 'text-foreground' : 'text-destructive')}
        />
      )}
      <span>{toolCallLabel(call.name)}</span>
    </div>
  );
}

type PartGroup =
  | { type: 'tools'; calls: ChatToolCall[] }
  | { type: 'text'; text: string };

/** Collapse an ordered parts list into render groups, merging consecutive tool
 * calls into a single tight checklist. */
function groupParts(parts: ChatMessagePart[]): PartGroup[] {
  const groups: PartGroup[] = [];
  for (const part of parts) {
    if (part.type === 'tool') {
      const last = groups[groups.length - 1];
      if (last && last.type === 'tools') {
        last.calls.push(part.call);
      } else {
        groups.push({ type: 'tools', calls: [part.call] });
      }
    } else if (part.text) {
      groups.push({ type: 'text', text: part.text });
    }
  }
  return groups;
}

/** The intermediate narration + tool steps, shown inside the collapsed trail.
 * Narration text is dimmed so the closing summary below stays the focus. */
function ThinkingTrail({ parts }: { parts: ChatMessagePart[] }) {
  const groups = groupParts(parts);
  if (groups.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5">
      {groups.map((group, index) =>
        group.type === 'tools' ? (
          <div key={index} className="flex flex-col gap-1">
            {group.calls.map((call) => (
              <ToolCallRow key={call.id} call={call} />
            ))}
          </div>
        ) : (
          <div key={index} className="opacity-60">
            <MarkdownText text={group.text} />
          </div>
        ),
      )}
    </div>
  );
}

/** Condense a verbose closing message into a one-line takeaway: first paragraph,
 * at most two sentences, capped in length (the full text lives under "Thought").
 * Headings/bullets the model sometimes emits ("Looks great:") are dropped. */
function clipSummary(text: string): string {
  const firstParagraph = text
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .find((block) => block && !/^[#*-]/.test(block) && !/:$/.test(block));
  if (!firstParagraph) return '';

  const normalized = firstParagraph.replace(/\s+/g, ' ').trim();
  const sentences = normalized.match(/[^.!?]+[.!?]+(?:\s|$)/g);
  let summary = sentences && sentences.length > 2 ? sentences.slice(0, 2).join('').trim() : normalized;

  const MAX = 240;
  if (summary.length > MAX) {
    const clipped = summary.slice(0, MAX);
    const stop = Math.max(clipped.lastIndexOf('. '), clipped.lastIndexOf('! '), clipped.lastIndexOf('? '));
    summary = `${stop > 80 ? clipped.slice(0, stop + 1) : clipped.trimEnd()}…`;
  }
  return summary;
}

/** Human-readable turn duration: "8s", "1m 5s". */
function formatDuration(ms?: number): string {
  if (!ms || ms < 1000) return '1s';
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

/**
 * Collapsible "Thought for Ns" header wrapping a turn's narration and tool
 * steps. While streaming it stays expanded with a live spinner; once done it
 * collapses by default so only the summary + Changes card remain visible.
 */
function ThoughtDisclosure({
  parts,
  thinkingMs,
  streaming,
}: {
  parts: ChatMessagePart[];
  thinkingMs?: number;
  streaming: boolean;
}) {
  const [open, setOpen] = useState(false);
  const expanded = streaming || open;
  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        onClick={() => {
          if (!streaming) setOpen((value) => !value);
        }}
        disabled={streaming}
        className="flex w-fit items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:cursor-default"
      >
        {streaming ? (
          <Spinner className="size-3" />
        ) : (
          <Icon name="chevronRight" className={cn('size-3 transition-transform', open && 'rotate-90')} />
        )}
        <span>{streaming ? 'Working…' : `Thought for ${formatDuration(thinkingMs)}`}</span>
      </button>
      {expanded && (
        <div className="ml-1 border-l border-border pl-2.5">
          <ThinkingTrail parts={parts} />
        </div>
      )}
    </div>
  );
}

/** Post-turn summary of which pages changed and how many of their layers were
 * affected, matching the canvas "Changes" card. Offers a one-click Undo that
 * restores every listed page to its pre-turn state. */
function ChangesCard({
  changes,
  canRevert,
  reverted,
  disabled,
  onUndo,
  onRedo,
}: {
  changes: TurnChange[];
  canRevert?: boolean;
  reverted?: boolean;
  disabled?: boolean;
  onUndo?: () => void;
  onRedo?: () => void;
}) {
  const pages = usePagesStore((s) => s.pages);
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <div className="flex items-center justify-between gap-2 px-3 py-1.5">
        <span className="text-[11px] font-medium text-muted-foreground">Changes</span>
        {canRevert ? (
          <Button
            variant="ghost"
            size="sm"
            className="-mr-1.5 h-6 gap-1 px-1.5 text-[11px] text-muted-foreground"
            onClick={reverted ? onRedo : onUndo}
            disabled={disabled}
          >
            <Icon name={reverted ? 'redo' : 'undo'} className="size-3" />
            {reverted ? 'Redo' : 'Undo'}
          </Button>
        ) : null}
      </div>
      <div className="flex flex-col">
        {changes.map((change) => {
          const page = pages.find((p) => p.id === change.pageId);
          const isHome = page ? page.is_index && page.page_folder_id === null : false;
          return (
            <div
              key={change.pageId}
              className="flex items-center gap-2 border-t border-border px-3 py-2 text-xs"
            >
              <Icon name={isHome ? 'homepage' : 'page'} className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="flex-1 truncate">{change.pageName}</span>
              <span className="shrink-0 text-muted-foreground">
                {change.layerCount} {change.layerCount === 1 ? 'Layer' : 'Layers'}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

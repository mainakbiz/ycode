'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

import DOMPurify from 'dompurify';
import { marked } from 'marked';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Icon } from '@/components/ui/icon';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { AGENT_MODELS, DEFAULT_AGENT_MODEL } from '@/lib/agent/models';
import { getLayerName } from '@/lib/layer-display-utils';
import { findLayerById } from '@/lib/layer-utils';
import { cn } from '@/lib/utils';
import { useAiChatStore } from '@/stores/useAiChatStore';
import type { ChatMessage, ChatMessagePart, ChatSession, ChatToolCall, ImageAttachment, Mention, SelectedLayerRef, SessionUsage } from '@/stores/useAiChatStore';
import { useCollectionsStore } from '@/stores/useCollectionsStore';
import { useEditorStore } from '@/stores/useEditorStore';
import { usePagesStore } from '@/stores/usePagesStore';
import type { Layer } from '@/types';

import { toolCallLabel } from './ai-tool-labels';

const SUGGESTIONS = [
  'Add a hero section with a headline and a call to action',
  'Create a 3-column features section',
  'Add a contact form at the bottom of this page',
];

const MAX_IMAGES = 4;
const ACCEPTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const MAX_MENTION_RESULTS = 8;
const URL_REGEX = /\bhttps?:\/\/[^\s]+/gi;

const MENTION_ICON: Record<Mention['type'], 'page' | 'database' | 'layers'> = {
  page: 'page',
  collection: 'database',
  layer: 'layers',
};

/** The active "@query" token under the caret, if any. */
function getActiveMention(text: string, caret: number): { query: string; start: number } | null {
  const upto = text.slice(0, caret);
  const at = upto.lastIndexOf('@');
  if (at === -1) return null;
  const charBefore = at === 0 ? ' ' : upto[at - 1];
  if (!/\s/.test(charBefore)) return null;
  const query = upto.slice(at + 1);
  if (/\s/.test(query)) return null;
  return { query, start: at };
}

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
  const html = marked.parse(text, { gfm: true, breaks: true, async: false }) as string;
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

/** Read an image File into a base64 attachment, or null if it's unsupported. */
function fileToImageAttachment(file: File): Promise<ImageAttachment | null> {
  return new Promise((resolve) => {
    if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) {
      resolve(null);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : '';
      const comma = dataUrl.indexOf(',');
      if (comma === -1) {
        resolve(null);
        return;
      }
      resolve({ mediaType: file.type, data: dataUrl.slice(comma + 1), dataUrl });
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
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

  const [input, setInput] = useState('');
  const [contextDetached, setContextDetached] = useState(false);
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [mentions, setMentions] = useState<Mention[]>([]);
  const [mentionState, setMentionState] = useState<{ query: string; start: number } | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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

  const mentionResults = useMemo<Mention[]>(() => {
    if (mentionState === null) return [];
    const query = mentionState.query.toLowerCase();
    return mentionCandidates
      .filter((candidate) => candidate.label.toLowerCase().includes(query))
      .slice(0, MAX_MENTION_RESULTS);
  }, [mentionState, mentionCandidates]);

  const selectedRefs = useMemo<SelectedLayerRef[]>(() => {
    if (!selectedLayerIds.length || !draftLayers) return [];
    return selectedLayerIds
      .map((id) => {
        const layer = findLayerById(draftLayers, id);
        return layer ? { id, name: getLayerName(layer) } : null;
      })
      .filter((ref): ref is SelectedLayerRef => ref !== null);
  }, [selectedLayerIds, draftLayers]);

  // A fresh selection re-attaches context that the user previously dismissed.
  useEffect(() => {
    setContextDetached(false);
  }, [selectedLayerIds]);

  const attachedRefs = contextDetached ? [] : selectedRefs;

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, status]);

  const addImageFiles = async (files: FileList | File[]) => {
    const slots = MAX_IMAGES - images.length;
    if (slots <= 0) return;
    const converted = (await Promise.all(Array.from(files).slice(0, slots).map(fileToImageAttachment)))
      .filter((img): img is ImageAttachment => img !== null);
    if (converted.length > 0) {
      setImages((prev) => [...prev, ...converted].slice(0, MAX_IMAGES));
    }
  };

  const closeMention = () => setMentionState(null);

  const handleInputChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = event.target.value;
    setInput(value);
    const active = getActiveMention(value, event.target.selectionStart ?? value.length);
    setMentionState(active);
    setMentionIndex(0);
  };

  const insertMention = (candidate: Mention) => {
    if (mentionState === null) return;
    const caret = textareaRef.current?.selectionStart ?? input.length;
    const before = input.slice(0, mentionState.start);
    const after = input.slice(caret);
    const token = `@${candidate.label} `;
    const nextText = before + token + after;
    setInput(nextText);
    setMentions((prev) =>
      prev.some((m) => m.type === candidate.type && m.id === candidate.id) ? prev : [...prev, candidate],
    );
    closeMention();
    requestAnimationFrame(() => {
      const pos = (before + token).length;
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(pos, pos);
    });
  };

  const submit = (text: string) => {
    if ((!text.trim() && images.length === 0) || isStreaming) return;
    setInput('');
    const usedMentions = mentions.filter((mention) => text.includes(`@${mention.label}`));
    const attachment = {
      selectedLayers: attachedRefs,
      images,
      mentions: usedMentions,
      referenceUrls: parseUrls(text),
    };
    setImages([]);
    setMentions([]);
    closeMention();
    void sendMessage(text, attachment);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionState !== null && mentionResults.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setMentionIndex((index) => (index + 1) % mentionResults.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setMentionIndex((index) => (index - 1 + mentionResults.length) % mentionResults.length);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        insertMention(mentionResults[Math.min(mentionIndex, mentionResults.length - 1)]);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        closeMention();
        return;
      }
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit(input);
    }
  };

  const handlePaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const imageFiles = Array.from(event.clipboardData.files).filter((file) =>
      file.type.startsWith('image/'),
    );
    if (imageFiles.length > 0) {
      event.preventDefault();
      void addImageFiles(imageFiles);
    }
  };

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (event.target.files) void addImageFiles(event.target.files);
    event.target.value = '';
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
        {attachedRefs.length > 0 && (
          <div className="flex flex-wrap items-center gap-1 mb-2">
            {attachedRefs.map((ref) => (
              <span
                key={ref.id}
                className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground max-w-[160px]"
              >
                <Icon name="layers" className="size-3 shrink-0" />
                <span className="truncate">{ref.name}</span>
              </span>
            ))}
            <Button
              size="sm"
              variant="ghost"
              className="size-5 p-0 text-muted-foreground"
              onClick={() => setContextDetached(true)}
              aria-label="Remove selection context"
              title="Remove selection context"
            >
              <Icon name="x" className="size-3" />
            </Button>
          </div>
        )}
        {images.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2">
            {images.map((image, index) => (
              <div key={image.dataUrl} className="relative size-12 rounded-md overflow-hidden border group">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={image.dataUrl} alt="Attachment"
                  className="size-full object-cover"
                />
                <button
                  type="button"
                  onClick={() => setImages((prev) => prev.filter((_, i) => i !== index))}
                  className="absolute top-0 right-0 bg-background/80 rounded-bl p-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                  aria-label="Remove image"
                >
                  <Icon name="x" className="size-3" />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="relative">
          {mentionState !== null && mentionResults.length > 0 && (
            <MentionMenu
              results={mentionResults}
              activeIndex={Math.min(mentionIndex, mentionResults.length - 1)}
              onPick={insertMention}
            />
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPTED_IMAGE_TYPES.join(',')}
            multiple
            className="hidden"
            onChange={handleFileChange}
          />
          <div className="flex flex-col rounded-lg border border-transparent bg-input transition-colors focus-within:border-ring">
            <Textarea
              ref={textareaRef}
              value={input}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              onBlur={closeMention}
              placeholder="Ask AI to build, edit, or @mention a page, collection, or layer..."
              rows={3}
              className="min-h-[84px] resize-none border-0 bg-transparent px-3 pt-2.5 pb-1 focus-visible:border-transparent focus-visible:ring-0"
            />
            <div className="flex items-center justify-between gap-1 px-2 pb-2">
              <div className="flex items-center gap-0.5">
                <Button
                  size="sm"
                  variant="ghost"
                  className="size-7 p-0 text-muted-foreground"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={images.length >= MAX_IMAGES}
                  aria-label="Attach image"
                  title={images.length >= MAX_IMAGES ? `Up to ${MAX_IMAGES} images` : 'Attach image'}
                >
                  <Icon name="image" className="size-3.5" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className={cn('size-7 p-0', autoReview ? 'text-foreground' : 'text-muted-foreground')}
                  onClick={() => setAutoReview(!autoReview)}
                  aria-pressed={autoReview}
                  aria-label="Auto visual review"
                  title={autoReview ? 'Auto visual review: on' : 'Auto visual review: off'}
                >
                  <Icon name="eye" className="size-3.5" />
                </Button>
                <ModelPicker model={model} onChange={setModel} />
              </div>
              {isStreaming ? (
                <Button
                  size="sm" variant="secondary"
                  className="size-7 p-0" onClick={stop}
                  aria-label="Stop"
                >
                  <Icon name="stop" className="size-3" />
                </Button>
              ) : (
                <Button
                  size="sm"
                  className="size-7 p-0"
                  onClick={() => submit(input)}
                  disabled={!input.trim() && images.length === 0}
                  aria-label="Send"
                >
                  <Icon name="arrowLeft" className="size-3.5 rotate-90" />
                </Button>
              )}
            </div>
          </div>
        </div>
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

function ModelPicker({
  model,
  onChange,
}: {
  model: string | null;
  onChange: (model: string | null) => void;
}) {
  const current = AGENT_MODELS.find((option) => option.id === model);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 gap-1 px-1.5 text-[11px] text-muted-foreground"
        >
          {current?.label ?? 'Select model'}
          <Icon name="chevronDown" className="size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuRadioGroup
          value={model ?? DEFAULT_AGENT_MODEL}
          onValueChange={(value) => onChange(value)}
        >
          {AGENT_MODELS.map((option) => (
            <DropdownMenuRadioItem key={option.id} value={option.id}>
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
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

function MentionMenu({
  results,
  activeIndex,
  onPick,
}: {
  results: Mention[];
  activeIndex: number;
  onPick: (mention: Mention) => void;
}) {
  return (
    <div className="absolute bottom-full left-0 right-0 mb-2 max-h-56 overflow-y-auto rounded-lg border bg-popover shadow-md py-1 z-50">
      {results.map((result, index) => (
        <button
          key={`${result.type}-${result.id}`}
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onPick(result)}
          className={cn(
            'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs',
            index === activeIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-muted',
          )}
        >
          <Icon name={MENTION_ICON[result.type]} className="size-3 shrink-0 text-muted-foreground" />
          <span className="truncate">{result.label}</span>
          <span className="ml-auto shrink-0 text-[10px] capitalize text-muted-foreground">{result.type}</span>
        </button>
      ))}
    </div>
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
}: {
  message: ChatMessage;
  isStreaming: boolean;
  onRevert: (messageId: string) => void;
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
      <div className="self-end max-w-[85%] flex flex-col items-end gap-1.5">
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
          <div className="rounded-lg bg-primary text-primary-foreground px-3 py-2 text-xs whitespace-pre-wrap break-words">
            {message.text}
          </div>
        )}
        {message.reverted ? (
          <span className="text-[10px] text-muted-foreground">Changes reverted</span>
        ) : message.canRevert ? (
          <button
            type="button"
            onClick={() => onRevert(message.id)}
            disabled={isStreaming}
            className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
          >
            <Icon name="undo" className="size-2.5" />
            Revert changes
          </button>
        ) : null}
      </div>
    );
  }

  const isEmpty = !message.text && message.toolCalls.length === 0;

  return (
    <div className="flex flex-col gap-2">
      {message.parts && message.parts.length > 0 ? (
        <MessageParts parts={message.parts} />
      ) : (
        <>
          {message.toolCalls.length > 0 && (
            <div className="flex flex-col gap-1">
              {message.toolCalls.map((call) => (
                <ToolCallRow key={call.id} call={call} />
              ))}
            </div>
          )}
          {message.text && <MarkdownText text={message.text} />}
        </>
      )}

      {isEmpty && isStreaming && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Spinner className="size-3" />
          <span>Thinking...</span>
        </div>
      )}
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

/**
 * Render an assistant turn's text and tool calls in the order they streamed in.
 * Consecutive tool calls are grouped into a single tight checklist so they read
 * as one step, while text fragments render as separate markdown blocks.
 */
function MessageParts({ parts }: { parts: ChatMessagePart[] }) {
  const groups: Array<{ type: 'tools'; calls: ChatToolCall[] } | { type: 'text'; text: string }> = [];
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

  return (
    <>
      {groups.map((group, index) =>
        group.type === 'tools' ? (
          <div key={index} className="flex flex-col gap-1">
            {group.calls.map((call) => (
              <ToolCallRow key={call.id} call={call} />
            ))}
          </div>
        ) : (
          <MarkdownText key={index} text={group.text} />
        ),
      )}
    </>
  );
}

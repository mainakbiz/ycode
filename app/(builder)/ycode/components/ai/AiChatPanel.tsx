'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { getLayerName } from '@/lib/layer-display-utils';
import { findLayerById } from '@/lib/layer-utils';
import { cn } from '@/lib/utils';
import { useAiChatStore } from '@/stores/useAiChatStore';
import type { ChatMessage, ImageAttachment, SelectedLayerRef } from '@/stores/useAiChatStore';
import { useEditorStore } from '@/stores/useEditorStore';
import { usePagesStore } from '@/stores/usePagesStore';

import { toolCallLabel } from './ai-tool-labels';

const SUGGESTIONS = [
  'Add a hero section with a headline and a call to action',
  'Create a 3-column features section',
  'Add a contact form at the bottom of this page',
];

const MAX_IMAGES = 4;
const ACCEPTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

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
  const sendMessage = useAiChatStore((s) => s.sendMessage);
  const stop = useAiChatStore((s) => s.stop);
  const clear = useAiChatStore((s) => s.clear);
  const close = useAiChatStore((s) => s.close);

  const selectedLayerIds = useEditorStore((s) => s.selectedLayerIds);
  const currentPageId = useEditorStore((s) => s.currentPageId);
  const draftLayers = usePagesStore((s) =>
    currentPageId ? s.draftsByPageId[currentPageId]?.layers : undefined,
  );

  const [input, setInput] = useState('');
  const [contextDetached, setContextDetached] = useState(false);
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const isStreaming = status === 'streaming';

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

  const submit = (text: string) => {
    if ((!text.trim() && images.length === 0) || isStreaming) return;
    setInput('');
    const attachment = { selectedLayers: attachedRefs, images };
    setImages([]);
    void sendMessage(text, attachment);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
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
        <div className="flex items-center justify-end px-4 pt-3 shrink-0">
          <Button
            size="sm"
            variant="ghost"
            className="size-7 p-0"
            onClick={clear}
            disabled={messages.length === 0}
            aria-label="New chat"
            title="New chat"
          >
            <Icon name="plus" className="size-3.5" />
          </Button>
        </div>
      ) : (
        <div className="flex items-center justify-between px-4 h-12 shrink-0 border-b">
          <div className="flex items-center gap-2">
            <Icon name="sparkles" className="size-3.5 text-foreground" />
            <span className="text-xs font-medium">AI</span>
          </div>
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              variant="ghost"
              className="size-7 p-0"
              onClick={clear}
              disabled={messages.length === 0}
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
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPTED_IMAGE_TYPES.join(',')}
            multiple
            className="hidden"
            onChange={handleFileChange}
          />
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder="Ask AI to build or edit your page..."
            rows={2}
            className="pl-10 pr-10 resize-none"
          />
          <div className="absolute left-2 bottom-2">
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
          </div>
          <div className="absolute right-2 bottom-2">
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

function MessageBubble({ message, isStreaming }: { message: ChatMessage; isStreaming: boolean }) {
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
      </div>
    );
  }

  const isEmpty = !message.text && message.toolCalls.length === 0;

  return (
    <div className="flex flex-col gap-2">
      {message.toolCalls.length > 0 && (
        <div className="flex flex-col gap-1">
          {message.toolCalls.map((call) => (
            <div key={call.id} className="flex items-center gap-2 text-xs text-muted-foreground">
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
          ))}
        </div>
      )}

      {message.text && (
        <div className="text-xs leading-relaxed whitespace-pre-wrap break-words">{message.text}</div>
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

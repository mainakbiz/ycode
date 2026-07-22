'use client';

import React from 'react';

import { NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from '@tiptap/react';

import { Badge } from '@/components/ui/badge';
import { Icon } from '@/components/ui/icon';
import { LayerMention, type LayerMentionType } from '@/lib/tiptap-extensions/layer-mention';

const MENTION_ICON: Record<LayerMentionType, 'page' | 'database' | 'layers' | 'component'> = {
  page: 'page',
  collection: 'database',
  layer: 'layers',
  component: 'component',
};

/** Inline badge rendered for a reference pill, with a click-to-remove affordance. */
function LayerMentionComponent({ node, deleteNode }: ReactNodeViewProps) {
  const mentionType = (node.attrs.mentionType as LayerMentionType) ?? 'layer';
  const label = (node.attrs.label as string) ?? '';
  const iconName = node.attrs.isComponentInstance ? 'component' : (MENTION_ICON[mentionType] ?? 'layers');

  return (
    <NodeViewWrapper as="span" className="inline-flex items-center align-middle">
      <Badge
        variant="teal"
        className="group h-[1.125rem] gap-1 rounded-md px-1 align-middle text-[12px] font-normal"
      >
        <span className="relative inline-flex size-2.5 shrink-0 items-center justify-center">
          <Icon
            name={iconName}
            className="size-2.5 group-hover:hidden"
          />
          <button
            type="button"
            aria-label={`Remove ${label}`}
            className="absolute inset-0 hidden items-center justify-center group-hover:inline-flex cursor-pointer"
            onMouseDown={(event) => event.preventDefault()}
            onClick={deleteNode}
          >
            <Icon name="x" className="size-2.5" />
          </button>
        </span>
        <span className="max-w-[140px] truncate">{label}</span>
      </Badge>
    </NodeViewWrapper>
  );
}

/** LayerMention node extended with the React badge NodeView for the chat composer. */
export const LayerMentionWithView = LayerMention.extend({
  addNodeView() {
    return ReactNodeViewRenderer(LayerMentionComponent);
  },
});

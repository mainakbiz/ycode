import { Node } from '@tiptap/core';

/**
 * Inline atom node for the AI chat composer's reference "pills" (layers, pages,
 * collections). Mirrors the dynamic-variable pattern: data lives in attributes
 * and the visual badge is rendered by a React NodeView (see LayerMentionView).
 *
 * Serialized HTML carries the data on a `span[data-mention-id]` so a pasted /
 * round-tripped document can be re-parsed into pills if ever needed.
 */
export type LayerMentionType = 'layer' | 'page' | 'collection' | 'component';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    layerMention: {
      /** Insert a reference pill at the current selection. */
      insertLayerMention: (attrs: {
        mentionId: string;
        mentionType: LayerMentionType;
        label: string;
        /** Display-only: render the component icon (layer is a component instance). */
        isComponentInstance?: boolean;
      }) => ReturnType;
    };
  }
}

export const LayerMention = Node.create({
  name: 'layerMention',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      mentionId: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-mention-id'),
        renderHTML: (attributes) =>
          attributes.mentionId ? { 'data-mention-id': attributes.mentionId } : {},
      },
      mentionType: {
        default: 'layer',
        parseHTML: (element) => element.getAttribute('data-mention-type') || 'layer',
        renderHTML: (attributes) =>
          attributes.mentionType ? { 'data-mention-type': attributes.mentionType } : {},
      },
      label: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-mention-label') || element.textContent || '',
        renderHTML: (attributes) =>
          attributes.label ? { 'data-mention-label': attributes.label } : {},
      },
      isComponentInstance: {
        default: false,
        parseHTML: (element) => element.getAttribute('data-mention-component') === 'true',
        renderHTML: (attributes) =>
          attributes.isComponentInstance ? { 'data-mention-component': 'true' } : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-mention-id]' }];
  },

  renderHTML({ node }) {
    const label = (node.attrs.label as string) || 'mention';
    return [
      'span',
      {
        'data-mention-id': node.attrs.mentionId,
        'data-mention-type': node.attrs.mentionType,
        'data-mention-label': label,
        ...(node.attrs.isComponentInstance ? { 'data-mention-component': 'true' } : {}),
      },
      `@${label}`,
    ];
  },

  addCommands() {
    return {
      insertLayerMention:
        (attrs) =>
          ({ chain }) =>
            chain()
              .insertContent([
                { type: this.name, attrs },
                { type: 'text', text: ' ' },
              ])
              .run(),
    };
  },
});

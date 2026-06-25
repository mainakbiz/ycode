/**
 * Pagination Text Utilities
 *
 * Pagination count/info texts ("Showing 6 of 20", "Page 1 of 3") embed the live
 * numbers as `pagination` inline variables so the surrounding words stay editable
 * and translatable. These helpers build the default templates and resolve the
 * variables to numbers at render time.
 *
 * CLIENT-SAFE: pure string/object manipulation, no server-only imports.
 */

import type {
  CollectionPaginationMeta,
  DynamicRichTextVariable,
  DynamicTextVariable,
  PaginationNumbers,
} from '@/types';

export type PaginationVariableKey = keyof PaginationNumbers;

/** Human-readable chip labels shown in the editor / translation UI. */
export const PAGINATION_VARIABLE_LABELS: Record<PaginationVariableKey, string> = {
  shown: 'Shown items',
  total: 'Total items',
  current: 'Current page',
  pages: 'Total pages',
};

const INLINE_VARIABLE_REGEX = /<ycode-inline-variable>([\s\S]*?)<\/ycode-inline-variable>/g;

/** Build a Tiptap `dynamicVariable` chip node for a pagination key. */
export function paginationVariableNode(key: PaginationVariableKey) {
  return {
    type: 'dynamicVariable',
    attrs: {
      variable: { type: 'pagination', data: { key } },
      label: PAGINATION_VARIABLE_LABELS[key],
    },
  };
}

/** Build a single-paragraph Tiptap doc from text/chip parts. */
function paginationDoc(parts: Array<{ text: string } | ReturnType<typeof paginationVariableNode>>) {
  const content = parts.map((part) =>
    'text' in part ? { type: 'text', text: part.text } : part
  );
  return { type: 'doc', content: [{ type: 'paragraph', content }] };
}

/** Default "Showing {shown} of {total}" doc for the load-more count layer. */
export function defaultPaginationCountDoc() {
  return paginationDoc([
    { text: 'Showing ' },
    paginationVariableNode('shown'),
    { text: ' of ' },
    paginationVariableNode('total'),
  ]);
}

/** Default "Page {current} of {pages}" doc for the pages info layer. */
export function defaultPaginationInfoDoc() {
  return paginationDoc([
    { text: 'Page ' },
    paginationVariableNode('current'),
    { text: ' of ' },
    paginationVariableNode('pages'),
  ]);
}

/** Identify whether a layer id is a pagination count/info text layer. */
export function getPaginationLayerKind(id: string | undefined | null): 'count' | 'info' | null {
  if (!id) return null;
  if (id.endsWith('-pagination-count')) return 'count';
  if (id.endsWith('-pagination-info')) return 'info';
  return null;
}

/** Compute the live numbers from pagination meta (optionally overriding `shown`). */
export function buildPaginationNumbers(
  meta: Pick<CollectionPaginationMeta, 'currentPage' | 'totalPages' | 'totalItems' | 'itemsPerPage'>,
  shownOverride?: number,
): PaginationNumbers {
  return {
    shown: shownOverride ?? Math.min(meta.itemsPerPage, meta.totalItems),
    total: meta.totalItems,
    current: meta.currentPage,
    pages: meta.totalPages,
  };
}

/** Whether a text variable contains any `pagination` inline variable. */
export function hasPaginationVariables(
  textVar: DynamicTextVariable | DynamicRichTextVariable | undefined | null,
): boolean {
  if (!textVar) return false;
  if (textVar.type === 'dynamic_text' && typeof textVar.data.content === 'string') {
    return textVar.data.content.includes('"type":"pagination"');
  }
  if (textVar.type === 'dynamic_rich_text') {
    return JSON.stringify(textVar.data.content || {}).includes('"type":"pagination"');
  }
  return false;
}

/** Replace `pagination` inline-variable tokens in a plain string with numbers. */
export function resolvePaginationString(text: string, numbers: PaginationNumbers): string {
  if (!text) return text;
  return text.replace(INLINE_VARIABLE_REGEX, (match, content) => {
    try {
      const parsed = JSON.parse(String(content).trim());
      if (parsed?.type === 'pagination' && parsed?.data?.key in numbers) {
        return String(numbers[parsed.data.key as PaginationVariableKey]);
      }
    } catch {
      // Not valid JSON — leave untouched
    }
    return match;
  });
}

/** Replace `pagination` dynamicVariable nodes in a Tiptap doc with text nodes. */
export function resolvePaginationDoc(doc: unknown, numbers: PaginationNumbers): unknown {
  const walk = (node: any): any => {
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      if (
        node.type === 'dynamicVariable' &&
        node.attrs?.variable?.type === 'pagination' &&
        node.attrs.variable.data?.key in numbers
      ) {
        return { type: 'text', text: String(numbers[node.attrs.variable.data.key as PaginationVariableKey]) };
      }
      const next: any = { ...node };
      if (Array.isArray(node.content)) next.content = node.content.map(walk);
      return next;
    }
    return node;
  };
  return walk(doc);
}

/**
 * Serialize a text variable to a canonical token string (text + inline-variable
 * tokens). Used to hand the translated template to the client load-more runtime
 * so it can re-resolve the count after appending items.
 */
export function paginationTextVariableToTemplate(
  textVar: DynamicTextVariable | DynamicRichTextVariable | undefined | null,
): string {
  if (!textVar) return '';
  if (textVar.type === 'dynamic_text' && typeof textVar.data.content === 'string') {
    return textVar.data.content;
  }
  if (textVar.type === 'dynamic_rich_text' && textVar.data.content && typeof textVar.data.content === 'object') {
    let result = '';
    const walk = (node: any): void => {
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      if (!node || typeof node !== 'object') return;
      if (node.type === 'text') {
        result += node.text || '';
      } else if (node.type === 'dynamicVariable' && node.attrs?.variable) {
        result += `<ycode-inline-variable>${JSON.stringify(node.attrs.variable)}</ycode-inline-variable>`;
      } else if (Array.isArray(node.content)) {
        node.content.forEach(walk);
      }
    };
    walk((textVar.data.content as any).content);
    return result;
  }
  return '';
}

/**
 * Resolve all `pagination` inline variables in a text variable to live numbers.
 * Handles both `dynamic_text` strings and `dynamic_rich_text` Tiptap docs.
 */
export function resolvePaginationTextVariable<
  T extends DynamicTextVariable | DynamicRichTextVariable
>(textVar: T, numbers: PaginationNumbers): T {
  if (textVar.type === 'dynamic_text' && typeof textVar.data.content === 'string') {
    return { ...textVar, data: { ...textVar.data, content: resolvePaginationString(textVar.data.content, numbers) } };
  }
  if (textVar.type === 'dynamic_rich_text' && textVar.data.content && typeof textVar.data.content === 'object') {
    return { ...textVar, data: { ...textVar.data, content: resolvePaginationDoc(textVar.data.content, numbers) } };
  }
  return textVar;
}

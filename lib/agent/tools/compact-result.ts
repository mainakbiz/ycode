/**
 * Compact verbose tool outputs before they re-enter the model's context.
 *
 * `get_layers` returns the entire Layer tree as JSON — design objects, style
 * overrides, interactions, attributes, restrictions, etc. — most of which is
 * redundant with the compiled `classes` string and dominates input-token cost
 * on multi-turn builds (the tree is resent each tool turn). We project each
 * layer down to just what the agent needs to navigate and edit it (id, type,
 * name, text, classes, structure) and hard-cap any other oversized result as a
 * safety net.
 *
 * This runs only on the in-app agent path; the shared MCP server still returns
 * full-fidelity layers to external clients.
 */

/** Any tool result larger than this is truncated as a last resort. */
const MAX_RESULT_CHARS = 16_000;

/** Block-level Tiptap node types that should be separated by whitespace. */
const BLOCK_NODE_TYPES = new Set([
  'paragraph',
  'heading',
  'listItem',
  'blockquote',
  'codeBlock',
]);

interface RawLayer {
  id?: string;
  name?: string;
  customName?: string;
  classes?: string | string[];
  hidden?: boolean;
  componentId?: string;
  settings?: { tag?: string };
  attributes?: { id?: string };
  variables?: { text?: { data?: { content?: unknown } } };
  children?: RawLayer[];
}

export function compactToolResult(toolName: string, text: string): string {
  if (toolName === 'get_layers') {
    const compact = compactLayerTreeJson(text);
    if (compact !== null) return compact;
  }

  if (text.length > MAX_RESULT_CHARS) {
    const omitted = text.length - MAX_RESULT_CHARS;
    return `${text.slice(0, MAX_RESULT_CHARS)}\n…[truncated ${omitted} characters]`;
  }

  return text;
}

/** Parse a get_layers JSON payload and re-serialize a compact projection. */
function compactLayerTreeJson(text: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  const layers = Array.isArray(parsed) ? parsed : [parsed];
  try {
    return JSON.stringify(layers.map((layer) => compactLayer(layer as RawLayer)));
  } catch {
    return null;
  }
}

function compactLayer(layer: RawLayer): Record<string, unknown> {
  const out: Record<string, unknown> = { id: layer.id, type: layer.name };

  if (layer.customName && layer.customName !== layer.name) out.name = layer.customName;

  const text = extractLayerText(layer);
  if (text) out.text = text;

  const classes = normalizeClasses(layer.classes);
  if (classes) out.classes = classes;

  if (layer.settings?.tag) out.tag = layer.settings.tag;
  if (layer.attributes?.id) out.htmlId = layer.attributes.id;
  if (layer.hidden) out.hidden = true;
  // Component instances are read-only (edit the master component instead).
  if (layer.componentId) out.componentInstance = true;

  if (Array.isArray(layer.children) && layer.children.length > 0) {
    out.children = layer.children.map(compactLayer);
  }

  return out;
}

function normalizeClasses(classes?: string | string[]): string {
  if (!classes) return '';
  return (Array.isArray(classes) ? classes.join(' ') : classes).trim();
}

/** Pull the literal display text out of a layer's Tiptap text variable. */
function extractLayerText(layer: RawLayer): string {
  const content = layer.variables?.text?.data?.content;
  if (!content) return '';
  return collectTiptapText(content).replace(/\s+/g, ' ').trim();
}

function collectTiptapText(node: unknown): string {
  if (Array.isArray(node)) {
    return node.map(collectTiptapText).join('');
  }
  if (!node || typeof node !== 'object') return '';

  const typed = node as { type?: string; text?: string; content?: unknown };
  let result = typeof typed.text === 'string' ? typed.text : '';
  if (typed.content) result += collectTiptapText(typed.content);
  if (typed.type && BLOCK_NODE_TYPES.has(typed.type)) result += ' ';
  return result;
}

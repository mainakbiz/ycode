/**
 * Compact verbose tool outputs before they re-enter the model's context.
 *
 * `get_layers` and `get_component` return entire Layer trees as JSON — design
 * objects, style overrides, interactions, attributes, restrictions, etc. —
 * most of which is redundant with the compiled `classes` string and dominates
 * input-token cost on multi-turn builds (the tree is resent each tool turn).
 * We project each layer down to just what the agent needs to navigate and edit
 * it (id, type, name, text, classes, structure, variable links for
 * components). Oversized `list_collection_items` payloads get per-value
 * truncation so the JSON stays valid, and everything else is hard-capped as a
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

/** Override buckets on a component instance, keyed by component-variable id. */
const OVERRIDE_CATEGORIES = ['text', 'rich_text', 'image', 'link', 'audio', 'video', 'icon', 'variant'] as const;

interface RawLayer {
  id?: string;
  name?: string;
  customName?: string;
  classes?: string | string[];
  hidden?: boolean;
  componentId?: string;
  componentVariantId?: string;
  componentOverrides?: Record<string, unknown>;
  settings?: { tag?: string };
  attributes?: { id?: string };
  variables?: { text?: { data?: { content?: unknown } } } & Record<string, unknown>;
  componentVariantVariableId?: string;
  children?: RawLayer[];
}

export function compactToolResult(toolName: string, text: string): string {
  if (toolName === 'get_layers') {
    const compact = compactLayerTreeJson(text);
    if (compact !== null) return compact;
  }

  if (toolName === 'get_component') {
    const compact = compactComponentJson(text);
    if (compact !== null) return compact;
  }

  // Collection items can carry entire blog posts as Tiptap JSON. When the
  // payload fits the budget it passes through untouched (agents editing or
  // translating content need the full values); when it doesn't, truncating
  // per-value keeps the JSON valid and every item present instead of chopping
  // the payload mid-item below.
  if (toolName === 'list_collection_items' && text.length > MAX_RESULT_CHARS) {
    const compact = compactCollectionItemsJson(text);
    if (compact !== null) text = compact;
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

function compactLayer(layer: RawLayer, includeVariableRefs = false): Record<string, unknown> {
  const out: Record<string, unknown> = { id: layer.id, type: layer.name };

  if (layer.customName && layer.customName !== layer.name) out.name = layer.customName;

  const text = extractLayerText(layer);
  if (text) out.text = text;

  const classes = normalizeClasses(layer.classes);
  if (classes) out.classes = classes;

  if (layer.settings?.tag) out.tag = layer.settings.tag;
  if (layer.attributes?.id) out.htmlId = layer.attributes.id;
  if (layer.hidden) out.hidden = true;
  // Component instances: the children are read-only (edit the master component to
  // change structure), but content is customizable per instance via
  // set_component_instance. Surface the master id, selected variant, and which
  // variables already carry overrides so the agent can read/rewire them.
  if (layer.componentId) {
    out.componentInstance = true;
    out.componentId = layer.componentId;
    if (layer.componentVariantId) out.componentVariantId = layer.componentVariantId;
    const overrideSummary = summarizeOverrides(layer.componentOverrides);
    if (overrideSummary) out.overrideSummary = overrideSummary;
  }

  if (includeVariableRefs) {
    const refs = collectVariableRefs(layer.variables) ?? {};
    // Variant links live on a top-level layer field, not inside variables.
    if (layer.componentVariantVariableId) refs.variant = layer.componentVariantVariableId;
    if (Object.keys(refs).length > 0) out.variableRefs = refs;
  }

  if (Array.isArray(layer.children) && layer.children.length > 0) {
    out.children = layer.children.map((child) => compactLayer(child, includeVariableRefs));
  }

  return out;
}

/**
 * Which component variable each of the layer's slots is linked to, e.g.
 * { text: "<variable id>" }. Needed inside component trees so the agent can
 * see (and rewire) variable links without the full variables payload.
 */
function collectVariableRefs(variables?: Record<string, unknown>): Record<string, string> | null {
  if (!variables) return null;

  const refs: Record<string, string> = {};
  for (const [slot, value] of Object.entries(variables)) {
    if (!value || typeof value !== 'object') continue;
    const typed = value as { id?: unknown; src?: { id?: unknown }; variable_id?: unknown };
    const id = typeof typed.id === 'string' ? typed.id : undefined;
    const srcId = typeof typed.src?.id === 'string' ? typed.src.id : undefined;
    // Link variables store the ref as `variable_id` (not `id`).
    const variableId = typeof typed.variable_id === 'string' ? typed.variable_id : undefined;
    if (id) refs[slot] = id;
    else if (srcId) refs[slot] = srcId;
    else if (variableId) refs[slot] = variableId;
  }

  return Object.keys(refs).length > 0 ? refs : null;
}

/**
 * Summarize which component variables a page instance currently overrides, per
 * category, e.g. { text: ["cvar-title"], image: ["cvar-hero"] }. Keeps the
 * agent aware of existing overrides without shipping their full Tiptap/settings
 * payloads.
 */
function summarizeOverrides(
  overrides?: Record<string, unknown>,
): Record<string, string[]> | null {
  if (!overrides) return null;

  const summary: Record<string, string[]> = {};
  for (const category of OVERRIDE_CATEGORIES) {
    const bucket = overrides[category];
    if (!bucket || typeof bucket !== 'object') continue;
    const ids = Object.keys(bucket as Record<string, unknown>);
    if (ids.length > 0) summary[category] = ids;
  }

  return Object.keys(summary).length > 0 ? summary : null;
}

interface RawComponent {
  id?: string;
  name?: string;
  layers?: RawLayer[];
  variants?: Array<{ id?: string; name?: string; layers?: RawLayer[] }>;
  variables?: unknown;
}

/**
 * Project a get_component payload down to what the agent needs: identity,
 * variables (small), and each variant's compacted layer tree with variable
 * links. Drops the legacy top-level `layers` mirror (same tree as variants[0]),
 * design objects, timestamps, and publish metadata.
 */
function compactComponentJson(text: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const component = parsed as RawComponent;
  try {
    const variants = (component.variants && component.variants.length > 0)
      ? component.variants
      : [{ id: 'default', name: 'Default', layers: component.layers ?? [] }];

    return JSON.stringify({
      id: component.id,
      name: component.name,
      variables: component.variables ?? [],
      variants: variants.map((variant) => ({
        id: variant.id,
        name: variant.name,
        layers: (variant.layers ?? []).map((layer) => compactLayer(layer, true)),
      })),
    });
  } catch {
    return null;
  }
}

/** Per-value budget once a list_collection_items payload exceeds the cap. */
const MAX_ITEM_VALUE_CHARS = 1_000;

/** Truncate oversized field values (typically rich_text bodies) in place. */
function compactCollectionItemsJson(text: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const payload = parsed as { items?: Array<{ values?: Record<string, unknown> }> };
  if (!Array.isArray(payload.items)) return null;

  try {
    for (const item of payload.items) {
      if (!item?.values) continue;
      for (const [fieldId, value] of Object.entries(item.values)) {
        const serialized = typeof value === 'string' ? value : JSON.stringify(value);
        if (typeof serialized === 'string' && serialized.length > MAX_ITEM_VALUE_CHARS) {
          item.values[fieldId] =
            `${serialized.slice(0, MAX_ITEM_VALUE_CHARS)}…[truncated ${serialized.length - MAX_ITEM_VALUE_CHARS} chars]`;
        }
      }
    }
    return JSON.stringify(payload);
  } catch {
    return null;
  }
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

import { z } from 'zod';

import { designSchema, richTextBlockSchema } from '@/lib/mcp/tools/shared-schemas';

import type { AgentTool } from './types';

/**
 * Anthropic Messages API tool definition.
 * See https://docs.anthropic.com/en/docs/build-with-claude/tool-use
 */
export interface AnthropicToolSchema {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

type JsonObject = Record<string, unknown>;

/**
 * Convert a shared AgentTool into the JSON-Schema shape Anthropic expects.
 *
 * Uses zod v4's native `z.toJSONSchema`. All tool schemas are plain
 * objects/enums/arrays/unions (no transforms or refinements), so conversion is
 * lossless. The provider boundary keeps this Anthropic-specific for now; a GPT
 * provider would add its own converter without touching the registry.
 *
 * The converted schema is then compacted (see `compactJsonSchema`) to cut the
 * token cost of the tools payload. This only changes what the MODEL sees —
 * runtime validation in the registry still uses the full zod schemas, and the
 * MCP server (external agents) is untouched.
 */
export function toAnthropicTool(tool: AgentTool): AnthropicToolSchema {
  const jsonSchema = z.toJSONSchema(z.object(tool.inputSchema)) as JsonObject;

  // Anthropic doesn't use the JSON-Schema dialect marker; drop it to keep payloads lean.
  delete jsonSchema.$schema;

  return {
    name: tool.name,
    description: tool.description,
    input_schema: compactJsonSchema(jsonSchema, getCompactTargets()) as JsonObject,
  };
}

export function toAnthropicTools(tools: AgentTool[]): AnthropicToolSchema[] {
  return tools.map(toAnthropicTool);
}

// ── Schema compaction ────────────────────────────────────────────────────────
//
// The full `designSchema` expands to ~6.7KB of JSON Schema and is embedded in
// seven tools (update_layer_design, create/update_style, add_layer, and twice
// each inside batch_operations and update_component_layers). Sending it
// verbatim costs ~47KB of the ~154KB tools payload on EVERY request — while the
// system prompt already documents every design property with formats and
// examples. So for the in-app agent we swap each embedded copy for a compact
// node that keeps the category structure and lists every property name (the
// part the model can't guess), and points at the design guide for semantics.
// Anthropic doesn't enforce input_schema server-side, and the registry
// validates arguments with the original zod schema before executing, so this
// is purely a prompt-size optimization.
//
// Matching is done by fingerprinting a node's `properties` against the
// canonical schema's JSON. If `designSchema` changes, the fingerprint is
// recomputed from the same object, so the match can't drift; a schema that
// merely resembles it is left fully expanded (safe fallback).

/** Custom `.describe()` texts survive compaction; only short per-property hints are inlined. */
const MAX_INLINE_PROP_DESC = 64;

interface CompactTarget {
  /** JSON of the canonical schema's `properties`, used to recognize embedded copies. */
  fingerprint: string;
  /** Description carried by the canonical schema itself (from `.describe()`), if any. */
  canonicalDescription?: string;
  /** The replacement node. */
  compact: JsonObject;
}

let compactTargets: CompactTarget[] | null = null;

function getCompactTargets(): CompactTarget[] {
  if (!compactTargets) {
    compactTargets = [buildDesignTarget(), buildRichTextTarget()];
  }
  return compactTargets;
}

/**
 * Recursively rewrite a converted JSON Schema:
 *  - replace embedded copies of known shared schemas with their compact form
 *  - drop `additionalProperties: false` markers (zod strips unknown keys at
 *    parse time anyway; the marker is pure token noise for the model)
 */
function compactJsonSchema(node: unknown, targets: CompactTarget[]): unknown {
  if (Array.isArray(node)) {
    return node.map((item) => compactJsonSchema(item, targets));
  }
  if (!node || typeof node !== 'object') {
    return node;
  }

  const obj = node as JsonObject;
  if (obj.type === 'object' && obj.properties) {
    const fingerprint = JSON.stringify(obj.properties);
    const target = targets.find((t) => t.fingerprint === fingerprint);
    if (target) {
      return withPreservedDescription(target, obj);
    }
  }

  const out: JsonObject = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key === 'additionalProperties' && value === false) continue;
    out[key] = compactJsonSchema(value, targets);
  }
  return out;
}

/** Keep a call-site `.describe()` (e.g. batch add_layer's design hint) in front of the compact description. */
function withPreservedDescription(target: CompactTarget, original: JsonObject): JsonObject {
  const description = original.description;
  if (typeof description === 'string' && description !== target.canonicalDescription) {
    return { ...target.compact, description: `${description}. ${target.compact.description as string}` };
  }
  return { ...target.compact };
}

function buildDesignTarget(): CompactTarget {
  const json = z.toJSONSchema(designSchema) as JsonObject;
  const categories = json.properties as Record<string, JsonObject>;

  const properties: JsonObject = {};
  for (const [category, categorySchema] of Object.entries(categories)) {
    properties[category] = {
      type: 'object',
      description: `Props: ${summarizeProperties(categorySchema)}`,
    };
  }

  return {
    fingerprint: JSON.stringify(json.properties),
    canonicalDescription: json.description as string | undefined,
    compact: {
      type: 'object',
      description:
        'Design properties grouped by category. Set isActive: true on each category you use. '
        + 'Values are CSS-like strings — see the Design Properties guide in your instructions for formats and examples.',
      properties,
    },
  };
}

function buildRichTextTarget(): CompactTarget {
  const json = z.toJSONSchema(richTextBlockSchema) as JsonObject;
  const properties = json.properties as Record<string, JsonObject>;

  return {
    fingerprint: JSON.stringify(json.properties),
    canonicalDescription: json.description as string | undefined,
    compact: {
      type: 'object',
      description:
        'Rich text block — see the Rich Text guide in your instructions. '
        + `Fields: ${summarizeProperties(json)}`,
      properties: { type: properties.type },
      required: ['type'],
    },
  };
}

/** "name (short hint), name, ..." — property names are the part the model can't guess. */
function summarizeProperties(objectSchema: JsonObject): string {
  const properties = (objectSchema.properties ?? {}) as Record<string, JsonObject>;
  return Object.entries(properties)
    .map(([name, prop]) => {
      const description = typeof prop.description === 'string' ? prop.description : '';
      return description && description.length <= MAX_INLINE_PROP_DESC
        ? `${name} (${description})`
        : name;
    })
    .join(', ');
}

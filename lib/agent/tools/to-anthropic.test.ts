import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { toAnthropicTool } from '@/lib/agent/tools/to-anthropic';
import { designSchema, richTextBlockSchema } from '@/lib/mcp/tools/shared-schemas';
import type { AgentTool } from '@/lib/agent/tools/types';

function makeTool(inputSchema: z.ZodRawShape): AgentTool {
  return {
    name: 'test_tool',
    description: 'A test tool.',
    inputSchema,
    group: 'core',
    execute: async () => ({ content: [] }),
  };
}

type JsonObject = Record<string, unknown>;

function collectJson(node: unknown): string {
  return JSON.stringify(node);
}

test('replaces an embedded designSchema with the compact node', () => {
  const tool = toAnthropicTool(makeTool({
    layer_id: z.string(),
    design: designSchema,
  }));

  const design = (tool.input_schema.properties as Record<string, JsonObject>).design;
  assert.match(design.description as string, /Design properties grouped by category/);

  // The category structure survives, but leaf property schemas are gone.
  const categories = design.properties as Record<string, JsonObject>;
  assert.ok(categories.typography);
  assert.equal(categories.typography.properties, undefined);
  // Every property name is still discoverable in the category description.
  assert.match(categories.typography.description as string, /\bfontSize\b/);
  assert.match(categories.typography.description as string, /\bplaceholderColor\b/);
});

test('compacts designSchema inside nested structures (arrays, unions)', () => {
  const op = z.object({
    type: z.literal('update_design'),
    design: designSchema,
  });
  const tool = toAnthropicTool(makeTool({
    operations: z.array(z.discriminatedUnion('type', [op, z.object({ type: z.literal('noop') })])),
  }));

  const json = collectJson(tool.input_schema);
  assert.match(json, /Design properties grouped by category/);
  // The full expansion (unique leaf property) must not appear anywhere.
  assert.ok(!json.includes('"placeholderColor":{'));
});

test('preserves a call-site describe() on a compacted design node', () => {
  const tool = toAnthropicTool(makeTool({
    design: designSchema.optional().describe('Design properties to apply immediately on creation'),
  }));

  const design = (tool.input_schema.properties as Record<string, JsonObject>).design;
  assert.match(design.description as string, /^Design properties to apply immediately on creation\./);
  assert.match(design.description as string, /Design properties grouped by category/);
});

test('compacts richTextBlockSchema but keeps the type enum', () => {
  const tool = toAnthropicTool(makeTool({
    blocks: z.array(richTextBlockSchema),
  }));

  const blocks = (tool.input_schema.properties as Record<string, JsonObject>).blocks;
  const items = blocks.items as JsonObject;
  assert.match(items.description as string, /Rich text block/);
  const typeProp = (items.properties as Record<string, JsonObject>).type;
  assert.ok(Array.isArray(typeProp.enum));
  assert.ok((typeProp.enum as string[]).includes('paragraph'));
  // Field names are listed so the model can still fill them in.
  assert.match(items.description as string, /\basset_id\b/);
});

test('strips additionalProperties:false markers everywhere', () => {
  const tool = toAnthropicTool(makeTool({
    nested: z.object({ inner: z.object({ value: z.string() }) }),
  }));

  assert.ok(!collectJson(tool.input_schema).includes('"additionalProperties":false'));
});

test('leaves schemas that merely resemble the design schema untouched', () => {
  const lookalike = z.object({
    layout: z.object({ isActive: z.boolean().optional(), display: z.string().optional() }).optional(),
  });
  const tool = toAnthropicTool(makeTool({ design: lookalike }));

  const design = (tool.input_schema.properties as Record<string, JsonObject>).design;
  const layout = (design.properties as Record<string, JsonObject>).layout;
  // Still fully expanded — has its own properties object.
  assert.ok(layout.properties);
});

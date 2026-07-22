/**
 * Tests for deferred tool loading (deferred.ts + registry grouping).
 *
 * Guards the split that keeps the up-front tool payload small: core must keep
 * the everyday building tools, deferred groups must cover the rest, and the
 * load_tools meta-tool must convert to a valid Anthropic schema.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

// The registry pulls in `server-only` modules; neutralize for the test runner.
import Module from 'module';
const origLoad = (Module as { _load?: unknown } as { _load: (...args: unknown[]) => unknown })._load;
(Module as unknown as { _load: (...args: unknown[]) => unknown })._load = function (request: unknown, ...rest: unknown[]) {
  if (request === 'server-only') return {};
  return origLoad.call(this, request, ...rest);
};

import { buildLoadToolsTool, deferredGroupOf, getDeferredGroupCatalog, LOAD_TOOLS_NAME } from '@/lib/agent/tools/deferred';
import { getAgentTools } from '@/lib/agent/tools/registry';
import { toAnthropicTool } from '@/lib/agent/tools/to-anthropic';

test('every registry tool has a group', () => {
  for (const tool of getAgentTools()) {
    assert.ok(tool.group, `tool ${tool.name} has no group`);
  }
});

test('core keeps the everyday building tools', () => {
  const core = new Set(getAgentTools().filter((t) => t.group === 'core').map((t) => t.name));
  for (const name of [
    'get_layers', 'add_layer', 'batch_operations', 'update_layer_design', 'update_layer_text',
    'add_layout', 'list_layouts', 'upload_asset', 'create_page', 'update_page_settings',
    'add_font', 'create_color_variable', 'update_form_settings',
  ]) {
    assert.ok(core.has(name), `${name} should be core`);
  }
});

test('heavy specialty tools are deferred', () => {
  assert.equal(deferredGroupOf('update_component_layers'), 'components');
  assert.equal(deferredGroupOf('bind_collection_layer'), 'cms');
  assert.equal(deferredGroupOf('set_layer_interactions'), 'animations');
  assert.equal(deferredGroupOf('create_style'), 'styles');
  assert.equal(deferredGroupOf('set_translation'), 'localization');
  assert.equal(deferredGroupOf('add_redirect'), 'site');
  assert.equal(deferredGroupOf('get_layers'), null);
  assert.equal(deferredGroupOf('no_such_tool'), null);
});

test('catalog lists every deferred tool exactly once', () => {
  const catalog = getDeferredGroupCatalog();
  const listed = catalog.flatMap((entry) => entry.tools);
  const deferred = getAgentTools().filter((t) => t.group !== 'core').map((t) => t.name);
  assert.deepEqual(new Set(listed), new Set(deferred));
  assert.equal(listed.length, deferred.length, 'no tool should appear in two groups');
});

test('load_tools converts to a valid Anthropic schema and mentions every group', () => {
  const tool = buildLoadToolsTool();
  assert.equal(tool.name, LOAD_TOOLS_NAME);
  const anthropic = toAnthropicTool(tool);
  const schema = JSON.stringify(anthropic.input_schema);
  for (const entry of getDeferredGroupCatalog()) {
    assert.ok(schema.includes(entry.group), `schema enum should include ${entry.group}`);
    assert.ok(anthropic.description.includes(entry.group), `description should document ${entry.group}`);
  }
});

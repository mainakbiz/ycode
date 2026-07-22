import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactToolResult } from '@/lib/agent/tools/compact-result';

function textLayer(id: string, text: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name: 'text',
    classes: 'text-base',
    design: { typography: { isActive: true, fontSize: '16px' } },
    variables: { text: { data: { content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] } } },
    ...extra,
  };
}

test('get_component: compacts variant trees and keeps variable links', () => {
  const component = {
    id: 'cmp-1',
    name: 'Feature Card',
    is_published: false,
    content_hash: 'abc',
    created_at: '2026-01-01',
    updated_at: '2026-01-02',
    layers: [textLayer('lyr-legacy', 'mirror of variants[0]')],
    variants: [
      {
        id: 'var-default',
        name: 'Default',
        layers: [textLayer('lyr-title', 'Card title', { variables: {
          text: {
            id: 'cvar-title',
            data: { content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Card title' }] }] },
          },
        } })],
      },
    ],
    variables: [{ id: 'cvar-title', name: 'Title', type: 'text' }],
  };

  const result = JSON.parse(compactToolResult('get_component', JSON.stringify(component)));

  assert.equal(result.id, 'cmp-1');
  assert.equal(result.name, 'Feature Card');
  // Publish/versioning metadata and the legacy layers mirror are dropped.
  assert.equal(result.is_published, undefined);
  assert.equal(result.content_hash, undefined);
  assert.equal(result.layers, undefined);
  // Component variables survive; the layer records which variable it's linked to.
  assert.equal(result.variables[0].id, 'cvar-title');
  const layer = result.variants[0].layers[0];
  assert.equal(layer.id, 'lyr-title');
  assert.equal(layer.text, 'Card title');
  assert.deepEqual(layer.variableRefs, { text: 'cvar-title' });
  // Design objects are projected away (classes are the styling source of truth).
  assert.equal(layer.design, undefined);
  assert.equal(layer.classes, 'text-base');
});

test('get_component: legacy component without variants falls back to layers', () => {
  const component = {
    id: 'cmp-2',
    name: 'Old Component',
    layers: [textLayer('lyr-1', 'hello')],
  };

  const result = JSON.parse(compactToolResult('get_component', JSON.stringify(component)));
  assert.equal(result.variants.length, 1);
  assert.equal(result.variants[0].layers[0].id, 'lyr-1');
});

test('list_collection_items: small payloads pass through untouched', () => {
  const payload = JSON.stringify({
    fields: [{ id: 'f1', name: 'Title', type: 'text' }],
    items: [{ id: 'i1', values: { f1: 'A short title' } }],
    total: 1,
  });

  assert.equal(compactToolResult('list_collection_items', payload), payload);
});

test('list_collection_items: oversized payloads get per-value truncation, valid JSON', () => {
  const bigBody = 'lorem ipsum '.repeat(2000); // ~24k chars in one field value
  const payload = JSON.stringify({
    fields: [
      { id: 'f-title', name: 'Title', type: 'text' },
      { id: 'f-content', name: 'Content', type: 'rich_text' },
    ],
    items: [
      { id: 'i1', values: { 'f-title': 'Post one', 'f-content': bigBody } },
      { id: 'i2', values: { 'f-title': 'Post two', 'f-content': bigBody } },
    ],
    total: 2,
  });

  const result = compactToolResult('list_collection_items', payload);
  const parsed = JSON.parse(result); // must stay valid JSON

  // Every item is still present with short values intact.
  assert.equal(parsed.items.length, 2);
  assert.equal(parsed.items[0].values['f-title'], 'Post one');
  // Long values are truncated with a marker.
  assert.ok(parsed.items[0].values['f-content'].includes('…[truncated'));
  assert.ok(parsed.items[0].values['f-content'].length < 1_100);
  assert.ok(result.length < payload.length);
});

test('unknown oversized results still hit the hard cap', () => {
  const huge = 'x'.repeat(20_000);
  const result = compactToolResult('export_layer_html', huge);
  assert.ok(result.length < 17_000);
  assert.ok(result.includes('…[truncated'));
});

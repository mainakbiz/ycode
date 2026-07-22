/**
 * Server-Side CSS Generator using Tailwind CSS Node API
 *
 * Mirrors the client-side cssGenerator but runs on the server.
 * Used by the /ycode/api/css/generate endpoint so that MCP-created
 * layers (or any API-driven changes) get their CSS generated without
 * needing the browser editor open.
 *
 * Also provides per-page CSS generation for targeted cache invalidation:
 * each page stores its own generated_css so design changes are page-scoped.
 */

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { compile } from 'tailwindcss';
import type { Layer, Component } from '@/types';
import { DEFAULT_TEXT_STYLES } from '@/lib/text-format-utils';
import { TAILWIND_CUSTOM_VARIANTS } from '@/lib/tailwind-custom-variants';
import { getAllDraftLayers, getDraftLayers, getEmbeddedComponentIdsForCollections } from '@/lib/repositories/pageLayersRepository';
import { getAllComponents } from '@/lib/repositories/componentRepository';
import { collectComponentIds } from '@/lib/component-utils';
import { setSetting } from '@/lib/repositories/settingsRepository';
import { getSupabaseAdmin } from '@/lib/supabase-server';

/**
 * Extract all Tailwind classes from a layer tree.
 * Replicates the client-side extractClassesFromLayers logic.
 */
function extractClassesFromLayers(layers: Layer[]): Set<string> {
  const classes = new Set<string>();
  const processedComponentIds = new Set<string>();

  const extractClasses = (classValue: string | string[] | undefined) => {
    if (!classValue) return;

    if (Array.isArray(classValue)) {
      classValue.forEach(cls => {
        if (cls && typeof cls === 'string') {
          cls.split(/\s+/).forEach(c => c.trim() && classes.add(c.trim()));
        }
      });
    } else if (typeof classValue === 'string') {
      classValue.split(/\s+/).forEach(cls => cls.trim() && classes.add(cls.trim()));
    }
  };

  function processLayer(layer: Layer): void {
    if (layer.settings?.hidden) return;

    if (layer.componentId) {
      if (processedComponentIds.has(layer.componentId)) return;
      processedComponentIds.add(layer.componentId);
    }

    extractClasses(layer.classes);

    if (layer.textStyles) {
      Object.values(layer.textStyles).forEach((style: { classes?: string | string[] }) => {
        extractClasses(style.classes);
      });
    }

    if (layer.variables?.text) {
      Object.values(DEFAULT_TEXT_STYLES).forEach(style => {
        extractClasses(style.classes);
      });
    }

    if (layer.children && Array.isArray(layer.children)) {
      layer.children.forEach(child => processLayer(child));
    }
  }

  layers.forEach(layer => processLayer(layer));
  return classes;
}

let compilerCache: { build: (candidates: string[]) => string } | null = null;

/**
 * Get or create a cached Tailwind compiler instance.
 * The compiler only needs to be created once since we always
 * use the same Tailwind config (the default).
 */
async function getCompiler() {
  if (compilerCache) return compilerCache;

  const twPath = join(process.cwd(), 'node_modules/tailwindcss/index.css');
  const baseInput = await readFile(twPath, 'utf-8');
  // Register custom variants (current:, disabled:) so user classes like
  // `current:opacity-100` on slider bullets compile — mirrors the client
  // generator and app/globals.css.
  const input = `${baseInput}\n${TAILWIND_CUSTOM_VARIANTS}\n`;

  compilerCache = await compile(input, {
    base: process.cwd(),
    async loadStylesheet(id: string, base: string) {
      const fullPath = join(dirname(base), id);
      const content = await readFile(fullPath, 'utf-8');
      return { path: fullPath, content, base: dirname(fullPath) };
    },
  });

  return compilerCache;
}

/**
 * Generate CSS from an array of Tailwind class names.
 */
async function compileCss(classNames: string[]): Promise<string> {
  if (classNames.length === 0) return '/* No classes to generate */';
  const compiler = await getCompiler();
  return compiler.build(classNames);
}

/**
 * Generate CSS from all draft layers and component layers,
 * then save it to the draft_css setting.
 *
 * This is the server-side equivalent of the client's generateAndSaveCSS.
 */
export async function generateAndSaveDraftCSS(): Promise<string> {
  const allLayers: Layer[] = [];

  const draftPageLayers = await getAllDraftLayers();
  for (const pl of draftPageLayers) {
    if (pl.layers && Array.isArray(pl.layers)) {
      allLayers.push(...pl.layers);
    }
  }

  const components: Component[] = await getAllComponents(false);
  for (const component of components) {
    // Collect classes from every variant — without this, classes that only
    // appear in non-primary variants (e.g. `bg-[#35b7d4]` on Variant 3) are
    // missing from the compiled stylesheet and the published instance renders
    // unstyled even though `resolveComponents` picks the right variant tree.
    if (component.variants && component.variants.length > 0) {
      for (const variant of component.variants) {
        if (Array.isArray(variant.layers)) allLayers.push(...variant.layers);
      }
    } else if (Array.isArray(component.layers)) {
      allLayers.push(...component.layers);
    }
  }

  const classes = extractClassesFromLayers(allLayers);
  const classNames = Array.from(classes);
  const css = await compileCss(classNames);

  await setSetting('draft_css', css);

  return css;
}

/**
 * Generate per-page CSS for a single page.
 *
 * Extracts classes from the page's draft layers and any components
 * referenced by those layers, compiles via Tailwind, and stores the
 * result in the page_layers.generated_css column. The content_hash
 * is recalculated automatically since it includes generated_css.
 */
export async function generateCSSForPage(pageId: string): Promise<string | null> {
  await generateCSSForPages([pageId]);
  // Re-read regardless of whether a write happened: an already-fresh page is
  // skipped by generateCSSForPages (no write) but still has valid CSS to return.
  const pageLayers = await getDraftLayers(pageId);
  return pageLayers?.generated_css ?? null;
}

/**
 * Generate per-page CSS for multiple pages in batch.
 * Loads components once and shares them across all pages.
 *
 * For CMS-driven (dynamic) pages, also seeds any components embedded in the
 * bound collection's rich-text field VALUES. Those components live in
 * `collection_item_values`, not in `page_layers`, so they're invisible to the
 * layer-tree walk — without seeding them their classes never compile and the
 * published instance renders unstyled.
 */
export async function generateCSSForPages(pageIds: string[]): Promise<number> {
  if (pageIds.length === 0) return 0;

  const components = await getAllComponents(false);

  // Phase 1: load each page's layers and resolve the collection(s) it binds to.
  const pageSettingsById = await getPageSettingsByIds(pageIds);
  const pageLayersById = new Map<string, PageLayersForCss>();
  const collectionIdsByPage = new Map<string, Set<string>>();
  const allCollectionIds = new Set<string>();

  for (const pageId of pageIds) {
    const pageLayers = await getDraftLayers(pageId);
    if (!pageLayers?.layers) continue;
    pageLayersById.set(pageId, pageLayers);
    const cids = collectCollectionIdsForPage(pageLayers.layers, pageSettingsById.get(pageId));
    collectionIdsByPage.set(pageId, cids);
    for (const c of cids) allCollectionIds.add(c);
  }

  // Components embedded in those collections' rich-text values, keyed by collection.
  const embeddedByCollection = allCollectionIds.size > 0
    ? await getEmbeddedComponentIdsForCollections(Array.from(allCollectionIds), false)
    : new Map<string, Set<string>>();

  // Phase 2: compile per-page CSS, seeding CMS-embedded components.
  let updated = 0;
  for (const pageId of pageIds) {
    const pageLayers = pageLayersById.get(pageId);
    if (!pageLayers) continue;

    const seedComponentIds = new Set<string>();
    for (const cid of collectionIdsByPage.get(pageId) ?? []) {
      for (const compId of embeddedByCollection.get(cid) ?? []) {
        seedComponentIds.add(compId);
      }
    }

    const layersForCss = collectLayersWithComponents(pageLayers.layers, components, seedComponentIds);
    const classes = extractClassesFromLayers(layersForCss);
    const css = await compileCss(Array.from(classes));

    // Skip the write when the compiled CSS is unchanged. This keeps publish-time
    // regeneration cheap: pages already in sync (e.g. edited in the builder)
    // compile to identical CSS, so their generated_css/content_hash/updated_at
    // stay put and they aren't needlessly republished or cache-invalidated.
    if (pageLayers.generated_css === css) continue;

    await updatePageGeneratedCss(pageId, pageLayers, css);
    updated++;
  }

  return updated;
}

type PageLayersForCss = { id: string; layers: Layer[]; generated_css?: string | null };

/**
 * Fetch draft page settings for a set of page IDs in batch.
 * Used to discover each page's CMS collection binding (`settings.cms.collection_id`).
 */
async function getPageSettingsByIds(pageIds: string[]): Promise<Map<string, unknown>> {
  const map = new Map<string, unknown>();
  if (pageIds.length === 0) return map;

  const client = await getSupabaseAdmin();
  if (!client) return map;

  const { chunk } = await import('@/lib/utils');
  for (const idChunk of chunk(pageIds, 500)) {
    const { data } = await client
      .from('pages')
      .select('id, settings')
      .in('id', idChunk)
      .eq('is_published', false)
      .is('deleted_at', null);
    for (const row of data ?? []) map.set(row.id as string, row.settings);
  }

  return map;
}

/**
 * Collect every collection a page renders content from: its dynamic-template
 * binding (`settings.cms.collection_id`) plus any collection bound to a layer
 * (collection lists / option sources). These are the collections whose
 * rich-text values may embed components that must be styled on this page.
 */
function collectCollectionIdsForPage(layers: Layer[], settings: unknown): Set<string> {
  const ids = new Set<string>();

  const cmsCollectionId = (settings as { cms?: { collection_id?: string } } | undefined)?.cms?.collection_id;
  if (cmsCollectionId) ids.add(cmsCollectionId);

  const scan = (list: Layer[]) => {
    for (const layer of list) {
      const boundCollectionId = (layer as { variables?: { collection?: { id?: string } } }).variables?.collection?.id;
      if (boundCollectionId) ids.add(boundCollectionId);
      const optionsCollectionId = (layer as { settings?: { optionsSource?: { collectionId?: string } } }).settings?.optionsSource?.collectionId;
      if (optionsCollectionId) ids.add(optionsCollectionId);
      if (layer.children && layer.children.length > 0) scan(layer.children);
    }
  };
  scan(layers);

  return ids;
}

/**
 * Collect a page's layers plus the layers of any components it references.
 * This ensures the per-page CSS includes all classes needed to render
 * component instances on that page.
 *
 * Component references are discovered via `collectComponentIds`, which finds
 * both direct instances (`layer.componentId`) AND components embedded inside
 * rich-text content (`richTextComponent` nodes in `variables.text.data.content`)
 * and component override text values. Without the rich-text discovery, a
 * component used only inside a Rich Text block would be missing from the
 * page's per-page CSS — its (changed) classes would never compile, so a style
 * update on that component wouldn't render on the published page.
 *
 * Expansion is iterative (BFS) so transitively nested components — and
 * components embedded in rich text at any depth — are all included.
 */
function collectLayersWithComponents(
  pageLayers: Layer[],
  components: Component[],
  seedComponentIds?: Iterable<string>,
): Layer[] {
  const result: Layer[] = [...pageLayers];
  const componentMap = new Map(components.map(c => [c.id, c]));
  const visitedComponentIds = new Set<string>();

  const layerGroupsForComponent = (component: Component): Layer[][] => {
    if (component.variants && component.variants.length > 0) {
      return component.variants.map(v => v.layers ?? []);
    }
    return component.layers ? [component.layers] : [];
  };

  const frontier: Layer[][] = [pageLayers];

  // Visit a component id once: pull its layers into the result and queue them
  // for further expansion (so nested components are discovered too).
  const visitComponentId = (id: string) => {
    if (visitedComponentIds.has(id)) return;
    visitedComponentIds.add(id);
    const component = componentMap.get(id);
    if (!component) return;
    for (const group of layerGroupsForComponent(component)) {
      result.push(...group);
      frontier.push(group);
    }
  };

  // Seed components that aren't reachable from the page's layer tree — i.e.
  // components embedded in CMS rich-text field values rendered by this page.
  if (seedComponentIds) {
    for (const id of seedComponentIds) visitComponentId(id);
  }

  // BFS over layer trees: each pass collects every component id referenced
  // within the current trees (direct + rich-text-embedded), then queues the
  // referenced components' own layers for the next pass.
  while (frontier.length > 0) {
    const layers = frontier.shift()!;
    for (const id of collectComponentIds(layers)) {
      visitComponentId(id);
    }
  }

  return result;
}

/**
 * Write generated_css to the draft page_layers row and recalculate its
 * content_hash so that publish-time hash comparison reflects CSS changes.
 */
async function updatePageGeneratedCss(
  pageId: string,
  pageLayers: { id: string; layers: Layer[] },
  css: string,
): Promise<void> {
  const { generatePageLayersHash } = await import('@/lib/hash-utils');
  const client = await getSupabaseAdmin();
  if (!client) return;

  const contentHash = generatePageLayersHash({
    layers: pageLayers.layers,
    generated_css: css,
  });

  await client
    .from('page_layers')
    .update({
      generated_css: css,
      content_hash: contentHash,
      updated_at: new Date().toISOString(),
    })
    .eq('id', pageLayers.id)
    .eq('is_published', false);
}

'use client';

/**
 * Canvas asset sync
 *
 * When layers arrive from a remote source (the in-app AI, external MCP, or a
 * collaborator), they may reference assets the AI just uploaded that the editor
 * has never seen. The assets store only preloads assets at page load, so those
 * images render as placeholders until a full refresh.
 *
 * This helper closes that gap: it pulls every asset id referenced by the
 * incoming layers, fetches the ones missing from the cache, and inserts them so
 * the canvas resolves the image immediately (LayerRenderer subscribes to
 * `assetsById`, so the placeholder swaps to the real image on the next render).
 */

import { useAssetsStore } from '@/stores/useAssetsStore';
import type { Asset, Layer } from '@/types';

/**
 * Recursively find every asset id referenced anywhere in an arbitrary value.
 * Covers the two shapes assets appear in: `AssetVariable`
 * (`{ type: 'asset', data: { asset_id } }`) and link assets (`asset: { id }`).
 */
function collectAssetIds(value: unknown, out: Set<string>): void {
  if (!value || typeof value !== 'object') return;

  if (Array.isArray(value)) {
    for (const item of value) collectAssetIds(item, out);
    return;
  }

  const obj = value as Record<string, unknown>;

  if (obj.type === 'asset' && obj.data && typeof obj.data === 'object') {
    const id = (obj.data as Record<string, unknown>).asset_id;
    if (typeof id === 'string') out.add(id);
  }

  const asset = obj.asset as Record<string, unknown> | undefined;
  if (asset && typeof asset === 'object' && typeof asset.id === 'string') {
    out.add(asset.id);
  }

  for (const key of Object.keys(obj)) {
    if (key.startsWith('_')) continue; // skip SSR-only resolved data
    collectAssetIds(obj[key], out);
  }
}

// Asset ids currently being fetched, so concurrent broadcasts don't request the
// same asset twice. Cleared once the request settles.
const inFlight = new Set<string>();

/**
 * Ensure every asset referenced by `layers` is present in the assets cache,
 * fetching any that are missing. Fire-and-forget — safe to call on every remote
 * layer update; it no-ops when there is nothing new to load.
 */
export async function syncLayerAssets(layers: Layer[]): Promise<void> {
  if (typeof window === 'undefined' || layers.length === 0) return;

  const referenced = new Set<string>();
  collectAssetIds(layers, referenced);
  if (referenced.size === 0) return;

  const { assetsById } = useAssetsStore.getState();
  const missing = [...referenced].filter((id) => !assetsById[id] && !inFlight.has(id));
  if (missing.length === 0) return;

  missing.forEach((id) => inFlight.add(id));

  const results = await Promise.all(
    missing.map(async (id) => {
      try {
        const res = await fetch(`/ycode/api/assets/${id}`);
        if (!res.ok) return null;
        const json = await res.json();
        return (json?.data as Asset) ?? null;
      } catch {
        return null;
      } finally {
        inFlight.delete(id);
      }
    }),
  );

  const fetched = results.filter((asset): asset is Asset => asset !== null);
  if (fetched.length > 0) {
    useAssetsStore.getState().addAssetsToCache(fetched);
  }
}

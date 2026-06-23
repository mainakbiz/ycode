import { isValidUUID } from '@/lib/utils';

/**
 * Walk arbitrary JSON (e.g. Tiptap rich-text or link field values) and collect
 * embedded asset IDs. Asset-bearing nodes expose their id as `attrs.assetId`.
 */
function collectEmbeddedAssetIds(rawValue: string, out: Set<string>): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawValue);
  } catch {
    return;
  }

  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const assetId = (node as { attrs?: { assetId?: unknown } }).attrs?.assetId;
    if (typeof assetId === 'string' && isValidUUID(assetId)) out.add(assetId);
    const content = (node as { content?: unknown }).content;
    if (Array.isArray(content)) content.forEach(walk);
  };

  walk(parsed);
}

/**
 * Collect candidate asset IDs referenced by collection item values, so they can
 * be published alongside the items. Covers direct asset fields (image/file/video/
 * audio — stored as a bare UUID) and assets embedded in rich-text/link content.
 *
 * Non-asset UUIDs (e.g. reference fields) are harmless: the caller passes these
 * to `publishAssets`, which only acts on IDs matching an unpublished draft asset.
 */
export function collectItemValueAssetIds(values: Array<{ value: string | null }>): string[] {
  const assetIds = new Set<string>();

  for (const { value } of values) {
    if (!value) continue;
    if (isValidUUID(value)) {
      assetIds.add(value);
    } else {
      collectEmbeddedAssetIds(value, assetIds);
    }
  }

  return Array.from(assetIds);
}

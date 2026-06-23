/**
 * Collection Publishing Service
 *
 * Dedicated service for publishing collections using composite key architecture.
 * Provides transactional publishing with rollback capability.
 *
 * Key Features:
 * - Collections & Fields: Always published completely
 * - Items: Selective publishing (user can choose specific items)
 * - Values: Published automatically with their items
 * - Transactional: All-or-nothing approach with error handling
 */

import { withTransaction } from '../database/transaction';
import { getSupabaseAdmin, getTenantIdFromHeaders } from '@/lib/supabase-server';
import { getKnexClient } from '@/lib/knex-client';
import { SUPABASE_IN_FILTER_CHUNK_SIZE, SUPABASE_WRITE_BATCH_SIZE } from '@/lib/supabase-constants';
import { getCollectionById, hardDeleteCollection } from '@/lib/repositories/collectionRepository';
import { getFieldsByCollectionId } from '@/lib/repositories/collectionFieldRepository';
import { getItemsByCollectionId, getAllItemsByCollectionId, getItemsByIds } from '@/lib/repositories/collectionItemRepository';
import { getValueRowsForItems, type PublishValueRow } from '@/lib/repositories/collectionItemValueRepository';
import { publishAssets } from '@/lib/repositories/assetRepository';
import { collectItemValueAssetIds } from '@/lib/collection-asset-utils';
import type { Collection, CollectionField, CollectionItem } from '@/types';

/**
 * Pre-fetched collection data, batched across all collections by the caller to
 * avoid per-collection metadata/field/item round-trips during a full publish.
 */
export interface CollectionPrefetch {
  draftCollection: Collection;
  publishedCollection: Collection | null;
  draftFields: CollectionField[];
  publishedFields: CollectionField[];
  draftItems: CollectionItem[];
  publishedItems: CollectionItem[];
}

/**
 * Options for publishing a collection
 */
export interface PublishCollectionOptions {
  collectionId: string;
  itemIds?: string[]; // Optional: specific items to publish. If omitted, publish all
  // Skip the per-item existence/ownership validation. Safe when itemIds were
  // just derived from the collection itself (e.g. the publish-all path), where
  // re-reading every item only to confirm it exists is redundant overhead.
  skipItemValidation?: boolean;
  // Collection metadata/fields pre-fetched in bulk by the caller. When provided,
  // the per-collection getCollectionById / getFieldsByCollectionId reads are
  // skipped entirely (the dominant cost of a full multi-collection publish).
  prefetched?: CollectionPrefetch;
  // Skip the soft-delete cleanup probes. Safe when the caller has already
  // determined (via a global query) that this collection has no soft-deleted
  // draft items or fields — avoids two per-collection detection round-trips.
  skipDeletionCleanup?: boolean;
}

/**
 * Timing stats for an operation
 */
export interface OperationTiming {
  durationMs: number;
  count: number;
}

/**
 * Result of a collection publishing operation
 */
export interface PublishCollectionResult {
  success: boolean;
  collectionId: string;
  published: {
    collection: boolean;
    fieldsCount: number;
    itemsCount: number;
    valuesCount: number;
    assetsCount: number;
    deletedItemsCount: number;
    deletedItemSlugs: string[];
    renamedItemOldSlugs: string[];
    unpublishedItemSlugs: string[];
  };
  timing?: {
    collections: OperationTiming;
    fields: OperationTiming;
    items: OperationTiming;
    values: OperationTiming;
  };
  errors?: string[];
}

/**
 * Batch publishing options
 */
export interface BatchPublishOptions {
  publishes: PublishCollectionOptions[];
}

/**
 * Batch publishing result
 */
export interface BatchPublishResult {
  results: PublishCollectionResult[];
  summary: {
    total: number;
    succeeded: number;
    failed: number;
  };
}

/**
 * Main entry point: Publish a single collection with optional item selection
 *
 * @param options - Publishing options
 * @returns Publishing result with counts and status
 *
 * @example
 * // Publish entire collection (all items)
 * const result = await publishCollection({ collectionId: 'abc-123' });
 *
 * // Publish collection with specific items only
 * const result = await publishCollection({
 *   collectionId: 'abc-123',
 *   itemIds: ['item-1', 'item-2', 'item-3']
 * });
 */
export async function publishCollectionWithItems(
  options: PublishCollectionOptions
): Promise<PublishCollectionResult> {
  const { collectionId, itemIds, skipItemValidation, prefetched, skipDeletionCleanup } = options;

  const result: PublishCollectionResult = {
    success: false,
    collectionId,
    published: {
      collection: false,
      fieldsCount: 0,
      itemsCount: 0,
      valuesCount: 0,
      assetsCount: 0,
      deletedItemsCount: 0,
      deletedItemSlugs: [],
      renamedItemOldSlugs: [],
      unpublishedItemSlugs: [],
    },
    timing: {
      collections: { durationMs: 0, count: 0 },
      fields: { durationMs: 0, count: 0 },
      items: { durationMs: 0, count: 0 },
      values: { durationMs: 0, count: 0 },
    },
    errors: [],
  };

  try {
    // Check if the draft collection is soft-deleted (include deleted collections in query).
    // When prefetched, the caller already filtered out deleted collections, so the
    // bulk-fetched draft is guaranteed non-deleted — no extra round-trip needed.
    const draftCollection = prefetched?.draftCollection
      ?? await getCollectionById(collectionId, false, true);

    // If draft is deleted, clean up both draft and published versions
    if (draftCollection && draftCollection.deleted_at) {
      await cleanupDeletedCollection(collectionId);
      result.success = true;
      return result;
    }

    // Validate the request (reuse the draft fetched above)
    await validatePublishRequest(
      collectionId,
      skipItemValidation ? undefined : itemIds,
      draftCollection ?? undefined,
    );

    // Execute publishing within transaction context
    await withTransaction(async () => {
      // Step 1: Publish collection metadata (skips if unchanged)
      const collectionStart = performance.now();
      const collectionChanged = await publishCollectionMetadata(
        collectionId,
        draftCollection ?? undefined,
        prefetched,
      );
      result.published.collection = collectionChanged;
      result.timing!.collections = {
        durationMs: Math.round(performance.now() - collectionStart),
        count: collectionChanged ? 1 : 0,
      };

      // Step 2: Publish all fields
      const fieldsStart = performance.now();
      const fieldsCount = await publishAllFields(collectionId, prefetched);
      result.published.fieldsCount = fieldsCount;
      result.timing!.fields = {
        durationMs: Math.round(performance.now() - fieldsStart),
        count: fieldsCount,
      };

      // Step 3: Publish selected items
      const itemsStart = performance.now();
      const { itemsCount, valuesCount, assetsCount, itemsDurationMs, valuesDurationMs, renamedItemOldSlugs, unpublishedItemSlugs } = await publishSelectedItems(
        collectionId,
        itemIds,
        prefetched,
      );
      result.published.itemsCount = itemsCount;
      result.published.valuesCount = valuesCount;
      result.published.assetsCount = assetsCount;
      result.published.renamedItemOldSlugs = renamedItemOldSlugs;
      result.published.unpublishedItemSlugs = unpublishedItemSlugs;
      result.timing!.items = {
        durationMs: itemsDurationMs,
        count: itemsCount,
      };
      result.timing!.values = {
        durationMs: valuesDurationMs,
        count: valuesCount,
      };

      // Step 4: Clean up soft-deleted items/fields in the published version.
      // Skipped when the caller has globally confirmed there's nothing to clean.
      if (!skipDeletionCleanup) {
        const cleanup = await cleanupDeletedPublishedItems(collectionId);
        result.published.deletedItemsCount = cleanup.deletedCount;
        result.published.deletedItemSlugs = cleanup.deletedSlugs;
        await cleanupDeletedPublishedFields(collectionId);
      }
    });

    result.success = true;
  } catch (error) {
    result.success = false;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    result.errors = [errorMessage];
  }

  return result;
}

/**
 * Batch publish multiple collections
 *
 * @param options - Batch publishing options
 * @returns Batch result with summary
 *
 * @example
 * const result = await publishCollections({
 *   publishes: [
 *     { collectionId: 'abc-123' }, // All items
 *     { collectionId: 'def-456', itemIds: ['item-x'] } // Specific item
 *   ]
 * });
 */
export async function publishCollections(
  options: BatchPublishOptions
): Promise<BatchPublishResult> {
  const results: PublishCollectionResult[] = [];

  // Publish each collection sequentially to avoid conflicts
  for (const publishOptions of options.publishes) {
    const result = await publishCollectionWithItems(publishOptions);
    results.push(result);
  }

  // Calculate summary
  const succeeded = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;

  return {
    results,
    summary: {
      total: results.length,
      succeeded,
      failed,
    },
  };
}

/**
 * Validate publishing request
 * Ensures collection exists and item IDs are valid
 */
async function validatePublishRequest(
  collectionId: string,
  itemIds?: string[],
  prefetchedDraft?: Collection,
): Promise<void> {
  // Check if draft collection exists (reuse caller's fetch when available)
  const draftCollection = prefetchedDraft ?? await getCollectionById(collectionId, false);
  if (!draftCollection) {
    throw new Error(`Draft collection ${collectionId} not found`);
  }

  // If specific item IDs provided, validate they exist (batch fetch)
  if (itemIds && itemIds.length > 0) {
    const items = await getItemsByIds(itemIds, false);
    const foundIds = new Set(items.map(item => item.id));

    for (const itemId of itemIds) {
      if (!foundIds.has(itemId)) {
        throw new Error(`Draft item ${itemId} not found`);
      }
    }

    // Validate all items belong to the collection
    for (const item of items) {
      if (item.collection_id !== collectionId) {
        throw new Error(`Item ${item.id} does not belong to collection ${collectionId}`);
      }
    }
  }
}

/**
 * Publish collection metadata, skipping if unchanged
 * @returns true if collection was actually upserted
 */
async function publishCollectionMetadata(
  collectionId: string,
  prefetchedDraft?: Collection,
  prefetched?: CollectionPrefetch,
): Promise<boolean> {
  const client = await getSupabaseAdmin();

  if (!client) {
    throw new Error('Supabase not configured');
  }

  // Reuse the draft already fetched by the caller when available to avoid a
  // redundant per-collection round-trip.
  const draft = prefetchedDraft ?? prefetched?.draftCollection ?? await getCollectionById(collectionId, false);
  if (!draft) {
    throw new Error('Draft collection not found');
  }

  // Get existing published version for comparison (use the bulk-fetched copy when available)
  const published = prefetched ? prefetched.publishedCollection : await getCollectionById(collectionId, true);

  // Skip if published version exists and all fields match
  if (published &&
    published.name === draft.name &&
    JSON.stringify(published.sorting) === JSON.stringify(draft.sorting) &&
    published.order === draft.order) {
    return false;
  }

  // Upsert published version (composite key handles insert/update automatically)
  const { error } = await client
    .from('collections')
    .upsert({
      id: draft.id,
      name: draft.name,
      sorting: draft.sorting,
      order: draft.order,
      is_published: true,
      created_at: draft.created_at,
      updated_at: new Date().toISOString(),
    }, {
      onConflict: 'id,is_published',
    });

  if (error) {
    throw new Error(`Failed to publish collection: ${error.message}`);
  }

  return true;
}

/**
 * Publish all fields for a collection, skipping unchanged fields
 * Uses batch upsert for efficiency
 *
 * @returns Number of fields actually published
 */
async function publishAllFields(
  collectionId: string,
  prefetched?: CollectionPrefetch,
): Promise<number> {
  const client = await getSupabaseAdmin();

  if (!client) {
    throw new Error('Supabase not configured');
  }

  // Get all draft fields (use bulk-fetched copy when available)
  const draftFields = prefetched?.draftFields ?? await getFieldsByCollectionId(collectionId, false);

  if (draftFields.length === 0) {
    return 0;
  }

  // Get published fields for comparison (use bulk-fetched copy when available)
  const publishedFields = prefetched?.publishedFields ?? await getFieldsByCollectionId(collectionId, true);
  const publishedById = new Map(publishedFields.map(f => [f.id, f]));

  // Only upsert fields that are new or changed
  const now = new Date().toISOString();
  const fieldsToUpsert: any[] = [];

  for (const field of draftFields) {
    const existing = publishedById.get(field.id);

    // Skip if published version exists and is identical
    if (
      existing &&
      existing.name === field.name &&
      existing.key === field.key &&
      existing.type === field.type &&
      existing.default === field.default &&
      existing.fillable === field.fillable &&
      existing.order === field.order &&
      existing.reference_collection_id === field.reference_collection_id &&
      existing.hidden === field.hidden &&
      existing.is_computed === field.is_computed &&
      JSON.stringify(existing.data) === JSON.stringify(field.data)
    ) {
      continue;
    }

    fieldsToUpsert.push({
      id: field.id,
      name: field.name,
      key: field.key,
      type: field.type,
      default: field.default,
      fillable: field.fillable,
      order: field.order,
      collection_id: field.collection_id,
      reference_collection_id: field.reference_collection_id,
      hidden: field.hidden,
      is_computed: field.is_computed,
      data: field.data,
      is_published: true,
      created_at: field.created_at,
      updated_at: now,
    });
  }

  if (fieldsToUpsert.length === 0) {
    return 0;
  }

  // Batch upsert changed fields
  const { error } = await client
    .from('collection_fields')
    .upsert(fieldsToUpsert, {
      onConflict: 'id,is_published', // Composite primary key
    });

  if (error) {
    throw new Error(`Failed to publish fields: ${error.message}`);
  }

  return fieldsToUpsert.length;
}

/**
 * Publish selected items and their values
 * Uses batch upsert for efficiency
 *
 * @param collectionId - Collection UUID
 * @param itemIds - Optional array of item IDs to publish. If omitted, publishes all items that need publishing
 * @returns Counts and timing of published items, values, and referenced assets
 */
async function publishSelectedItems(
  collectionId: string,
  itemIds?: string[],
  prefetched?: CollectionPrefetch,
): Promise<{ itemsCount: number; valuesCount: number; assetsCount: number; itemsDurationMs: number; valuesDurationMs: number; renamedItemOldSlugs: string[]; unpublishedItemSlugs: string[] }> {
  const client = await getSupabaseAdmin();

  if (!client) {
    throw new Error('Supabase not configured');
  }

  let itemsToPublish: string[];

  if (itemIds && itemIds.length > 0) {
    // Publish specific items
    itemsToPublish = itemIds;
  } else {
    // Publish all items that need publishing
    itemsToPublish = await getUnpublishedItemIds(collectionId);
  }

  if (itemsToPublish.length === 0) {
    return { itemsCount: 0, valuesCount: 0, assetsCount: 0, itemsDurationMs: 0, valuesDurationMs: 0, renamedItemOldSlugs: [], unpublishedItemSlugs: [] };
  }

  // Batch fetch all draft items to publish. When the caller bulk-prefetched the
  // collection's draft items, filter that set in memory instead of re-reading.
  const draftItems = prefetched
    ? (() => {
      const toPublish = new Set(itemsToPublish);
      return prefetched.draftItems.filter(i => toPublish.has(i.id));
    })()
    : await getItemsByIds(itemsToPublish, false);

  if (draftItems.length === 0) {
    return { itemsCount: 0, valuesCount: 0, assetsCount: 0, itemsDurationMs: 0, valuesDurationMs: 0, renamedItemOldSlugs: [], unpublishedItemSlugs: [] };
  }

  // Separate publishable from non-publishable items
  const publishableItems = draftItems.filter(item => item.is_publishable);
  const nonPublishableItems = draftItems.filter(item => !item.is_publishable);

  // Remove published versions of non-publishable items. Snapshot their published
  // slugs first so the publish route can invalidate the now-dead URLs — without
  // this the CDN keeps serving the unpublished page as a 200 (cache never
  // expires under revalidate: false).
  const unpublishedItemSlugs: string[] = [];
  if (nonPublishableItems.length > 0) {
    const nonPublishableIds = nonPublishableItems.map(item => item.id);

    try {
      const slugField = prefetched
        ? prefetched.draftFields.find(f => f.key === 'slug') ?? null
        : (await client
          .from('collection_fields')
          .select('id')
          .eq('collection_id', collectionId)
          .eq('key', 'slug')
          .is('deleted_at', null)
          .limit(1)
          .single()).data;

      if (slugField) {
        for (let i = 0; i < nonPublishableIds.length; i += 500) {
          const batch = nonPublishableIds.slice(i, i + 500);
          const { data } = await client
            .from('collection_item_values')
            .select('value')
            .eq('field_id', slugField.id)
            .eq('is_published', true)
            .is('deleted_at', null)
            .in('item_id', batch);
          if (data) unpublishedItemSlugs.push(...data.map(v => v.value as string).filter(Boolean));
        }
      }
    } catch {
      // Non-fatal: proceed with unpublish even if the slug snapshot fails
    }

    for (let i = 0; i < nonPublishableIds.length; i += SUPABASE_IN_FILTER_CHUNK_SIZE) {
      const idsChunk = nonPublishableIds.slice(i, i + SUPABASE_IN_FILTER_CHUNK_SIZE);
      await client
        .from('collection_items')
        .delete()
        .in('id', idsChunk)
        .eq('is_published', true);
    }
  }

  if (publishableItems.length === 0) {
    return { itemsCount: 0, valuesCount: 0, assetsCount: 0, itemsDurationMs: 0, valuesDurationMs: 0, renamedItemOldSlugs: [], unpublishedItemSlugs };
  }

  // Fetch existing published items for comparison (use bulk-prefetched set when available)
  const publishableIds = publishableItems.map(i => i.id);
  const publishableIdSet = new Set(publishableIds);
  const publishedItems = prefetched
    ? prefetched.publishedItems.filter(i => publishableIdSet.has(i.id))
    : await getItemsByIds(publishableIds, true);
  const publishedItemsById = new Map(publishedItems.map(i => [i.id, i]));

  // Time items upsert
  const itemsStart = performance.now();

  // Only upsert items that are new or changed
  const now = new Date().toISOString();
  const itemsToUpsert: any[] = [];
  const itemIdsToPublishValues: string[] = [];

  for (const item of publishableItems) {
    const existing = publishedItemsById.get(item.id);

    // Only compare content_hash when both sides have a value — null draft
    // hashes (pre-backfill items) would otherwise always appear "changed."
    // Value-level comparison in publishItemValuesBatch catches real changes.
    const hashChanged = item.content_hash != null
      && existing?.content_hash != null
      && existing.content_hash !== item.content_hash;

    const metadataChanged = !existing
      || existing.manual_order !== item.manual_order
      || existing.is_publishable !== item.is_publishable
      || hashChanged;

    if (!metadataChanged) {
      itemIdsToPublishValues.push(item.id);
      continue;
    }

    itemsToUpsert.push({
      id: item.id,
      collection_id: item.collection_id,
      manual_order: item.manual_order,
      is_publishable: item.is_publishable,
      is_published: true,
      content_hash: item.content_hash,
      created_at: item.created_at,
      updated_at: now,
    });
    itemIdsToPublishValues.push(item.id);
  }

  // Batch upsert changed items only
  if (itemsToUpsert.length > 0) {
    const { error: itemsError } = await client
      .from('collection_items')
      .upsert(itemsToUpsert, {
        onConflict: 'id,is_published', // Composite primary key
      });

    if (itemsError) {
      throw new Error(`Failed to publish items: ${itemsError.message}`);
    }
  }

  const itemsDurationMs = Math.round(performance.now() - itemsStart);

  // Fetch draft + published values once and reuse them for BOTH slug-rename
  // detection and value publishing — avoids two extra slug-only queries per
  // collection that read the same collection_item_values table.
  const valuesStart = performance.now();
  const [draftValues, publishedValues] = await Promise.all([
    getValueRowsForItems(itemIdsToPublishValues, false),
    getValueRowsForItems(itemIdsToPublishValues, true),
  ]);

  // Snapshot old published slug values before overwriting (for rename detection)
  const renamedItemOldSlugs: string[] = [];
  try {
    // Resolve the slug field from prefetched draft fields when available to skip a round-trip.
    const slugField = prefetched
      ? prefetched.draftFields.find(f => f.key === 'slug') ?? null
      : (await client
        .from('collection_fields')
        .select('id')
        .eq('collection_id', collectionId)
        .eq('key', 'slug')
        .is('deleted_at', null)
        .limit(1)
        .single()).data;

    if (slugField) {
      const slugId = slugField.id;
      const oldByItem = new Map(
        publishedValues.filter(v => v.field_id === slugId).map(v => [v.item_id, v.value as string])
      );
      const newByItem = new Map(
        draftValues.filter(v => v.field_id === slugId).map(v => [v.item_id, v.value as string])
      );

      for (const [itemId, oldSlug] of oldByItem) {
        const newSlug = newByItem.get(itemId);
        if (oldSlug && newSlug && oldSlug !== newSlug) {
          renamedItemOldSlugs.push(oldSlug);
        }
      }
    }
  } catch {
    // Non-fatal: slug rename detection failure doesn't block publish
  }

  // Publish values using the already-fetched draft/published value sets
  const valuesCount = await publishItemValuesBatch(itemIdsToPublishValues, draftValues, publishedValues);
  const valuesDurationMs = Math.round(performance.now() - valuesStart);

  // Publish assets referenced by the published items so newly uploaded images
  // (e.g. CMS thumbnails or rich-text images) get a published row in the same
  // operation. Without this, a single collection/item publish leaves the assets
  // as drafts and the live page renders the default placeholder until a later
  // full publish eventually publishes them.
  let assetsCount = 0;
  try {
    const assetIds = collectItemValueAssetIds(draftValues);
    if (assetIds.length > 0) {
      const assetsResult = await publishAssets(assetIds);
      assetsCount = assetsResult.count;
    }
  } catch {
    // Non-fatal: asset publishing failure should not roll back item publishing
  }

  return { itemsCount: itemsToUpsert.length, valuesCount, assetsCount, itemsDurationMs, valuesDurationMs, renamedItemOldSlugs, unpublishedItemSlugs };
}

/**
 * Publish values for multiple items in batch, skipping unchanged values
 * Compares draft vs published by (id, field_id, value) before upserting
 *
 * @param itemIds - Array of item UUIDs
 * @returns Number of values actually published (changed)
 */
async function publishItemValuesBatch(
  itemIds: string[],
  prefetchedDraftValues?: PublishValueRow[],
  prefetchedPublishedValues?: PublishValueRow[],
): Promise<number> {
  const client = await getSupabaseAdmin();

  if (!client) {
    throw new Error('Supabase not configured');
  }

  if (itemIds.length === 0) {
    return 0;
  }

  const now = new Date().toISOString();

  // Reuse the caller's value sets when provided, otherwise fetch every draft and
  // published value for these items in two direct-DB (Knex) queries instead of
  // paginated PostgREST reads batched per 50 items. This collapses thousands of
  // round-trips into two, the dominant cost of a full publish on large collections.
  const [draftValues, publishedValues] = prefetchedDraftValues && prefetchedPublishedValues
    ? [prefetchedDraftValues, prefetchedPublishedValues]
    : await Promise.all([
      getValueRowsForItems(itemIds, false),
      getValueRowsForItems(itemIds, true),
    ]);

  const publishedById = new Map(publishedValues.map(v => [v.id, v.value]));

  const valuesToUpsert: Array<{
    id: string;
    item_id: string;
    field_id: string;
    value: string | null;
    is_published: boolean;
    created_at: string;
    updated_at: string;
  }> = [];

  for (const value of draftValues) {
    if (publishedById.has(value.id) && publishedById.get(value.id) === value.value) {
      continue;
    }

    valuesToUpsert.push({
      id: value.id,
      item_id: value.item_id,
      field_id: value.field_id,
      value: value.value,
      is_published: true,
      created_at: value.created_at,
      updated_at: now,
    });
  }

  // Upsert in chunks within PostgREST payload limits
  for (let j = 0; j < valuesToUpsert.length; j += SUPABASE_WRITE_BATCH_SIZE) {
    const chunk = valuesToUpsert.slice(j, j + SUPABASE_WRITE_BATCH_SIZE);
    const { error } = await client
      .from('collection_item_values')
      .upsert(chunk, {
        onConflict: 'id,is_published',
      });

    if (error) {
      console.error(`[PUBLISH:VALUES] Value upsert failed:`, error.message);
      throw new Error(`Failed to publish item values: ${error.message}`);
    }
  }

  return valuesToUpsert.length;
}

/**
 * Get list of item IDs that need publishing
 * An item needs publishing if:
 * - Published version doesn't exist, OR
 * - Draft data differs from published data
 */
async function getUnpublishedItemIds(collectionId: string): Promise<string[]> {
  // Get all draft items for this collection (with pagination for >1000 items)
  const draftItems = await getAllItemsByCollectionId(collectionId, false);

  if (draftItems.length === 0) {
    return [];
  }

  // Batch-fetch published items once instead of one lookup per draft item.
  const draftIds = draftItems.map(i => i.id);
  const publishedItems = await getItemsByIds(draftIds, true);
  const publishedById = new Map(publishedItems.map(i => [i.id, i]));

  const unpublishedItemIds: string[] = [];
  const itemsNeedingValueCheck: string[] = [];

  for (const draftItem of draftItems) {
    const publishedItem = publishedById.get(draftItem.id);

    if (!publishedItem) {
      // Never published
      unpublishedItemIds.push(draftItem.id);
      continue;
    }

    if (draftItem.manual_order !== publishedItem.manual_order) {
      unpublishedItemIds.push(draftItem.id);
      continue;
    }

    // Metadata matches — defer to a batched value comparison.
    itemsNeedingValueCheck.push(draftItem.id);
  }

  if (itemsNeedingValueCheck.length > 0) {
    const changed = await itemsWithValueChanges(itemsNeedingValueCheck);
    unpublishedItemIds.push(...changed);
  }

  return unpublishedItemIds;
}

/**
 * Return the IDs of items whose draft values differ from published, comparing
 * by (field_id → value). Batches value reads to avoid a per-item N+1.
 */
async function itemsWithValueChanges(itemIds: string[]): Promise<string[]> {
  if (itemIds.length === 0) return [];

  const changed: string[] = [];

  const groupByItem = (rows: PublishValueRow[]): Map<string, Map<string, string | null>> => {
    const map = new Map<string, Map<string, string | null>>();
    for (const row of rows) {
      if (!map.has(row.item_id)) map.set(row.item_id, new Map());
      map.get(row.item_id)!.set(row.field_id, row.value);
    }
    return map;
  };

  // Two direct-DB reads for the whole set rather than paginated PostgREST
  // batches of 50 items.
  const [draftRows, publishedRows] = await Promise.all([
    getValueRowsForItems(itemIds, false),
    getValueRowsForItems(itemIds, true),
  ]);

  const draftByItem = groupByItem(draftRows);
  const publishedByItem = groupByItem(publishedRows);

  for (const id of itemIds) {
    const draftVals = draftByItem.get(id) || new Map<string, string | null>();
    const pubVals = publishedByItem.get(id) || new Map<string, string | null>();

    if (draftVals.size !== pubVals.size) {
      changed.push(id);
      continue;
    }

    let hasChange = false;
    for (const [fieldId, draftValue] of draftVals) {
      if (!pubVals.has(fieldId) || pubVals.get(fieldId) !== draftValue) {
        hasChange = true;
        break;
      }
    }

    if (hasChange) {
      changed.push(id);
    }
  }

  return changed;
}

/**
 * Clean up soft-deleted items in both draft and published versions.
 * Snapshots published slug values before deletion so the caller can
 * invalidate stale cached dynamic-page URLs.
 *
 * @returns Number of deleted items and their former published slug values
 */
async function cleanupDeletedPublishedItems(
  collectionId: string,
): Promise<{ deletedCount: number; deletedSlugs: string[] }> {
  const client = await getSupabaseAdmin();

  if (!client) {
    throw new Error('Supabase client not configured');
  }

  const deletedDraftItems = await getAllItemsByCollectionId(
    collectionId,
    false,
    true // Only deleted items
  );

  if (deletedDraftItems.length === 0) {
    return { deletedCount: 0, deletedSlugs: [] };
  }

  const deletedItemIds = deletedDraftItems.map(item => item.id);

  // Snapshot published slug values before deletion (for cache invalidation)
  let deletedSlugs: string[] = [];
  try {
    const { data: slugField } = await client
      .from('collection_fields')
      .select('id')
      .eq('collection_id', collectionId)
      .eq('key', 'slug')
      .is('deleted_at', null)
      .limit(1)
      .single();

    if (slugField) {
      const allSlugValues: Array<{ value: unknown }> = [];
      for (let i = 0; i < deletedItemIds.length; i += 500) {
        const batch = deletedItemIds.slice(i, i + 500);
        const { data } = await client
          .from('collection_item_values')
          .select('value')
          .eq('field_id', slugField.id)
          .eq('is_published', true)
          .is('deleted_at', null)
          .in('item_id', batch);
        if (data) allSlugValues.push(...data);
      }

      deletedSlugs = allSlugValues
        .map(sv => sv.value as string)
        .filter(Boolean);
    }
  } catch {
    // Non-fatal: proceed with deletion even if slug snapshot fails
  }

  // Batch hard delete published versions (CASCADE will delete values)
  for (let i = 0; i < deletedItemIds.length; i += 500) {
    const batch = deletedItemIds.slice(i, i + 500);
    await client
      .from('collection_items')
      .delete()
      .in('id', batch)
      .eq('is_published', true);
  }

  // Batch hard delete draft versions (CASCADE will delete values)
  for (let i = 0; i < deletedItemIds.length; i += 500) {
    const batch = deletedItemIds.slice(i, i + 500);
    await client
      .from('collection_items')
      .delete()
      .in('id', batch)
      .eq('is_published', false);
  }

  return { deletedCount: deletedItemIds.length, deletedSlugs };
}

/**
 * Clean up soft-deleted fields in both draft and published versions
 * Uses batch DELETE for efficiency
 * If a draft field is soft-deleted, permanently remove both draft and published versions
 * This also removes all associated collection_item_values via CASCADE
 */
async function cleanupDeletedPublishedFields(collectionId: string): Promise<void> {
  // Get all fields (including soft-deleted) from draft by querying directly
  const client = await getSupabaseAdmin();

  if (!client) {
    throw new Error('Supabase client not configured');
  }

  // Query for soft-deleted draft fields
  const { data: deletedDraftFields, error } = await client
    .from('collection_fields')
    .select('*')
    .eq('collection_id', collectionId)
    .eq('is_published', false)
    .not('deleted_at', 'is', null); // Only get deleted fields

  if (error || !deletedDraftFields || deletedDraftFields.length === 0) {
    return;
  }

  // Extract field IDs
  const deletedFieldIds = deletedDraftFields.map(field => field.id);

  // Batch hard delete published versions (CASCADE will delete values)
  await client
    .from('collection_fields')
    .delete()
    .in('id', deletedFieldIds)
    .eq('is_published', true);

  // Batch hard delete draft versions (CASCADE will delete values)
  await client
    .from('collection_fields')
    .delete()
    .in('id', deletedFieldIds)
    .eq('is_published', false);
}

/**
 * Clean up a soft-deleted collection and all its related data
 * Hard deletes both draft and published versions of the collection
 * CASCADE constraints will automatically delete all related fields, items, and values
 */
async function cleanupDeletedCollection(collectionId: string): Promise<void> {
  // Check if published version exists
  const publishedCollection = await getCollectionById(collectionId, true);

  if (publishedCollection) {
    // Hard delete the published version (CASCADE will delete all related data)
    await hardDeleteCollection(collectionId, true);
  }

  // Hard delete the draft version (CASCADE will delete all related data)
  await hardDeleteCollection(collectionId, false);
}

/**
 * Return the set of collection IDs that have at least one soft-deleted draft row
 * in the given table. Lets a bulk publish run the per-collection cleanup probes
 * only where they're actually needed, instead of once per collection.
 */
async function getCollectionIdsWithDeletedDrafts(
  table: 'collection_items' | 'collection_fields',
): Promise<Set<string>> {
  try {
    const knex = await getKnexClient();
    const tenantId = await getTenantIdFromHeaders();
    let query = knex(table)
      .distinct('collection_id')
      .where('is_published', false)
      .whereNotNull('deleted_at');
    if (tenantId) {
      query = query.where('tenant_id', tenantId);
    }
    const rows = await query;
    return new Set(rows.map((r: { collection_id: string }) => r.collection_id));
  } catch {
    const client = await getSupabaseAdmin();
    if (!client) throw new Error('Supabase client not configured');
    const { data, error } = await client
      .from(table)
      .select('collection_id')
      .eq('is_published', false)
      .not('deleted_at', 'is', null);
    if (error) throw new Error(`Failed to detect deleted drafts: ${error.message}`);
    return new Set((data || []).map(r => r.collection_id));
  }
}

/**
 * Collection IDs that need deletion cleanup during a bulk publish — the union of
 * collections with soft-deleted draft items or fields.
 */
export async function getCollectionsNeedingDeletionCleanup(): Promise<Set<string>> {
  const withDeletedItems = await getCollectionIdsWithDeletedDrafts('collection_items');
  const withDeletedFields = await getCollectionIdsWithDeletedDrafts('collection_fields');
  for (const id of withDeletedFields) {
    withDeletedItems.add(id);
  }
  return withDeletedItems;
}

/**
 * Clean up all soft-deleted collections
 * Uses batch DELETE operations for efficiency
 * Called during publish operations to ensure deleted collections are permanently removed
 */
export async function cleanupDeletedCollections(): Promise<void> {
  const client = await getSupabaseAdmin();

  if (!client) {
    throw new Error('Supabase not configured');
  }

  // Find all soft-deleted draft collections
  const { data: deletedCollections, error } = await client
    .from('collections')
    .select('id')
    .eq('is_published', false)
    .not('deleted_at', 'is', null);

  if (error) {
    throw new Error(`Failed to fetch deleted collections: ${error.message}`);
  }

  if (!deletedCollections || deletedCollections.length === 0) {
    return;
  }

  // Extract collection IDs
  const collectionIds = deletedCollections.map(c => c.id);

  // Batch delete published versions (CASCADE deletes all related data: fields, items, values)
  await client
    .from('collections')
    .delete()
    .in('id', collectionIds)
    .eq('is_published', true);

  // Batch delete draft versions (CASCADE deletes all related data: fields, items, values)
  await client
    .from('collections')
    .delete()
    .in('id', collectionIds)
    .eq('is_published', false);
}

/**
 * Get count of items needing publishing for a collection
 * Useful for UI indicators
 */
export async function getPublishableCount(collectionId: string): Promise<number> {
  const unpublishedItemIds = await getUnpublishedItemIds(collectionId);
  return unpublishedItemIds.length;
}

/**
 * Get counts of items needing publishing for multiple collections
 *
 * @param collectionIds - Array of collection UUIDs
 * @returns Map of collection ID to unpublished item count
 */
export async function getPublishableCounts(
  collectionIds: string[]
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};

  for (const collectionId of collectionIds) {
    try {
      counts[collectionId] = await getPublishableCount(collectionId);
    } catch {
      counts[collectionId] = 0;
    }
  }

  return counts;
}

/**
 * Check if a collection needs publishing
 * A collection needs publishing if:
 * - Published version doesn't exist, OR
 * - Collection metadata differs, OR
 * - Any fields differ, OR
 * - Any items need publishing
 */
export async function needsPublishing(collectionId: string): Promise<boolean> {
  // Check if published version exists
  const published = await getCollectionById(collectionId, true);
  if (!published) {
    return true;
  }

  // Check if collection metadata differs
  const draft = await getCollectionById(collectionId, false);
  if (!draft) {
    return false; // No draft, nothing to publish
  }

  const collectionChanged =
    draft.name !== published.name ||
    JSON.stringify(draft.sorting) !== JSON.stringify(published.sorting) ||
    draft.order !== published.order;

  if (collectionChanged) {
    return true;
  }

  // Check if any fields need publishing
  const draftFields = await getFieldsByCollectionId(collectionId, false);
  const publishedFields = await getFieldsByCollectionId(collectionId, true);

  if (draftFields.length !== publishedFields.length) {
    return true;
  }

  // Check if any items need publishing
  const unpublishedCount = await getPublishableCount(collectionId);
  if (unpublishedCount > 0) {
    return true;
  }

  return false;
}

/**
 * Group collection item IDs by their collection ID
 * Queries the database to find which collection each item belongs to
 *
 * @param itemIds - Array of collection item IDs
 * @returns Map of collection ID to array of item IDs
 */
export async function groupItemsByCollection(
  itemIds: string[]
): Promise<Map<string, string[]>> {
  const client = await getSupabaseAdmin();

  if (!client) {
    throw new Error('Supabase not configured');
  }

  if (itemIds.length === 0) {
    return new Map();
  }

  // Chunk the id list so large `.in()` filters don't overflow the request URL
  // length limit (which returns 400 Bad Request).
  const items: Array<{ id: string; collection_id: string }> = [];
  for (let i = 0; i < itemIds.length; i += SUPABASE_IN_FILTER_CHUNK_SIZE) {
    const idsChunk = itemIds.slice(i, i + SUPABASE_IN_FILTER_CHUNK_SIZE);
    const { data, error } = await client
      .from('collection_items')
      .select('id, collection_id')
      .eq('is_published', false)
      .in('id', idsChunk);

    if (error) {
      throw new Error(`Failed to fetch collection items: ${error.message}`);
    }

    if (data) {
      items.push(...data);
    }
  }

  // Group items by collection
  const itemsByCollection = new Map<string, string[]>();

  items.forEach((item) => {
    const existing = itemsByCollection.get(item.collection_id) || [];
    existing.push(item.id);
    itemsByCollection.set(item.collection_id, existing);
  });

  return itemsByCollection;
}

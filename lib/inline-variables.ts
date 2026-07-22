/**
 * Inline Variables Utilities
 *
 * Pure string manipulation for resolving inline field variables.
 * CLIENT-SAFE: Can be imported by both client and server components.
 */

import type { CollectionItemWithValues } from '@/types';
import { formatFieldValue, normalizeInlineVariableFormats, resolveFieldFromSources } from '@/lib/cms-variables-utils';

/** Regex for matching inline variable tags (use with 'g' flag) */
export const INLINE_VARIABLE_REGEX = /<ycode-inline-variable>([\s\S]*?)<\/ycode-inline-variable>/g;

/**
 * Resolve inline variables in a text string
 * Replaces <ycode-inline-variable>{"type":"field","data":{"field_id":"...","field_type":"..."}}</ycode-inline-variable>
 * with actual field values from the collection item
 *
 * CLIENT-SAFE: Pure string manipulation, works on both client and server
 * @param timezone - Optional timezone for formatting date values (defaults to UTC)
 */
export function resolveInlineVariables(
  text: string,
  collectionItem: CollectionItemWithValues | null | undefined,
  timezone: string = 'UTC',
  rawValues?: Record<string, string>
): string {
  if (!collectionItem || !collectionItem.values) {
    return text;
  }

  // Normalize legacy variable formats (e.g. raw JSON from migrated data) to the
  // canonical <ycode-inline-variable> tag so the resolver below can match them.
  const normalized = normalizeInlineVariableFormats(text);

  return normalized.replace(INLINE_VARIABLE_REGEX, (match, variableContent) => {
    try {
      const parsed = JSON.parse(variableContent.trim());

      if (parsed.type === 'field' && parsed.data?.field_id) {
        const fieldValue = collectionItem.values[parsed.data.field_id];
        // Use raw (unformatted ISO) values for custom format presets,
        // since values may be pre-formatted by formatDateFieldsInItemValues on SSR
        const value = (parsed.data.format && rawValues)
          ? (rawValues[parsed.data.field_id] ?? fieldValue)
          : fieldValue;
        return formatFieldValue(value, parsed.data.field_type, timezone, parsed.data.format);
      }
    } catch {
      // Invalid JSON or not a field variable, leave as is
    }

    return match;
  });
}

/**
 * Resolve inline variables using raw field value maps
 * Supports both collection layer data and page collection data (dynamic pages)
 * @param text - Text containing inline variable tags
 * @param collectionItemData - Merged collection layer data
 * @param pageCollectionItemData - Page collection data for dynamic pages
 * @param timezone - Optional timezone for formatting date values (defaults to UTC)
 * @param layerDataMap - Optional map of layer ID → item data (for layer-specific resolution)
 */
export function resolveInlineVariablesFromData(
  text: string,
  collectionItemData?: Record<string, string>,
  pageCollectionItemData?: Record<string, string> | null,
  timezone: string = 'UTC',
  layerDataMap?: Record<string, Record<string, string>>
): string {
  if (!text) return '';

  // Normalize legacy variable formats (e.g. raw JSON from migrated data) to the
  // canonical <ycode-inline-variable> tag so the resolver below can match them.
  const normalized = normalizeInlineVariableFormats(text);

  if (!collectionItemData && !pageCollectionItemData) {
    // Remove variable tags if no data available
    return normalized.replace(INLINE_VARIABLE_REGEX, '');
  }

  return normalized.replace(INLINE_VARIABLE_REGEX, (match, variableContent) => {
    try {
      const parsed = JSON.parse(variableContent.trim());
      if (parsed.type === 'field' && parsed.data?.field_id) {
        // Build field path with relationships if present
        const relationships = parsed.data.relationships || [];
        const fieldPath = relationships.length > 0
          ? [parsed.data.field_id, ...relationships].join('.')
          : parsed.data.field_id;

        const fieldValue = resolveFieldFromSources(
          fieldPath,
          parsed.data.source,
          collectionItemData,
          pageCollectionItemData,
          parsed.data.collection_layer_id,
          layerDataMap
        );
        return formatFieldValue(fieldValue, parsed.data.field_type, timezone, parsed.data.format);
      }
    } catch {
      // Invalid JSON
    }
    return match;
  });
}

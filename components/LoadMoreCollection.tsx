'use client';

/**
 * LoadMoreCollection
 *
 * Wires up the SSR-rendered "load more" button for a collection layer.
 * Renders no real wrapper (only an invisible marker + the SSR children)
 * so the parent layer's flex/grid layout is preserved, then appends
 * server-rendered HTML for additional items as direct siblings.
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { ITEMS_INJECTED_EVENT, type ItemsInjectedDetail } from '@/components/FilterableCollection';
import { resolvePaginationString } from '@/lib/pagination-text-utils';
import type { CollectionPaginationMeta, CollectionItem, Layer } from '@/types';

interface LoadMoreCollectionProps {
  children: React.ReactNode;
  paginationMeta: CollectionPaginationMeta;
  collectionLayerId: string;
  /** Layer template used to render new items (from _paginationMeta.layerTemplate) */
  layerTemplate?: Layer[];
  /** Optional: item IDs for multi-reference filtering */
  itemIds?: string[];
  /** Preview mode forces server-rendered links to use the `/ycode/preview` prefix. */
  isPreview?: boolean;
  /** Item ID of the dynamic-page collection being rendered (for `current-page` link keywords). */
  pageCollectionItemId?: string;
  /** Ordered ids of the dynamic page's collection — powers `next-item` / `previous-item` link keywords. */
  pageCollectionSortedItemIds?: string[];
  /** Full collection layer (sans children) — lets the server rebuild proper item wrappers (link/action/attributes). */
  collectionLayer?: Omit<Layer, 'children'>;
}

export const LOAD_MORE_APPENDED_ATTR = 'data-lm-appended';

export default function LoadMoreCollection({
  children,
  paginationMeta,
  collectionLayerId,
  layerTemplate,
  itemIds,
  isPreview = false,
  pageCollectionItemId,
  pageCollectionSortedItemIds,
  collectionLayer,
}: LoadMoreCollectionProps) {
  const { totalItems, itemsPerPage, collectionId, isPublished, sortBy, sortOrder, maxTotal } = paginationMeta;
  const markerRef = useRef<HTMLSpanElement>(null);

  const [loadedCount, setLoadedCount] = useState(itemsPerPage);
  const [hasMore, setHasMore] = useState(itemsPerPage < totalItems);
  const [isLoading, setIsLoading] = useState(false);

  const loadMore = useCallback(async () => {
    if (isLoading || !hasMore) return;

    if (!layerTemplate || layerTemplate.length === 0) {
      console.error('LoadMoreCollection: layerTemplate is required for rendering');
      return;
    }

    setIsLoading(true);

    try {
      const response = await fetch(
        `/ycode/api/collections/${collectionId}/items/load-more`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            offset: loadedCount,
            limit: itemsPerPage,
            published: isPublished !== false,
            itemIds,
            layerTemplate,
            collectionLayerId,
            sortBy,
            sortOrder,
            isPreview,
            pageCollectionItemId,
            pageCollectionSortedItemIds,
            collectionLayer,
            maxTotal,
          }),
        }
      );

      if (!response.ok) {
        throw new Error('Failed to load more items');
      }

      const result = await response.json();
      const { items, html, hasMore: nextHasMore } = result.data;
      const newItemIds: string[] = Array.isArray(items)
        ? (items as CollectionItem[]).map(item => item.id)
        : [];

      const parent = markerRef.current?.parentElement;
      if (html && parent) {
        const temp = document.createElement('div');
        temp.innerHTML = html;
        // When the pagination controls live inside the same parent as the items
        // (e.g. as the last grid cell), insert new items before the controls so
        // the "load more" button stays at the end. Falls back to appending when
        // the controls are an outside sibling (the common case).
        const paginationControls = parent.querySelector(
          `:scope > [data-pagination-for="${collectionLayerId}"]`
        );
        while (temp.firstChild) {
          const child = temp.firstChild;
          if (child instanceof Element) child.setAttribute(LOAD_MORE_APPENDED_ATTR, '');
          if (paginationControls) {
            parent.insertBefore(child, paginationControls);
          } else {
            parent.appendChild(child);
          }
        }
        if (newItemIds.length > 0) {
          const detail: ItemsInjectedDetail = {
            collectionLayerId,
            layerTemplate,
            itemIds: newItemIds,
            append: true,
            collectionLayer,
          };
          window.dispatchEvent(new CustomEvent<ItemsInjectedDetail>(ITEMS_INJECTED_EVENT, { detail }));
        }
      }

      setLoadedCount(prev => prev + items.length);
      setHasMore(nextHasMore);
    } catch (error) {
      console.error('Load more failed:', error);
    } finally {
      setIsLoading(false);
    }
  }, [
    isLoading,
    hasMore,
    layerTemplate,
    collectionId,
    loadedCount,
    itemsPerPage,
    isPublished,
    itemIds,
    collectionLayerId,
    sortBy,
    sortOrder,
    isPreview,
    pageCollectionItemId,
    pageCollectionSortedItemIds,
    collectionLayer,
    maxTotal,
  ]);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const button = target.closest('[data-pagination-action="load_more"]') as HTMLElement | null;
      if (!button) return;
      if (button.getAttribute('data-collection-layer-id') !== collectionLayerId) return;
      e.preventDefault();
      loadMore();
    };

    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, [collectionLayerId, loadMore]);

  useEffect(() => {
    const wrapper = document.querySelector(
      `[data-pagination-for="${collectionLayerId}"]`
    ) as HTMLElement | null;

    // Hide the whole wrapper when there are no results.
    if (wrapper) wrapper.classList.toggle('hidden', totalItems <= 0);

    const countElement = wrapper?.querySelector(`[data-layer-id$="-pagination-count"]`);
    if (countElement) {
      // Prefer the (translated) template so the locale's wording is preserved;
      // fall back to the English default for legacy pages without a template.
      const template = countElement.getAttribute('data-pagination-template');
      // loadedCount starts at itemsPerPage, which can exceed the actual total
      // (e.g. 10 per page but only 6 items) — cap it so we never show "10 of 6".
      const shown = Math.min(loadedCount, totalItems);
      countElement.textContent = template
        ? resolvePaginationString(template, { shown, total: totalItems, current: 1, pages: 1 })
        : `Showing ${shown} of ${totalItems}`;
    }

    const loadMoreButton = wrapper?.querySelector(
      `[data-pagination-action="load_more"]`
    ) as HTMLElement | null;
    if (loadMoreButton) {
      loadMoreButton.style.display = hasMore ? '' : 'none';
      loadMoreButton.toggleAttribute('disabled', isLoading);
      loadMoreButton.style.opacity = isLoading ? '0.6' : '';
      loadMoreButton.style.pointerEvents = isLoading ? 'none' : '';
    }
  }, [loadedCount, hasMore, totalItems, collectionLayerId, isLoading]);

  return (
    <>
      <span
        ref={markerRef} data-collection-marker=""
        style={{ display: 'none' }}
      />
      {children}
    </>
  );
}

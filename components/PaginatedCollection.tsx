'use client';

/**
 * PaginatedCollection Component
 *
 * Client component that handles pagination for collection layers.
 * Hydrates from SSR with initial items and supports full-page navigation.
 *
 * Features:
 * - URL-based pagination with stripped layer ID params (?p_ID=N)
 * - Independent pagination for multiple collections on the same page
 * - Loading state during page transitions
 * - Previous/Next button state management
 *
 * Navigation uses window.location.href (not router.push) so the proxy
 * middleware can rewrite p_ params to the /dynamic route.
 *
 * Layout note: this component renders a zero-box fragment (a hidden marker
 * span + the SSR children) rather than a wrapping div. The collection's item
 * clones are emitted as direct children of the collection's layout element
 * (grid/flex container), so they must NOT be reparented into an extra wrapper
 * — doing so breaks the grid/flex layout on the published page (items collapse
 * to a single column). The pending/dim state is applied to the real parent
 * layout element instead, mirroring FilterableCollection.
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useSearchParams, usePathname } from 'next/navigation';
import type { CollectionPaginationMeta } from '@/types';

function stripLayerPrefix(id: string): string {
  return id.startsWith('lyr-') ? id.slice(4) : id;
}

interface PaginatedCollectionProps {
  children: React.ReactNode;
  paginationMeta: CollectionPaginationMeta;
  collectionLayerId: string;
}

export default function PaginatedCollection({
  children,
  paginationMeta,
  collectionLayerId,
}: PaginatedCollectionProps) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, setIsPending] = useState(false);
  const markerRef = useRef<HTMLSpanElement>(null);

  const { currentPage, totalPages } = paginationMeta;

  // Resolve the collection's real layout element (the marker's parent), so the
  // loading state can be applied without introducing an extra wrapper box that
  // would break the collection's grid/flex layout. Mirrors FilterableCollection.
  const getParent = useCallback(
    () => (markerRef.current?.parentElement as HTMLElement | null),
    [],
  );

  const navigateToPage = useCallback((page: number) => {
    if (page < 1 || page > totalPages) return;

    const params = new URLSearchParams(searchParams.toString());
    const paramKey = `p_${stripLayerPrefix(collectionLayerId)}`;

    if (page === 1) {
      params.delete(paramKey);
    } else {
      params.set(paramKey, String(page));
    }

    const newUrl = params.toString() ? `${pathname}?${params.toString()}` : pathname;

    setIsPending(true);
    window.location.href = newUrl;
  }, [pathname, searchParams, totalPages, collectionLayerId]);

  // Handle click events on pagination buttons (delegated at the document level,
  // so no wrapper element is required).
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const button = target.closest('[data-pagination-action]') as HTMLElement | null;

      if (!button) return;

      const action = button.getAttribute('data-pagination-action');
      const layerId = button.getAttribute('data-collection-layer-id');

      // Only handle clicks for this collection's pagination
      if (layerId !== collectionLayerId) return;

      e.preventDefault();

      if (action === 'prev' && currentPage > 1) {
        navigateToPage(currentPage - 1);
      } else if (action === 'next' && currentPage < totalPages) {
        navigateToPage(currentPage + 1);
      }
    };

    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, [collectionLayerId, currentPage, totalPages, navigateToPage]);

  // Dim + disable the collection's real layout element during the page
  // transition instead of wrapping it in a positioned box. This keeps the
  // published DOM structurally identical to the canvas so the grid/flex layout
  // is preserved.
  useEffect(() => {
    const el = getParent();
    if (!el) return;
    if (isPending) {
      el.style.opacity = '0.5';
      el.style.pointerEvents = 'none';
    } else {
      el.style.opacity = '';
      el.style.pointerEvents = '';
    }
  }, [isPending, getParent]);

  return (
    <>
      {/*
        Zero-box marker: locates the parent layout element and is excluded from
        SSR-child collection logic (data-collection-marker) when a filter also
        wraps this collection.
      */}
      <span
        ref={markerRef}
        data-collection-marker=""
        data-paginated-collection={collectionLayerId}
        style={{ display: 'none' }}
      />
      {children}
    </>
  );
}

/**
 * Skeleton placeholder for collection items during loading
 */
export function CollectionSkeleton({ count = 3 }: { count?: number }) {
  return (
    <div className="space-y-4">
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="animate-pulse bg-gray-200 rounded-lg h-32"
        />
      ))}
    </div>
  );
}

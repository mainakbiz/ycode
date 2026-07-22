'use client';

/**
 * AiActivityOverlay Component
 *
 * Renders shimmering "loading" outlines on top of the canvas iframe for the
 * layers the AI agent is currently editing. The active layer IDs live in the
 * editor store (set by the AI chat store as tool calls stream in), and the
 * positioning logic mirrors SelectionOverlay: outline divs are absolutely
 * positioned in the parent document, tracking each `[data-layer-id]` element's
 * bounding box inside the iframe (scaled by the current zoom).
 */

import React, { useCallback, useEffect, useRef } from 'react';

import { useEditorStore } from '@/stores/useEditorStore';

interface AiActivityOverlayProps {
  /** Reference to the canvas iframe element */
  iframeElement: HTMLIFrameElement | null;
  /** Reference to the container element for positioning */
  containerElement: HTMLElement | null;
  /** Current zoom level (percentage) */
  zoom: number;
}

const OUTLINE_CLASS = 'absolute ai-activity-outline pointer-events-none';

export function AiActivityOverlay({
  iframeElement,
  containerElement,
  zoom,
}: AiActivityOverlayProps) {
  const activeLayerIds = useEditorStore((state) => state.aiActiveLayerIds);
  const containerRef = useRef<HTMLDivElement>(null);

  // Keep the latest IDs in a ref so the observer-driven update path (scroll,
  // resize, DOM mutations) reads current values without re-binding listeners.
  const activeLayerIdsRef = useRef(activeLayerIds);
  activeLayerIdsRef.current = activeLayerIds;

  const updateOutlines = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    const ids = activeLayerIdsRef.current;
    const iframeDoc = iframeElement?.contentDocument;
    if (!iframeElement || !containerElement || !iframeDoc || ids.length === 0) {
      container.style.display = 'none';
      return;
    }

    // Body has no box of its own (display:contents) — skip it; shimmering the
    // whole canvas would be noise rather than a useful "working here" signal.
    const targets: HTMLElement[] = [];
    for (const id of ids) {
      if (id === 'body') continue;
      iframeDoc
        .querySelectorAll(`[data-layer-id="${id}"]`)
        .forEach((el) => targets.push(el as HTMLElement));
    }

    if (targets.length === 0) {
      container.style.display = 'none';
      return;
    }

    container.style.display = 'block';

    const scale = zoom / 100;
    const iframeRect = iframeElement.getBoundingClientRect();
    const containerRect = containerElement.getBoundingClientRect();

    // Ensure we have enough outline divs, then hide any excess.
    while (container.children.length < targets.length) {
      const div = document.createElement('div');
      div.className = OUTLINE_CLASS;
      container.appendChild(div);
    }
    for (let i = targets.length; i < container.children.length; i++) {
      (container.children[i] as HTMLElement).style.display = 'none';
    }

    targets.forEach((target, idx) => {
      const rect = target.getBoundingClientRect();
      const child = container.children[idx] as HTMLElement;
      child.className = OUTLINE_CLASS;
      child.style.display = 'block';
      child.style.top = `${iframeRect.top - containerRect.top + rect.top * scale}px`;
      child.style.left = `${iframeRect.left - containerRect.left + rect.left * scale}px`;
      child.style.width = `${rect.width * scale}px`;
      child.style.height = `${rect.height * scale}px`;
    });
  }, [iframeElement, containerElement, zoom]);

  // Reposition whenever the active set, iframe, container, or zoom changes.
  useEffect(() => {
    updateOutlines();
  }, [updateOutlines, activeLayerIds]);

  // Track scroll / resize / canvas mutations so the outlines stay glued to the
  // layers as the agent edits the tree and the layout shifts underneath them.
  useEffect(() => {
    if (!iframeElement || !containerElement) return;
    const iframeDoc = iframeElement.contentDocument;
    if (!iframeDoc) return;

    let rafId: number | null = null;
    const schedule = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        updateOutlines();
      });
    };

    const mutationObserver = new MutationObserver(schedule);
    if (iframeDoc.body) {
      mutationObserver.observe(iframeDoc.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'style'],
      });
    }

    const resizeObserver = new ResizeObserver(schedule);
    if (iframeDoc.body) resizeObserver.observe(iframeDoc.body);

    containerElement.addEventListener('scroll', schedule, { passive: true });
    iframeDoc.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule, { passive: true });
    window.addEventListener('viewportChange', schedule);

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      mutationObserver.disconnect();
      resizeObserver.disconnect();
      containerElement.removeEventListener('scroll', schedule);
      iframeDoc.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('viewportChange', schedule);
    };
  }, [iframeElement, containerElement, updateOutlines]);

  return (
    <div className="absolute inset-0 pointer-events-none overflow-hidden z-40">
      <div ref={containerRef} style={{ display: 'none' }} />
    </div>
  );
}

export default React.memo(AiActivityOverlay);

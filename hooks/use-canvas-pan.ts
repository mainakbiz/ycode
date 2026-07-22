import { useCallback, useEffect, useRef } from 'react';

interface UseCanvasPanOptions {
  /** The scrollable canvas container whose scroll offset gets adjusted while panning */
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  /** The canvas iframe — the drag often starts and stays inside it */
  iframeElement: HTMLIFrameElement | null;
  /** Disable panning (e.g. in preview mode) */
  enabled?: boolean;
  /** When true, the spacebar is reserved for typing and won't arm panning */
  isTextEditing?: boolean;
}

interface UseCanvasPanResult {
  /** True while a pan is armed (Space held) or in progress — gate canvas selection with this */
  isPanGestureActive: () => boolean;
}

/** True when the keyboard event originates from (or focus rests in) a text-entry
 * element, so Space should type a character rather than arm canvas panning. */
function isEditableTarget(target: EventTarget | null): boolean {
  const el = (target as HTMLElement | null) ?? null;
  const active = typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null;
  const check = (node: HTMLElement | null): boolean =>
    !!node && (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA' || node.isContentEditable);
  return check(el) || check(active);
}

/**
 * Enables panning the canvas by dragging while holding Space (industry standard
 * "hand tool"), or with the middle mouse button. Lets users navigate a large
 * canvas at high zoom levels.
 *
 * Space only arms panning while the pointer is over the canvas, so it keeps
 * behaving normally for selects, inputs and buttons in the settings panels.
 */
export function useCanvasPan({
  scrollContainerRef,
  iframeElement,
  enabled = true,
  isTextEditing = false,
}: UseCanvasPanOptions): UseCanvasPanResult {
  const stateRef = useRef({
    isPanning: false,
    spaceHeld: false,
    overCanvas: false,
    suppressNextClick: false,
    lastX: 0,
    lastY: 0,
  });
  const isTextEditingRef = useRef(isTextEditing);
  useEffect(() => {
    isTextEditingRef.current = isTextEditing;
  }, [isTextEditing]);

  useEffect(() => {
    if (!enabled) return;

    const scrollEl = scrollContainerRef.current;
    if (!scrollEl) return;

    const state = stateRef.current;

    let iframeDoc: Document | null = null;
    try {
      iframeDoc = iframeElement?.contentDocument ?? null;
    } catch {
      // Cross-origin iframe — ignore
    }

    const setCursor = (mode: 'grab' | 'grabbing' | '') => {
      scrollEl.style.cursor = mode;
      if (iframeElement) iframeElement.style.cursor = mode;
      try {
        if (iframeDoc?.body) iframeDoc.body.style.cursor = mode;
      } catch {
        // Ignore
      }
    };

    const shouldStartPan = (e: MouseEvent) =>
      e.button === 1 || (e.button === 0 && state.spaceHeld);

    const handleMove = (e: MouseEvent) => {
      if (!state.isPanning) return;
      e.preventDefault();
      // screenX/Y are global physical coordinates — consistent across the parent
      // document and the (CSS-zoomed) iframe, unlike clientX/movementX.
      const dx = e.screenX - state.lastX;
      const dy = e.screenY - state.lastY;
      state.lastX = e.screenX;
      state.lastY = e.screenY;

      // Horizontal overflow lives on the outer container.
      scrollEl.scrollLeft -= dx;

      // Vertical overflow usually scrolls inside the iframe (it's sized to the
      // visible area, scrolling its own taller content). Fall back to the outer
      // container when the iframe can't scroll (e.g. component editing).
      let scroller: Element | null = null;
      try {
        scroller = iframeDoc?.scrollingElement ?? iframeDoc?.documentElement ?? null;
      } catch {
        scroller = null;
      }
      if (scroller && scroller.scrollHeight > scroller.clientHeight) {
        scroller.scrollTop -= dy;
      } else {
        scrollEl.scrollTop -= dy;
      }
    };

    const endPan = () => {
      if (!state.isPanning) return;
      state.isPanning = false;
      setCursor(state.spaceHeld ? 'grab' : '');
      window.removeEventListener('mousemove', handleMove, true);
      window.removeEventListener('mouseup', endPan, true);
      try {
        iframeDoc?.removeEventListener('mousemove', handleMove, true);
        iframeDoc?.removeEventListener('mouseup', endPan, true);
      } catch {
        // Ignore
      }
      // Clear after the post-mouseup click has had a chance to be suppressed.
      setTimeout(() => { state.suppressNextClick = false; }, 0);
    };

    // A pan gesture is a mousedown+mouseup, which also fires a click that would
    // otherwise select a layer. Swallow that click in the capture phase.
    const handleClick = (e: MouseEvent) => {
      if (!state.spaceHeld && !state.suppressNextClick) return;
      e.preventDefault();
      e.stopPropagation();
    };

    const startPan = (e: MouseEvent) => {
      if (state.isPanning || !shouldStartPan(e)) return;
      e.preventDefault();
      e.stopPropagation();
      state.isPanning = true;
      state.suppressNextClick = true;
      state.lastX = e.screenX;
      state.lastY = e.screenY;
      setCursor('grabbing');

      // Listen on both contexts: a drag that starts inside the iframe keeps
      // delivering move/up events to the iframe document (and vice versa), so
      // each surface needs the listeners to pan live during the drag.
      window.addEventListener('mousemove', handleMove, true);
      window.addEventListener('mouseup', endPan, true);
      try {
        iframeDoc?.addEventListener('mousemove', handleMove, true);
        iframeDoc?.addEventListener('mouseup', endPan, true);
      } catch {
        // Ignore
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat || state.spaceHeld) return;
      // Never hijack Space while the user is typing in a text field (chat
      // composer, settings inputs, etc.). The pointer can rest over the canvas
      // while focus is in an editable element, so `overCanvas` alone isn't
      // enough — check the focused/target element too.
      if (isTextEditingRef.current || isEditableTarget(e.target)) return;
      // Only hijack Space when the pointer is over the canvas, so it keeps
      // working normally for inputs/selects/buttons in the settings panels.
      if (!state.overCanvas) return;
      state.spaceHeld = true;
      e.preventDefault(); // stop the page from scrolling on space
      if (!state.isPanning) setCursor('grab');
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      state.spaceHeld = false;
      if (!state.isPanning) setCursor('');
    };

    // Track whether the pointer is over the canvas (incl. the iframe, which sits
    // inside the scroll container). The iframe is a separate browsing context,
    // so its own mousemove keeps the flag set while hovering page content.
    const markOver = () => { state.overCanvas = true; };
    const markOut = () => { state.overCanvas = false; };

    scrollEl.addEventListener('mousedown', startPan, true);
    scrollEl.addEventListener('click', handleClick, true);
    scrollEl.addEventListener('mouseenter', markOver);
    scrollEl.addEventListener('mousemove', markOver);
    scrollEl.addEventListener('mouseleave', markOut);
    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('keyup', handleKeyUp, true);
    try {
      iframeDoc?.addEventListener('mousedown', startPan, true);
      iframeDoc?.addEventListener('click', handleClick, true);
      iframeDoc?.addEventListener('mousemove', markOver);
      iframeDoc?.addEventListener('keydown', handleKeyDown, true);
      iframeDoc?.addEventListener('keyup', handleKeyUp, true);
    } catch {
      // Ignore
    }

    return () => {
      scrollEl.removeEventListener('mousedown', startPan, true);
      scrollEl.removeEventListener('click', handleClick, true);
      scrollEl.removeEventListener('mouseenter', markOver);
      scrollEl.removeEventListener('mousemove', markOver);
      scrollEl.removeEventListener('mouseleave', markOut);
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('keyup', handleKeyUp, true);
      try {
        iframeDoc?.removeEventListener('mousedown', startPan, true);
        iframeDoc?.removeEventListener('click', handleClick, true);
        iframeDoc?.removeEventListener('mousemove', markOver);
        iframeDoc?.removeEventListener('keydown', handleKeyDown, true);
        iframeDoc?.removeEventListener('keyup', handleKeyUp, true);
      } catch {
        // Ignore
      }
      endPan();
      state.spaceHeld = false;
      state.overCanvas = false;
      setCursor('');
    };
  }, [enabled, scrollContainerRef, iframeElement]);

  const isPanGestureActive = useCallback(() => {
    const s = stateRef.current;
    return s.spaceHeld || s.isPanning || s.suppressNextClick;
  }, []);

  return { isPanGestureActive };
}

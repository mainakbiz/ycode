'use client';

/**
 * Client-side component thumbnail capture and upload.
 * Renders layers in a hidden iframe, captures with html-to-image,
 * and uploads to the server for WebP conversion + storage.
 *
 * This is a standalone module (not a hook) so it can be called from
 * Zustand stores and other non-React contexts.
 */

import React from 'react';
import { flushSync } from 'react-dom';
import { createRoot, Root } from 'react-dom/client';
import { toBlob } from 'html-to-image';

import LayerRenderer from '@/components/LayerRenderer';
import { getCanvasIframeHtml } from '@/lib/canvas-utils';
import { componentsApi } from '@/lib/api';
import { serializeLayers } from '@/lib/layer-utils';
import { DEFAULT_ASSETS } from '@/lib/asset-constants';
import { useColorVariablesStore } from '@/stores/useColorVariablesStore';
import { useFontsStore } from '@/stores/useFontsStore';
import type { Layer, Component } from '@/types';

/** Default placeholder image for failed CORS fetches (base64 data URI) */
const DEFAULT_IMAGE_PLACEHOLDER = DEFAULT_ASSETS.IMAGE;

/** Viewport width for the thumbnail render */
const THUMBNAIL_VIEWPORT_WIDTH = 1280;

/** Time to wait for Tailwind CDN to process styles (ms) */
const TAILWIND_INIT_DELAY = 1500;

/** Track in-progress generations to prevent duplicates */
const pendingGenerations = new Set<string>();

/** Await a few animation frames inside the iframe so layout settles after a
 * render without a fixed timeout. Falls back to setTimeout if rAF is missing. */
async function waitForFrames(win: Window | null, count = 2): Promise<void> {
  const raf =
    win && typeof win.requestAnimationFrame === 'function'
      ? win.requestAnimationFrame.bind(win)
      : (cb: FrameRequestCallback) => window.setTimeout(() => cb(0), 16);
  for (let i = 0; i < count; i += 1) {
    await new Promise<void>((resolve) => raf(() => resolve()));
  }
}

/**
 * Render layers in a hidden iframe and capture as an image blob.
 * Creates and destroys the iframe automatically.
 *
 * When `precompiledCss` is provided (the server-compiled Tailwind stylesheet for
 * the page), it is injected directly and the fixed Tailwind CDN JIT waits are
 * skipped — the styles are already resolved, so we only wait for layout to
 * settle. This removes ~1.7s of fixed delay from the AI self-review screenshot
 * and makes it match what the canvas/published page actually renders.
 */
async function captureLayersAsBlob(
  layers: Layer[],
  components: Component[],
  precompiledCss?: string
): Promise<Blob | null> {
  // Resolve component instances
  const { layers: resolvedLayers } = serializeLayers(layers, components);

  // Create hidden offscreen iframe
  const iframe = document.createElement('iframe');
  iframe.style.position = 'fixed';
  iframe.style.left = '-9999px';
  iframe.style.top = '-9999px';
  iframe.style.width = `${THUMBNAIL_VIEWPORT_WIDTH}px`;
  iframe.style.height = '800px';
  iframe.style.border = 'none';
  iframe.style.opacity = '0';
  iframe.style.pointerEvents = 'none';
  document.body.appendChild(iframe);

  let root: Root | null = null;

  try {
    const doc = iframe.contentDocument;
    if (!doc) throw new Error('Could not access iframe document');

    // Write shared canvas HTML template
    doc.open();
    doc.write(getCanvasIframeHtml('thumbnail-mount'));
    doc.close();

    // Inject color variable CSS custom properties
    const colorVarCss = useColorVariablesStore.getState().generateCssDeclarations();
    if (colorVarCss) {
      const colorStyle = doc.createElement('style');
      colorStyle.id = 'ycode-color-vars';
      colorStyle.textContent = colorVarCss;
      doc.head.appendChild(colorStyle);
    }

    // Inject font CSS (Google @import + custom @font-face + font class mappings)
    // as a same-origin <style> so custom fonts render instead of the serif
    // fallback — without this the capture (and the AI visual self-review) sees
    // wrong fonts. We deliberately avoid injectFontsCss()'s cross-origin Google
    // Font <link> elements: html-to-image can't read their cssRules and throws
    // "Cannot access rules". A same-origin <style> with @import is readable, and
    // html-to-image fetches + inlines the imported fonts itself.
    const fontsCss = useFontsStore.getState().fontsCss;
    if (fontsCss) {
      // The canvas template ships an empty <style id="ycode-fonts-style"> — fill
      // it (or create it) rather than duplicating the id.
      let fontStyle = doc.getElementById('ycode-fonts-style') as HTMLStyleElement | null;
      if (!fontStyle) {
        fontStyle = doc.createElement('style');
        fontStyle.id = 'ycode-fonts-style';
        doc.head.appendChild(fontStyle);
      }
      fontStyle.textContent = fontsCss;
    }

    // When the server-compiled stylesheet is available, inject it as the
    // authoritative styles so we don't depend on (or wait for) the in-iframe
    // Tailwind CDN JIT to process classes.
    if (precompiledCss) {
      const compiledStyle = doc.createElement('style');
      compiledStyle.id = 'ycode-compiled-css';
      compiledStyle.textContent = precompiledCss;
      doc.head.appendChild(compiledStyle);
    } else {
      // Wait for Tailwind CDN to initialize
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    const mountPoint = doc.getElementById('thumbnail-mount');
    if (!mountPoint) throw new Error('Mount point not found');

    // Render layers into the iframe. createRoot().render() is asynchronous
    // (concurrent React), and the offscreen iframe's rAF timing is unreliable,
    // so waiting frames alone can race the commit and "#component-preview"
    // may not exist yet when queried below. flushSync forces the commit to
    // complete before we continue.
    root = createRoot(mountPoint);
    const reactRoot = root;
    flushSync(() => {
      reactRoot.render(
        <div
          id="component-preview"
          style={{
            background: 'white',
            minHeight: '400px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <div style={{ width: '100%', display: 'flex', justifyContent: 'center' }}>
            <LayerRenderer
              layers={resolvedLayers}
              isEditMode={false}
              isPublished={false}
              pageId="thumbnail"
            />
          </div>
        </div>
      );
    });

    // Wait for styles to apply and layout to settle. With precompiled CSS the
    // styles resolve synchronously, so a couple of frames is enough; otherwise
    // give the Tailwind CDN JIT time to process classes.
    if (precompiledCss) {
      await waitForFrames(iframe.contentWindow, 2);
    } else {
      await new Promise((resolve) => setTimeout(resolve, TAILWIND_INIT_DELAY));
    }

    // Force eager loading — the offscreen iframe won't trigger lazy images
    doc.querySelectorAll('img[loading="lazy"]').forEach((img) => {
      img.setAttribute('loading', 'eager');
      const src = img.getAttribute('src');
      if (src) {
        img.setAttribute('src', '');
        img.setAttribute('src', src);
      }
    });

    // Wait for images to load
    const images = Array.from(doc.querySelectorAll('img'));
    const pending = images.filter((img) => !img.complete);
    if (pending.length > 0) {
      await Promise.race([
        Promise.all(pending.map((img) =>
          new Promise<void>((resolve) => {
            img.addEventListener('load', () => resolve(), { once: true });
            img.addEventListener('error', () => resolve(), { once: true });
          })
        )),
        new Promise<void>((resolve) => setTimeout(resolve, 5000)),
      ]);
    }

    // Wait for the injected web fonts to finish loading so the captured image
    // uses the real typefaces (otherwise text renders with the serif fallback).
    try {
      await Promise.race([
        doc.fonts.ready,
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
    } catch {
      // Ignore — fall back to whatever is loaded so capture never hangs.
    }

    // Capture the rendered content
    const target = doc.getElementById('component-preview');
    if (!target) throw new Error('Component preview element not found');

    const blob = await toBlob(target, {
      backgroundColor: '#ffffff',
      pixelRatio: 1,
      skipFonts: false,
      imagePlaceholder: DEFAULT_IMAGE_PLACEHOLDER,
      filter: (node: HTMLElement) => {
        const tag = node.tagName;
        if (tag === 'VIDEO' || tag === 'AUDIO' || tag === 'IFRAME') return false;
        return true;
      },
    });

    return blob;
  } finally {
    // Cleanup
    if (root) {
      try {
        root.unmount();
      } catch {
        // Ignore unmount errors during cleanup
      }
    }
    document.body.removeChild(iframe);
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(new Error('Failed to read blob'));
    reader.readAsDataURL(blob);
  });
}

/**
 * Render layers offscreen and return them as a base64 image (no upload).
 * Used by the AI visual self-review loop to let the agent "see" its work.
 *
 * @param precompiledCss - Optional server-compiled Tailwind stylesheet for the
 *   page. When provided, the fixed Tailwind CDN JIT wait is skipped, making the
 *   capture ~1.7s faster and matching the canvas/published rendering.
 * @returns Image data (base64 + media type + full data URL), or null on failure
 */
export async function captureLayersImage(
  layers: Layer[],
  components: Component[] = [],
  precompiledCss?: string,
): Promise<{ data: string; mediaType: string; dataUrl: string } | null> {
  try {
    const blob = await captureLayersAsBlob(layers, components, precompiledCss);
    if (!blob) return null;
    const dataUrl = await blobToDataUrl(blob);
    const comma = dataUrl.indexOf(',');
    if (comma === -1) return null;
    return { data: dataUrl.slice(comma + 1), mediaType: blob.type || 'image/png', dataUrl };
  } catch (error) {
    console.error('Error capturing layers image:', error);
    return null;
  }
}

/**
 * Generate and upload a component thumbnail.
 * Fire-and-forget: runs in background, deduplicates concurrent calls per component.
 * @returns The public URL of the uploaded thumbnail, or null on failure
 */
export async function generateComponentThumbnail(
  componentId: string,
  layers: Layer[],
  components: Component[] = []
): Promise<string | null> {
  // Skip if already generating for this component
  if (pendingGenerations.has(componentId)) return null;
  pendingGenerations.add(componentId);

  try {
    const blob = await captureLayersAsBlob(layers, components);
    if (!blob) return null;

    const result = await componentsApi.uploadThumbnail(componentId, blob);
    if (result.error) {
      console.error('Failed to upload thumbnail:', result.error);
      return null;
    }

    return result.data?.thumbnail_url ?? null;
  } catch (error) {
    console.error('Error generating component thumbnail:', error);
    return null;
  } finally {
    pendingGenerations.delete(componentId);
  }
}

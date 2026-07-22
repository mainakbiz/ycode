import type { Layer } from '@/types';

/**
 * Design linter — instant, deterministic feedback on what the agent just built.
 *
 * Agents build without seeing rendered output, so structural and typographic
 * mistakes (content directly in a section, text without a type scale, unreadable
 * contrast) surface only when a human looks at the canvas. This linter encodes
 * the hard rules from the system instructions' "Common Mistakes" list as checks
 * against the layer tree and returns terse warnings that are appended to the
 * batch_operations tool result, so the model can fix problems in the next
 * operation instead of shipping them.
 *
 * Checks read the structured `design` object (desktop/neutral values) first and
 * fall back to the compiled Tailwind `classes`, which is the source of truth
 * for layers styled via templates or layouts.
 */

const MAX_WARNINGS = 8;

/** Leaf content elements that must never sit directly inside a section. */
const CONTENT_LEAF_TYPES = new Set([
  'text', 'heading', 'richText', 'image', 'button', 'icon', 'video', 'form',
]);

const TEXT_TYPES = new Set(['text', 'heading']);

/**
 * Lint the layers touched by an edit (plus their descendants) and page-wide
 * typography variety. `touchedIds` scopes per-layer checks to what this edit
 * created or restyled, so pre-existing issues elsewhere on the page don't
 * repeat in every tool result.
 */
export function lintDesign(layers: Layer[], touchedIds: Set<string>): string[] {
  const warnings: string[] = [];
  const fontSizes = new Set<string>();

  const walk = (layer: Layer, inTouchedSubtree: boolean, inheritedBg: string | null, parent: Layer | null) => {
    const touched = inTouchedSubtree || touchedIds.has(layer.id);
    const classes = classListOf(layer);
    // A layer with its own background overrides the inherited one. When that
    // background exists but isn't a literal color (gradient, image, var()
    // token), the effective background becomes unknown — descendants skip
    // contrast checks rather than compare against a stale ancestor color.
    const ownBg = backgroundOf(layer, classes);
    const bg = ownBg === undefined ? inheritedBg : ownBg;

    collectFontSize(layer, classes, fontSizes);

    if (touched && warnings.length < MAX_WARNINGS) {
      lintLayer(layer, classes, bg, parent, warnings);
    }

    for (const child of layer.children ?? []) {
      walk(child, touched, bg, layer);
    }
  };

  for (const layer of layers) {
    // Pages render on a white ground unless a layer sets its own background.
    walk(layer, false, '#ffffff', null);
  }

  if (fontSizes.size > 6) {
    warnings.push(
      `Page uses ${fontSizes.size} distinct font sizes — consolidate to 4-5 for a clean hierarchy.`,
    );
  }

  return warnings.slice(0, MAX_WARNINGS);
}

function lintLayer(
  layer: Layer,
  classes: string[],
  effectiveBg: string | null,
  parent: Layer | null,
  warnings: string[],
): void {
  const label = `[${layer.id}${layer.customName ? ` "${layer.customName}"` : ''}]`;

  // Section structure: content must live in a container child that constrains width.
  if (layer.name === 'section' && (layer.children?.length ?? 0) > 0) {
    const children = layer.children ?? [];
    const directLeaves = children.filter((child) => CONTENT_LEAF_TYPES.has(child.name));
    if (directLeaves.length > 0) {
      warnings.push(
        `${label} section has content (${directLeaves.map((l) => l.name).join(', ')}) directly inside it — wrap it in a container div (maxWidth 1280px, horizontal padding).`,
      );
    } else if (!children.some((child) => hasMaxWidth(child))) {
      warnings.push(
        `${label} section has no container child with maxWidth — content will stretch full-width on large screens.`,
      );
    }
  }

  // Text layers need a deliberate type treatment, not defaults.
  if (TEXT_TYPES.has(layer.name)) {
    const typography = layer.design?.typography;
    const missing: string[] = [];
    if (!typography?.fontSize && !classes.some((c) => /^text-(\[|xs$|sm$|base$|lg$|xl$|\dxl$)/.test(c))) missing.push('fontSize');
    if (!typography?.fontWeight && !classes.some((c) => /^font-(thin|extralight|light|normal|medium|semibold|bold|extrabold|black|\[)/.test(c))) missing.push('fontWeight');
    if (!typography?.lineHeight && !classes.some((c) => c.startsWith('leading-'))) missing.push('lineHeight');
    if (missing.length > 0) {
      warnings.push(`${label} ${layer.name} layer has no ${missing.join('/')} — always set the full trio (fontSize, fontWeight, lineHeight).`);
    }

    // Contrast: only when both text color and effective background resolve to literal colors.
    const color = parseColor(layer.design?.typography?.color) ?? parseColorClass(classes, 'text-');
    const bg = effectiveBg ? parseColor(effectiveBg) : null;
    if (color && bg) {
      const ratio = contrastRatio(color, bg);
      if (ratio < 3) {
        warnings.push(
          `${label} text contrast is ${ratio.toFixed(1)}:1 against its background — too low to read. Aim for 4.5:1 (3:1 minimum for large headings).`,
        );
      }
    }
  }

  // Flex container with multiple children but no explicit direction.
  const isFlex = layer.design?.layout?.display === 'Flex' || classes.includes('flex');
  if (isFlex && (layer.children?.length ?? 0) >= 2) {
    const hasDirection = Boolean(layer.design?.layout?.flexDirection)
      || classes.some((c) => /^flex-(row|col)(-reverse)?$/.test(c));
    if (!hasDirection) {
      warnings.push(`${label} flex container has no flexDirection — set it explicitly (row or column).`);
    }
  }

  // Pill/badge stretched full-width inside a flex column.
  const isPill = layer.design?.borders?.borderRadius === '9999px' || classes.includes('rounded-full');
  if (isPill && parent && isFlexColumn(parent)) {
    const hugsContent = Boolean(layer.design?.layout?.alignSelf)
      || classes.some((c) => c.startsWith('self-'))
      || classListOf(parent).some((c) => c === 'items-start' || c === 'items-center' || c === 'items-end')
      || ['start', 'center', 'end'].includes(parent.design?.layout?.alignItems ?? '');
    if (!hugsContent) {
      warnings.push(
        `${label} pill/badge will stretch full-width inside its flex column — set layout.alignSelf "start" or "center" on it.`,
      );
    }
  }
}

function isFlexColumn(layer: Layer): boolean {
  const classes = classListOf(layer);
  const isFlex = layer.design?.layout?.display === 'Flex' || classes.includes('flex');
  if (!isFlex) return false;
  return layer.design?.layout?.flexDirection === 'column' || classes.includes('flex-col');
}

function hasMaxWidth(layer: Layer): boolean {
  if (layer.design?.sizing?.maxWidth) return true;
  return classListOf(layer).some((c) => c.startsWith('max-w-'));
}

function collectFontSize(layer: Layer, classes: string[], sizes: Set<string>): void {
  if (!TEXT_TYPES.has(layer.name)) return;
  const designSize = layer.design?.typography?.fontSize;
  if (designSize) {
    sizes.add(designSize);
    return;
  }
  for (const cls of classes) {
    const match = /^text-\[(.+)\]$/.exec(cls);
    if (match) sizes.add(match[1]);
  }
}

/** Base (un-prefixed) classes only — hover:/md:/etc. variants don't affect the neutral desktop checks. */
function classListOf(layer: Layer): string[] {
  const raw = Array.isArray(layer.classes) ? layer.classes.join(' ') : (layer.classes ?? '');
  return raw.split(/\s+/).filter((c) => c.length > 0 && !c.includes(':'));
}

/**
 * The layer's own background: a literal color string, `null` when a background
 * is present but not a resolvable color (gradient, image, var() token — makes
 * the effective background unknown), or `undefined` when the layer sets no
 * background at all (inherit from the ancestor).
 */
function backgroundOf(layer: Layer, classes: string[]): string | null | undefined {
  const backgrounds = layer.design?.backgrounds;
  const designColor = backgrounds?.backgroundColor;
  if (designColor && parseColor(designColor)) return designColor;

  const fromClass = parseColorClass(classes, 'bg-');
  if (fromClass) return rgbToHex(fromClass);

  const hasOpaqueDesignBg = Boolean(
    designColor || backgrounds?.bgGradientVars || backgrounds?.bgImageVars || backgrounds?.backgroundImage,
  );
  const hasBgClass = classes.some((c) => c.startsWith('bg-') && c !== 'bg-transparent');
  if (hasOpaqueDesignBg || hasBgClass) return null;

  return undefined;
}

type Rgb = { r: number; g: number; b: number };

/** Parse `text-[#hex]` / `bg-[rgb(...)]` arbitrary-value color classes. */
function parseColorClass(classes: string[], prefix: 'text-' | 'bg-'): Rgb | null {
  for (const cls of classes) {
    const match = new RegExp(`^${prefix}\\[(.+)\\]$`).exec(cls);
    if (match) {
      const parsed = parseColor(match[1]);
      if (parsed) return parsed;
    }
  }
  return null;
}

/** Literal hex/rgb colors only. var(), gradients, keywords, and alpha colors return null. */
function parseColor(value?: string | null): Rgb | null {
  if (!value) return null;
  const raw = value.trim();

  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(raw);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
    };
  }

  const rgb = /^rgb\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)\s*\)$/.exec(raw);
  if (rgb) {
    return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]) };
  }

  return null;
}

function rgbToHex(rgb: Rgb): string {
  const part = (n: number) => n.toString(16).padStart(2, '0');
  return `#${part(rgb.r)}${part(rgb.g)}${part(rgb.b)}`;
}

/** WCAG 2.x relative luminance. */
function luminance({ r, g, b }: Rgb): number {
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [lighter, darker] = la >= lb ? [la, lb] : [lb, la];
  return (lighter + 0.05) / (darker + 0.05);
}

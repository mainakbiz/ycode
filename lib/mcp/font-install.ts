import { readFile } from 'fs/promises';
import { join } from 'path';

import { broadcastFontsChanged } from '@/lib/mcp/broadcast';
import { createFont, getAllFonts } from '@/lib/repositories/fontRepository';

/**
 * Font auto-install guard for agent design edits.
 *
 * Agents routinely set `typography.fontFamily` without calling add_font first,
 * which silently renders as a browser fallback (the generated `font-[Family]`
 * class points at a family with no @font-face behind it). Rather than trust
 * the model to remember the extra step, the design tools collect every
 * fontFamily they apply and call `ensureFontsInstalled`, which installs any
 * missing family that exists in the Google Fonts catalog and reports the rest
 * as warnings the model can react to.
 *
 * The catalog loader lives here (shared with lib/mcp/tools/fonts.ts) so both
 * paths resolve families and weights identically.
 */

export interface GoogleFontEntry {
  family: string;
  variants: string[];
  category: string;
  axes?: { tag: string; start: number; end: number }[];
}

let catalogCache: GoogleFontEntry[] | null = null;

export async function loadGoogleFontsCatalog(): Promise<GoogleFontEntry[]> {
  if (catalogCache) return catalogCache;
  try {
    const raw = await readFile(join(process.cwd(), 'storage/fonts/google-fonts.json'), 'utf-8');
    catalogCache = JSON.parse(raw) as GoogleFontEntry[];
    return catalogCache;
  } catch {
    return [];
  }
}

export function getWeightsFromEntry(entry: GoogleFontEntry): string[] {
  const wghtAxis = entry.axes?.find(a => a.tag === 'wght');
  if (wghtAxis) {
    const weights: string[] = [];
    for (const w of [100, 200, 300, 400, 500, 600, 700, 800, 900]) {
      if (w >= wghtAxis.start && w <= wghtAxis.end) weights.push(String(w));
    }
    return weights.length > 0 ? weights : ['400'];
  }
  return entry.variants
    .filter(v => !v.includes('italic'))
    .map(v => v === 'regular' ? '400' : v.replace(/italic$/, ''))
    .filter(v => /^\d+$/.test(v));
}

/** Generic families that never need installing. */
const BUILT_IN_FAMILIES = new Set(['sans', 'serif', 'mono', 'sans-serif', 'monospace', 'system-ui', 'inherit']);

/**
 * Pull the custom font families out of a design payload as sent to the design
 * tools ({ typography: { fontFamily: "Sora" }, ... }). Handles font stacks
 * ("Sora, sans-serif") by taking the primary family.
 */
export function collectFontFamiliesFromDesign(design: Record<string, unknown> | undefined, into: Set<string>): void {
  const typography = design?.typography as { fontFamily?: unknown } | undefined;
  if (!typography || typeof typography.fontFamily !== 'string') return;

  const primary = typography.fontFamily.split(',')[0].trim().replace(/^["']|["']$/g, '');
  if (primary.length === 0 || BUILT_IN_FAMILIES.has(primary.toLowerCase())) return;
  into.add(primary);
}

export interface EnsureFontsResult {
  /** Families newly installed from the Google Fonts catalog. */
  installed: string[];
  /** Families neither installed on the site nor found in the catalog. */
  unknown: string[];
}

/**
 * Make sure every referenced family is actually installed on the site.
 * Families found in the Google Fonts catalog are added automatically (same
 * resolution as the add_font tool); anything else is returned in `unknown`
 * for the caller to surface as a warning.
 */
export async function ensureFontsInstalled(families: Set<string>): Promise<EnsureFontsResult> {
  const result: EnsureFontsResult = { installed: [], unknown: [] };
  if (families.size === 0) return result;

  const existing = await getAllFonts();
  const installedKeys = new Set(
    existing.flatMap((font) => [font.family.toLowerCase(), font.name.toLowerCase()]),
  );

  const missing = [...families].filter((family) => !installedKeys.has(family.toLowerCase()));
  if (missing.length === 0) return result;

  const catalog = await loadGoogleFontsCatalog();
  for (const family of missing) {
    const entry = catalog.find((f) => f.family.toLowerCase() === family.toLowerCase());
    if (!entry) {
      result.unknown.push(family);
      continue;
    }
    await createFont({
      name: entry.family.toLowerCase().replace(/\s+/g, '-'),
      family: entry.family,
      type: 'google',
      category: entry.category,
      weights: getWeightsFromEntry(entry),
      variants: entry.variants,
    });
    result.installed.push(entry.family);
  }

  if (result.installed.length > 0) {
    // Let open builders refetch and inject the new font CSS into the canvas.
    broadcastFontsChanged().catch(() => {});
  }

  return result;
}

/** Warning strings for the tool result, mirroring the design linter's tone. */
export function fontWarnings(result: EnsureFontsResult): string[] {
  return result.unknown.map((family) =>
    `Font "${family}" is not installed and was not found in the Google Fonts catalog — text using it will render with a fallback font. Use search_google_fonts to find the correct family name, or pick an installed font (list_fonts).`,
  );
}

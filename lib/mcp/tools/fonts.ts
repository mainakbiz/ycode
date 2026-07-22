import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { broadcastFontsChanged } from '@/lib/mcp/broadcast';
import { getWeightsFromEntry, loadGoogleFontsCatalog } from '@/lib/mcp/font-install';
import { getAllFonts, createFont, updateFont, deleteFont } from '@/lib/repositories/fontRepository';

export function registerFontTools(server: McpServer) {
  server.tool(
    'list_fonts',
    'List all fonts added to the site. Fonts can be referenced in design properties via fontFamily.',
    {},
    async () => {
      const fonts = await getAllFonts();
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(fonts.map((f) => ({
            id: f.id,
            name: f.name,
            family: f.family,
            type: f.type,
            category: f.category,
            weights: f.weights,
            variants: f.variants,
          })), null, 2),
        }],
      };
    },
  );

  server.tool(
    'search_google_fonts',
    `Search the Google Fonts catalog to discover available fonts. Returns font family names, categories, available weights, and variants. Use this before add_font to find the correct font details.`,
    {
      query: z.string().optional().describe('Search by font name (e.g. "playfair", "mono"). Omit to get the top fonts by popularity.'),
      category: z.enum(['sans-serif', 'serif', 'display', 'handwriting', 'monospace']).optional()
        .describe('Filter by category'),
      limit: z.number().optional().describe('Max results (default 20, max 50)'),
    },
    async ({ query, category, limit }) => {
      const catalog = await loadGoogleFontsCatalog();
      if (catalog.length === 0) {
        return { content: [{ type: 'text' as const, text: 'Error: Google Fonts catalog not available.' }], isError: true };
      }

      let results = catalog;
      if (query) {
        const q = query.toLowerCase();
        results = results.filter(f => f.family.toLowerCase().includes(q));
      }
      if (category) {
        results = results.filter(f => f.category === category);
      }

      const max = Math.min(limit || 20, 50);
      const matches = results.slice(0, max).map(f => ({
        family: f.family,
        category: f.category,
        weights: getWeightsFromEntry(f),
        variants: f.variants,
        variable: !!f.axes?.find(a => a.tag === 'wght'),
      }));

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ total: results.length, showing: matches.length, fonts: matches }, null, 2),
        }],
      };
    },
  );

  server.tool(
    'add_font',
    `Add a Google Font to the site. Once added, use the family name in typography.fontFamily design property.

TIP: Use search_google_fonts first to discover available fonts. If you provide just the family name, weights and variants will be auto-resolved from the catalog.`,
    {
      family: z.string().describe('Google Font family name (e.g. "Open Sans", "Playfair Display")'),
      weights: z.array(z.string()).optional().describe('Weights to include. Auto-resolved from catalog if omitted.'),
      variants: z.array(z.string()).optional().describe('Variants to include. Auto-resolved from catalog if omitted.'),
    },
    async ({ family, weights, variants }) => {
      const catalog = await loadGoogleFontsCatalog();
      const entry = catalog.find(f => f.family.toLowerCase() === family.toLowerCase());

      const resolvedFamily = entry?.family || family;
      const resolvedCategory = entry?.category || 'sans-serif';
      const resolvedWeights = weights || (entry ? getWeightsFromEntry(entry) : ['400', '700']);
      const resolvedVariants = variants || entry?.variants || ['regular'];
      const name = resolvedFamily.toLowerCase().replace(/\s+/g, '-');

      const font = await createFont({
        name,
        family: resolvedFamily,
        type: 'google',
        category: resolvedCategory,
        weights: resolvedWeights,
        variants: resolvedVariants,
      });
      broadcastFontsChanged().catch(() => {});
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            message: `Added font "${resolvedFamily}"`,
            font: { id: font.id, name: font.name, family: font.family, weights: resolvedWeights },
            usage: `Set typography.fontFamily to "${resolvedFamily}" in layer design`,
          }, null, 2),
        }],
      };
    },
  );

  server.tool(
    'update_font',
    'Update a font (change weights, variants, or category).',
    {
      font_id: z.string().describe('The font ID to update'),
      weights: z.array(z.string()).optional().describe('Updated list of weights (e.g. ["400", "500", "600", "700"])'),
      variants: z.array(z.string()).optional().describe('Updated list of variants'),
      category: z.string().optional().describe('Font category'),
    },
    async ({ font_id, weights, variants, category }) => {
      const updates: Record<string, unknown> = {};
      if (weights) updates.weights = weights;
      if (variants) updates.variants = variants;
      if (category) updates.category = category;
      const font = await updateFont(font_id, updates);
      broadcastFontsChanged().catch(() => {});
      return { content: [{ type: 'text' as const, text: JSON.stringify({ message: `Updated font "${font.family}"`, font }, null, 2) }] };
    },
  );

  server.tool(
    'delete_font',
    'Remove a font from the site. Layers using this font will fall back to the default font.',
    {
      font_id: z.string().describe('The font ID to delete'),
    },
    async ({ font_id }) => {
      await deleteFont(font_id);
      broadcastFontsChanged().catch(() => {});
      return {
        content: [{ type: 'text' as const, text: `Font ${font_id} deleted successfully.` }],
      };
    },
  );
}

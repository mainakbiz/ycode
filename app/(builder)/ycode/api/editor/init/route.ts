import { NextResponse } from 'next/server';
import { isAgentSecretSettingKey } from '@/lib/agent/config';
import { getAllDraftPages } from '@/lib/repositories/pageRepository';
import { getAllDraftLayers } from '@/lib/repositories/pageLayersRepository';
import { getAllPageFolders } from '@/lib/repositories/pageFolderRepository';
import { getAllComponents } from '@/lib/repositories/componentRepository';
import { getAllStyles } from '@/lib/repositories/layerStyleRepository';
import { getAllSettings } from '@/lib/repositories/settingsRepository';
import { getAllCollections } from '@/lib/repositories/collectionRepository';
import { getAllLocales } from '@/lib/repositories/localeRepository';
import { getAllAssets } from '@/lib/repositories/assetRepository';
import { getAllAssetFolders } from '@/lib/repositories/assetFolderRepository';
import { getAllFonts } from '@/lib/repositories/fontRepository';
import { getMapboxAccessToken, getGoogleMapsEmbedApiKey } from '@/lib/map-server';

/**
 * GET /ycode/api/editor/init
 * Get all initial data for the editor in one request:
 * - All draft (non-published) pages
 * - All draft layers
 * - All page folders
 * - All components
 * - All layer styles
 * - All settings
 * - All collections
 * - All locales
 * - All assets
 * - All asset folders
 * - All fonts
 */
export async function GET() {
  try {
    // Load all data in parallel (only drafts for editor). Named so a single
    // failing fetch is logged by name instead of being flattened into a generic
    // 500 (temporary diagnostic for the "Failed to load editor data" error).
    const tasks = {
      pages: getAllDraftPages(),
      drafts: getAllDraftLayers(),
      folders: getAllPageFolders({ is_published: false }),
      components: getAllComponents(),
      styles: getAllStyles(),
      settings: getAllSettings(),
      collections: getAllCollections(),
      locales: getAllLocales(),
      assets: getAllAssets(),
      assetFolders: getAllAssetFolders(false),
      fonts: getAllFonts(),
      mapbox: getMapboxAccessToken(),
      googleMaps: getGoogleMapsEmbedApiKey(),
    } as const;

    const settled = await Promise.allSettled(Object.values(tasks));
    const keys = Object.keys(tasks);
    const failures = settled
      .map((result, index) => ({ key: keys[index], result }))
      .filter((entry): entry is { key: string; result: PromiseRejectedResult } => entry.result.status === 'rejected');

    if (failures.length > 0) {
      for (const { key, result } of failures) {
        console.error(`[Editor init] "${key}" failed:`, result.reason);
      }
      throw new Error(`Editor init failed: ${failures.map((f) => f.key).join(', ')}`);
    }

    const [pages, drafts, folders, components, styles, settings, collections, locales, assets, assetFolders, fonts, resolvedMapboxToken, resolvedGoogleMapsEmbedKey] =
      settled.map((result) => (result as PromiseFulfilledResult<unknown>).value) as [
        Awaited<typeof tasks.pages>,
        Awaited<typeof tasks.drafts>,
        Awaited<typeof tasks.folders>,
        Awaited<typeof tasks.components>,
        Awaited<typeof tasks.styles>,
        Awaited<typeof tasks.settings>,
        Awaited<typeof tasks.collections>,
        Awaited<typeof tasks.locales>,
        Awaited<typeof tasks.assets>,
        Awaited<typeof tasks.assetFolders>,
        Awaited<typeof tasks.fonts>,
        Awaited<typeof tasks.mapbox>,
        Awaited<typeof tasks.googleMaps>,
      ];

    // Never ship secrets to the client (shared or per-user agent keys). The
    // agent API keys are only consumed server-side (lib/agent/config); the
    // settings UI reads a masked status from /ycode/api/settings/agent instead.
    // Inject app-sourced tokens into settings so they're available via settingsByKey
    const enrichedSettings = settings.filter((setting) => !isAgentSecretSettingKey(setting.key));
    const injectedTokens: [string, string, string | null][] = [
      ['app:mapbox:access_token', 'mapbox_access_token', resolvedMapboxToken],
      ['app:google-maps-embed:api_key', 'google_maps_embed_api_key', resolvedGoogleMapsEmbedKey],
    ];
    for (const [id, key, value] of injectedTokens) {
      if (value) {
        enrichedSettings.push({
          id,
          key,
          value,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
      }
    }

    return NextResponse.json({
      data: {
        pages,
        drafts,
        folders,
        components,
        styles,
        settings: enrichedSettings,
        collections,
        locales,
        assets,
        assetFolders,
        fonts,
      },
    });
  } catch (error) {
    console.error('Error loading editor data:', error);
    return NextResponse.json(
      { error: 'Failed to load editor data' },
      { status: 500 }
    );
  }
}

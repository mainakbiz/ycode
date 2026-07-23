import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getAllPages, getPageById, getPagesByFolder, createPage, updatePage, deletePage, duplicatePage } from '@/lib/repositories/pageRepository';
import { getAllPageFolders } from '@/lib/repositories/pageFolderRepository';
import { upsertDraftLayers } from '@/lib/repositories/pageLayersRepository';
import { getSettingByKey, setSetting } from '@/lib/repositories/settingsRepository';
import { broadcastPageCreated, broadcastPageUpdated, broadcastPageDeleted, broadcastLayersChanged } from '@/lib/mcp/broadcast';
import type { Redirect } from '@/types';

const REDIRECTS_KEY = 'redirects';

async function getRedirects(): Promise<Redirect[]> {
  const value = await getSettingByKey(REDIRECTS_KEY);
  return Array.isArray(value) ? value : [];
}

function generateRedirectId(): string {
  return `redirect_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export function registerPageTools(server: McpServer) {
  server.tool(
    'list_pages',
    'List all pages in the website with their IDs, names, slugs, and folder structure',
    {},
    async () => {
      const pages = await getAllPages();
      const folders = await getAllPageFolders();
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ pages, folders }) }],
      };
    },
  );

  server.tool(
    'get_page',
    'Get a single page by ID, including its settings and metadata',
    { page_id: z.string().describe('The page ID') },
    async ({ page_id }) => {
      const page = await getPageById(page_id);
      if (!page) {
        return { content: [{ type: 'text' as const, text: `Error: Page "${page_id}" not found.` }], isError: true };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(page) }] };
    },
  );

  server.tool(
    'create_page',
    `Create a new page. Returns the created page with its ID. The page is unpublished — use the publish tool to make it live.

DRAFT STATUS: Set is_publishable to false to keep this page as a draft that is skipped when the site is published (it will not go live until you flip it back to publishable). Defaults to publishable.`,
    {
      name: z.string().describe('Page title (e.g. "About Us", "Contact")'),
      slug: z.string().optional().describe('URL slug. Auto-generated from name if omitted.'),
      page_folder_id: z.string().nullable().optional().describe('Parent folder ID, or null for root'),
      is_index: z.boolean().optional().describe('Set to true to make this the homepage'),
      is_dynamic: z.boolean().optional().describe('Set to true for CMS dynamic pages'),
      is_publishable: z.boolean().optional().describe('Set to false to keep the page as a draft that is excluded from publishing. Defaults to true.'),
    },
    async (args) => {
      const isIndex = args.is_index || false;
      const slug = isIndex ? '' : (args.slug || args.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
      const folderId = args.page_folder_id ?? null;

      const siblings = await getPagesByFolder(folderId);
      const maxOrder = siblings.reduce((max, p) => Math.max(max, p.order ?? 0), -1);

      const page = await createPage({
        name: args.name,
        slug,
        is_published: false,
        ...(args.is_publishable !== undefined ? { is_publishable: args.is_publishable } : {}),
        page_folder_id: folderId,
        order: maxOrder + 1,
        depth: 0,
        is_index: isIndex,
        is_dynamic: args.is_dynamic || false,
        error_page: null,
        settings: {},
      });

      const initialLayers = [{
        id: 'body',
        name: 'body',
        classes: '',
        children: [],
      }];
      // Brand-new page guarantees no existing draft — assert it to skip the repo's pre-read.
      await upsertDraftLayers(page.id, initialLayers, undefined, null);

      broadcastPageCreated(page).catch(() => {});
      broadcastLayersChanged(page.id, initialLayers).catch(() => {});

      return { content: [{ type: 'text' as const, text: JSON.stringify(page) }] };
    },
  );

  server.tool(
    'update_page',
    `Update a page's metadata: name, slug, folder, homepage flag, dynamic flag, and error-page assignment.

ERROR PAGES: Set error_page to 401, 404, or 500 to designate this as the auth-required / not-found / server-error page for the site. Pass null to clear.
DYNAMIC PAGES: Set is_dynamic true to turn this into a CMS-driven page (then use update_page_settings.cms to bind it to a collection).
DRAFT STATUS: Set is_publishable to false to keep the page as a draft that is skipped when the site is published; set true to allow it to go live on the next publish.`,
    {
      page_id: z.string().describe('The page ID to update'),
      name: z.string().optional().describe('New page title'),
      slug: z.string().optional().describe('New URL slug'),
      page_folder_id: z.string().nullable().optional().describe('Move to folder ID, or null for root'),
      is_index: z.boolean().optional().describe('Mark as the homepage (only one page can be the index)'),
      is_dynamic: z.boolean().optional().describe('Turn into a CMS dynamic page'),
      is_publishable: z.boolean().optional().describe('Set false to keep the page as a draft excluded from publishing; true to allow it to go live on publish.'),
      error_page: z.union([z.literal(401), z.literal(404), z.literal(500)]).nullable().optional()
        .describe('Designate as 401 / 404 / 500 error page. Pass null to clear.'),
    },
    async ({ page_id, ...data }) => {
      const page = await updatePage(page_id, data);
      broadcastPageUpdated(page_id, data).catch(() => {});
      return { content: [{ type: 'text' as const, text: JSON.stringify(page) }] };
    },
  );

  server.tool(
    'update_page_settings',
    `Update page SEO, custom code, password protection, or CMS binding (dynamic pages).

SEO: Set title, description, noindex, and OG image (asset ID).
Custom code: Inject HTML into <head> or before </body>.
Password protection: Enable/disable with a password.
CMS binding: For dynamic pages — bind to a collection, pick the slug field, and configure
how next-item / previous-item links traverse the collection.`,
    {
      page_id: z.string().describe('The page ID'),
      seo: z.object({
        title: z.string().optional().describe('SEO title (appears in browser tab and search results)'),
        description: z.string().optional().describe('SEO meta description'),
        noindex: z.boolean().optional().describe('Prevent search engines from indexing this page'),
        image_asset_id: z.string().nullable().optional().describe('OG image asset ID for social sharing'),
      }).optional(),
      custom_code: z.object({
        head: z.string().optional().describe('HTML to inject into <head> (e.g. analytics scripts)'),
        body: z.string().optional().describe('HTML to inject before </body>'),
      }).optional(),
      auth: z.object({
        enabled: z.boolean().describe('Enable or disable password protection'),
        password: z.string().optional().describe('Password for accessing the page'),
      }).optional(),
      cms: z.object({
        collection_id: z.string().describe('Collection to drive this dynamic page'),
        slug_field_id: z.string().describe('Field whose value provides each item\'s URL slug'),
        next_previous: z.object({
          sort_by: z.string().optional().describe('"manual" (default) or a collection field ID'),
          sort_order: z.enum(['asc', 'desc']).optional(),
        }).optional().describe('Controls how next-item / previous-item link keywords traverse this page\'s collection.'),
      }).nullable().optional().describe('CMS binding for dynamic pages. Pass null to clear.'),
    },
    async ({ page_id, seo, custom_code, auth, cms }) => {
      const existing = await getPageById(page_id);
      if (!existing) {
        return { content: [{ type: 'text' as const, text: `Error: Page "${page_id}" not found.` }], isError: true };
      }

      const settings = { ...existing.settings };

      if (seo) {
        settings.seo = {
          ...(settings.seo || { title: '', description: '', noindex: false, image: null }),
          ...(seo.title !== undefined ? { title: seo.title } : {}),
          ...(seo.description !== undefined ? { description: seo.description } : {}),
          ...(seo.noindex !== undefined ? { noindex: seo.noindex } : {}),
          ...(seo.image_asset_id !== undefined ? { image: seo.image_asset_id } : {}),
        };
      }

      if (custom_code) {
        settings.custom_code = {
          ...(settings.custom_code || { head: '', body: '' }),
          ...(custom_code.head !== undefined ? { head: custom_code.head } : {}),
          ...(custom_code.body !== undefined ? { body: custom_code.body } : {}),
        };
      }

      if (auth) {
        settings.auth = {
          enabled: auth.enabled,
          password: auth.password || settings.auth?.password || '',
        };
      }

      if (cms !== undefined) {
        if (cms === null) {
          delete settings.cms;
        } else {
          settings.cms = {
            collection_id: cms.collection_id,
            slug_field_id: cms.slug_field_id,
            ...(cms.next_previous && {
              next_previous: {
                ...(cms.next_previous.sort_by !== undefined && { sort_by: cms.next_previous.sort_by as 'manual' | string }),
                ...(cms.next_previous.sort_order !== undefined && { sort_order: cms.next_previous.sort_order }),
              },
            }),
          };
        }
      }

      const page = await updatePage(page_id, { settings });
      broadcastPageUpdated(page_id, { settings }).catch(() => {});
      return { content: [{ type: 'text' as const, text: JSON.stringify({ message: 'Updated page settings', settings: page.settings }) }] };
    },
  );

  server.tool(
    'duplicate_page',
    'Create a copy of a page including all its layers.',
    { page_id: z.string().describe('The page ID to duplicate') },
    async ({ page_id }) => {
      const page = await duplicatePage(page_id);
      broadcastPageCreated(page).catch(() => {});
      return { content: [{ type: 'text' as const, text: JSON.stringify({ message: `Duplicated page as "${page.name}"`, page }) }] };
    },
  );

  server.tool(
    'delete_page',
    'Permanently delete a page and all its layers',
    { page_id: z.string().describe('The page ID to delete') },
    async ({ page_id }) => {
      await deletePage(page_id);
      broadcastPageDeleted(page_id).catch(() => {});
      return { content: [{ type: 'text' as const, text: `Page ${page_id} deleted successfully.` }] };
    },
  );

  server.tool(
    'list_redirects',
    `List all configured URL redirects. Redirects map an old path to a new URL (internal path
or external URL), with optional 301 (permanent) or 302 (temporary) semantics. Paths containing
".+" or ".*" are treated as regex patterns; exact matches take priority.`,
    {},
    async () => {
      const redirects = await getRedirects();
      return { content: [{ type: 'text' as const, text: JSON.stringify(redirects) }] };
    },
  );

  server.tool(
    'add_redirect',
    `Add a new URL redirect.

Examples:
- { old_url: "/about-us", new_url: "/about", type: "301" }
- { old_url: "/blog/(.*)", new_url: "/posts/$1" } (regex — $1 is the captured group)
- { old_url: "/", new_url: "/welcome" } (root / homepage redirect)`,
    {
      old_url: z.string().describe('The old internal path (must start with /). Use ".+" or ".*" for regex patterns.'),
      new_url: z.string().describe('The new destination — internal path "/about" or external URL "https://example.com"'),
      type: z.enum(['301', '302']).optional().describe('301 = permanent, 302 = temporary. Defaults to 301.'),
    },
    async ({ old_url, new_url, type }) => {
      const redirects = await getRedirects();
      const newRedirect: Redirect = {
        id: generateRedirectId(),
        oldUrl: old_url,
        newUrl: new_url,
        ...(type && { type }),
      };
      await setSetting(REDIRECTS_KEY, [...redirects, newRedirect]);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ message: 'Redirect added', redirect: newRedirect }) }] };
    },
  );

  server.tool(
    'update_redirect',
    'Update an existing redirect by ID.',
    {
      redirect_id: z.string().describe('The redirect ID'),
      old_url: z.string().optional(),
      new_url: z.string().optional(),
      type: z.enum(['301', '302']).optional(),
    },
    async ({ redirect_id, old_url, new_url, type }) => {
      const redirects = await getRedirects();
      const idx = redirects.findIndex((r) => r.id === redirect_id);
      if (idx === -1) {
        return { content: [{ type: 'text' as const, text: `Error: Redirect "${redirect_id}" not found.` }], isError: true };
      }
      const updated: Redirect = {
        ...redirects[idx],
        ...(old_url !== undefined && { oldUrl: old_url }),
        ...(new_url !== undefined && { newUrl: new_url }),
        ...(type !== undefined && { type }),
      };
      const next = [...redirects];
      next[idx] = updated;
      await setSetting(REDIRECTS_KEY, next);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ message: 'Redirect updated', redirect: updated }) }] };
    },
  );

  server.tool(
    'delete_redirect',
    'Delete a redirect by ID.',
    {
      redirect_id: z.string().describe('The redirect ID'),
    },
    async ({ redirect_id }) => {
      const redirects = await getRedirects();
      const next = redirects.filter((r) => r.id !== redirect_id);
      if (next.length === redirects.length) {
        return { content: [{ type: 'text' as const, text: `Error: Redirect "${redirect_id}" not found.` }], isError: true };
      }
      await setSetting(REDIRECTS_KEY, next);
      return { content: [{ type: 'text' as const, text: `Redirect ${redirect_id} deleted` }] };
    },
  );
}

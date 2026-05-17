/**
 * Static HTML Export
 *
 * Exports every published Ycode page to standalone HTML using the same
 * fetch + render pipeline as the live site:
 *
 *   page-fetcher (resolves components, collections, assets)
 *   → layerToExportHtml (semantic HTML with rich text, links, forms)
 *   → published_css (the same Tailwind output the live site serves)
 *
 * Output paths are S3-friendly:
 *   homepage         → out/index.html
 *   regular page     → out/<folder>/<slug>/index.html  (clean URLs)
 *   folder index     → out/<folder>/index.html
 *   error page (404) → out/404.html                    (also 401.html, 500.html)
 *
 * If S3 credentials are configured the same files are uploaded to the bucket
 * with appropriate Content-Type and Cache-Control headers.
 */

import { randomUUID } from 'crypto'
import fs from 'fs/promises'
import path from 'path'

import {
  fetchHomepage,
  fetchErrorPage,
  fetchPageByPath,
  layerToHtml,
  buildAnchorMap,
} from '@/lib/page-fetcher'
import type { PageData } from '@/lib/page-fetcher'
import { buildSlugPath } from '@/lib/page-utils'
import { getSupabaseAdmin } from '@/lib/supabase-server'
import { getSettingByKey } from '@/lib/repositories/settingsRepository'
import { getAppSettingValue, setAppSetting } from '@/lib/repositories/appSettingsRepository'
import { getValuesByFieldId } from '@/lib/repositories/collectionItemValueRepository'

import type { ExportConfig, ExportJob, OutputTarget } from './types'
import type { Page, PageFolder, Layer } from '@/types'

export const APP_ID = 'static-export'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: ExportConfig = {
  outputTargets: ['local'],
  autoExportOnPublish: false,
  localPath: './out',
  s3Bucket: '',
  s3Region: '',
  s3AccessKey: '',
  s3SecretKey: '',
  githubRepo: '',
  githubBranch: 'main',
  githubToken: '',
  githubAuthorName: '',
  githubAuthorEmail: '',
}

/**
 * Legacy → multi-select migration helper.
 * The pre-multi-select schema stored `output_target` as a single string
 * ('local' | 's3' | 'both'). Translate that into the array shape so
 * anyone who saved settings under the old draft schema isn't blocked.
 */
function migrateLegacyTarget(value: unknown): OutputTarget[] | null {
  if (typeof value !== 'string') return null
  if (value === 'local' || value === 's3') return [value]
  if (value === 'both') return ['local', 's3']
  return null
}

function normalizeOutputTargets(value: unknown): OutputTarget[] {
  if (Array.isArray(value)) {
    const allowed: OutputTarget[] = ['local', 's3', 'github']
    return value.filter((v): v is OutputTarget => allowed.includes(v as OutputTarget))
  }
  return migrateLegacyTarget(value) ?? []
}

export async function getExportConfig(): Promise<ExportConfig> {
  const [
    outputTargetsRaw,
    autoExportOnPublish,
    localPath,
    s3Bucket,
    s3Region,
    s3AccessKey,
    s3SecretKey,
    githubRepo,
    githubBranch,
    githubToken,
    githubAuthorName,
    githubAuthorEmail,
    legacyTarget,
  ] = await Promise.all([
    getAppSettingValue<unknown>(APP_ID, 'output_targets'),
    getAppSettingValue<boolean>(APP_ID, 'auto_export_on_publish'),
    getAppSettingValue<string>(APP_ID, 'local_path'),
    getAppSettingValue<string>(APP_ID, 's3_bucket'),
    getAppSettingValue<string>(APP_ID, 's3_region'),
    getAppSettingValue<string>(APP_ID, 's3_access_key'),
    getAppSettingValue<string>(APP_ID, 's3_secret_key'),
    getAppSettingValue<string>(APP_ID, 'github_repo'),
    getAppSettingValue<string>(APP_ID, 'github_branch'),
    getAppSettingValue<string>(APP_ID, 'github_token'),
    getAppSettingValue<string>(APP_ID, 'github_author_name'),
    getAppSettingValue<string>(APP_ID, 'github_author_email'),
    getAppSettingValue<unknown>(APP_ID, 'output_target'),
  ])

  // Prefer the new multi-select key; fall back to migrating the old single-value key.
  const outputTargets = normalizeOutputTargets(outputTargetsRaw ?? legacyTarget)

  return {
    outputTargets: outputTargets.length > 0 ? outputTargets : DEFAULT_CONFIG.outputTargets,
    autoExportOnPublish: autoExportOnPublish ?? DEFAULT_CONFIG.autoExportOnPublish,
    localPath: localPath ?? DEFAULT_CONFIG.localPath,
    s3Bucket: s3Bucket ?? DEFAULT_CONFIG.s3Bucket,
    s3Region: s3Region ?? DEFAULT_CONFIG.s3Region,
    s3AccessKey: s3AccessKey ?? DEFAULT_CONFIG.s3AccessKey,
    s3SecretKey: s3SecretKey ?? DEFAULT_CONFIG.s3SecretKey,
    githubRepo: githubRepo ?? DEFAULT_CONFIG.githubRepo,
    githubBranch: githubBranch ?? DEFAULT_CONFIG.githubBranch,
    githubToken: githubToken ?? DEFAULT_CONFIG.githubToken,
    githubAuthorName: githubAuthorName ?? DEFAULT_CONFIG.githubAuthorName,
    githubAuthorEmail: githubAuthorEmail ?? DEFAULT_CONFIG.githubAuthorEmail,
  }
}

export async function saveExportConfig(config: ExportConfig): Promise<void> {
  await Promise.all([
    setAppSetting(APP_ID, 'output_targets', normalizeOutputTargets(config.outputTargets)),
    setAppSetting(APP_ID, 'auto_export_on_publish', config.autoExportOnPublish),
    setAppSetting(APP_ID, 'local_path', config.localPath),
    setAppSetting(APP_ID, 's3_bucket', config.s3Bucket),
    setAppSetting(APP_ID, 's3_region', config.s3Region),
    setAppSetting(APP_ID, 's3_access_key', config.s3AccessKey),
    setAppSetting(APP_ID, 's3_secret_key', config.s3SecretKey),
    setAppSetting(APP_ID, 'github_repo', config.githubRepo),
    setAppSetting(APP_ID, 'github_branch', config.githubBranch),
    setAppSetting(APP_ID, 'github_token', config.githubToken),
    setAppSetting(APP_ID, 'github_author_name', config.githubAuthorName),
    setAppSetting(APP_ID, 'github_author_email', config.githubAuthorEmail),
  ])
}

// ---------------------------------------------------------------------------
// HTML rendering
// ---------------------------------------------------------------------------

/**
 * Render the visible body content of a page.
 *
 * Ycode wraps each page's layers in a synthetic `body` layer whose children
 * are the real content. We render those children directly so the output
 * doesn't carry an extra wrapper `<div>`.
 *
 * Uses the same `layerToHtml` Ycode runs server-side so we inherit:
 *  - all link types (url, page, email, phone, asset, anchor)
 *  - slider / lightbox data attributes + classes
 *  - resolved image / video / audio URLs
 *  - srcset / sizes / width / height attributes (no CLS)
 *  - background images and CSS color variables
 */
interface RenderContext {
  pages: Page[]
  folders: PageFolder[]
  components: PageData['components']
  locale: PageData['locale'] | null
  translations: PageData['translations'] | undefined
}

function renderPageBody(
  layers: Layer[] | null | undefined,
  ctx: RenderContext,
): string {
  if (!layers || layers.length === 0) return ''

  const bodyLayer = layers.find((l) => l.id === 'body' || l.name === 'body')
  const contentLayers = bodyLayer?.children ?? layers

  // Anchors reference layer IDs; build the lookup once so generateLinkHref
  // can resolve `#section` style anchors anywhere in the page.
  const anchorMap = buildAnchorMap(layers)

  return contentLayers
    .map((layer) =>
      layerToHtml(
        layer,
        undefined, // collectionItemId — not in a CMS context
        ctx.pages,
        ctx.folders,
        undefined, // collectionItemSlugs — built per-collection in dynamic flows
        ctx.locale ?? null,
        ctx.translations,
        anchorMap,
        undefined, // collectionItemData
        undefined, // pageCollectionItemData
        undefined, // assetMap — already resolved into the layer tree
        undefined, // layerDataMap
        ctx.components,
        undefined, // ancestorComponentIds
        false, // isSlideChild
        undefined, // pageLinkContext
      ),
    )
    .filter(Boolean)
    .join('\n')
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

interface PageSeo {
  title?: string | null
  description?: string | null
  image?: string | { id?: string; public_url?: string } | null
  noindex?: boolean
}

function extractSeo(page: Page): PageSeo {
  const seo = (page.settings as { seo?: PageSeo } | undefined)?.seo
  return seo ?? {}
}

function resolveSeoImage(image: PageSeo['image']): string | null {
  if (!image) return null
  if (typeof image === 'string') return image
  if (typeof image === 'object' && image.public_url) return image.public_url
  return null
}

interface BuildHtmlInput {
  page: Page
  bodyHtml: string
  publishedCss: string | null
  colorVariablesCss: string | null
  includeSwiper: boolean
}

// Swiper bundle URLs (pinned). Loaded only on pages that actually contain
// a slider so the rest of the site stays JS-free.
// Major version is kept in sync with the `swiper` dependency in package.json
// so the export and the live builder render identically.
const SWIPER_VERSION = '12'
const SWIPER_CSS_CDN = `https://cdn.jsdelivr.net/npm/swiper@${SWIPER_VERSION}/swiper-bundle.min.css`
const SWIPER_JS_CDN = `https://cdn.jsdelivr.net/npm/swiper@${SWIPER_VERSION}/swiper-bundle.min.js`

/**
 * Slider boot script — pure DOM port of components/SliderInitializer.tsx
 * + lib/slider-utils.ts. Mirrors `buildProductionSwiperOptions` faithfully
 * so behaviour matches the live Ycode site (bullet template, easing,
 * aria state). Deviating from production is what made the first cut fail.
 */
const SLIDER_BOOT_SCRIPT = `
(function () {
  // NOTE: defer doesn't apply to inline scripts, so this IIFE runs at parse
  // time — before the Swiper CDN script has loaded. The Swiper presence
  // check lives in boot(), which only fires after DOMContentLoaded (and
  // therefore after all deferred external scripts have evaluated).
  if (typeof window === 'undefined') return;
  var SPECIAL_EFFECTS = { fade: 1, cube: 1, flip: 1, coverflow: 1, cards: 1 };

  function applyEasing(sliderEl, easing) {
    var wrapper = sliderEl.querySelector('.swiper-wrapper');
    if (wrapper) wrapper.style.transitionTimingFunction = easing || 'ease-in-out';
  }

  function configureBulletRenderer(sliderEl, paginationConfig) {
    var paginationEl = sliderEl.querySelector('[data-slider-pagination]');
    if (!paginationEl || !paginationConfig || paginationConfig.type !== 'bullets') return;
    var template = paginationEl.querySelector('[data-layer-id]');
    if (!template) return;
    var html = template.outerHTML;
    paginationConfig.renderBullet = function (_, className) {
      var parts = html.split('class="');
      if (parts.length < 2) return '<span class="' + className + '">' + html + '</span>';
      return parts[0] + 'class="' + className + ' ' + parts[1];
    };
  }

  function syncStateAttributes(swiper) {
    function syncBullets() {
      var bullets = swiper.el.querySelectorAll('.swiper-pagination-bullet');
      bullets.forEach(function (b) {
        if (b.classList.contains('swiper-pagination-bullet-active')) b.setAttribute('aria-current', 'true');
        else b.removeAttribute('aria-current');
      });
    }
    function syncNav() {
      var btns = swiper.el.querySelectorAll('[data-slider-prev], [data-slider-next]');
      btns.forEach(function (btn) {
        if (btn.classList.contains('swiper-button-disabled')) btn.setAttribute('aria-disabled', 'true');
        else btn.removeAttribute('aria-disabled');
      });
    }
    function syncAll() { syncBullets(); syncNav(); }
    swiper.on('init', syncAll);
    swiper.on('slideChangeTransitionEnd', syncAll);
    swiper.on('paginationUpdate', syncBullets);
    swiper.on('navigationNext', syncNav);
    swiper.on('navigationPrev', syncNav);
    requestAnimationFrame(syncAll);
  }

  function buildConfig(s) {
    var config = {
      slidesPerView: 'auto',
      slidesPerGroup: s.slidesPerGroup || 1,
      centeredSlides: !!s.centered,
      speed: Math.round((parseFloat(s.duration) || 0.5) * 1000),
    };
    if (SPECIAL_EFFECTS[s.animationEffect]) config.effect = s.animationEffect;
    if (s.loop === 'loop') config.loop = true;
    else if (s.loop === 'rewind') config.rewind = true;

    config.allowTouchMove = !!s.touchEvents;
    config.slideToClickedSlide = !!s.slideToClicked;

    if (s.navigation) {
      config.navigation = {
        nextEl: '[data-slider-next]',
        prevEl: '[data-slider-prev]',
      };
    }
    if (s.pagination) {
      var isFraction = s.paginationType === 'fraction';
      config.pagination = {
        el: isFraction ? '[data-slider-fraction]' : '[data-slider-pagination]',
        type: isFraction ? 'fraction' : 'bullets',
        clickable: !!s.paginationClickable,
      };
    }
    if (s.autoplay) {
      config.autoplay = {
        delay: Math.round((parseFloat(s.delay) || 3) * 1000),
        disableOnInteraction: false,
        pauseOnMouseEnter: s.pauseOnHover !== false,
      };
    }
    if (s.mousewheel) config.mousewheel = true;
    return config;
  }

  function boot() {
    if (typeof window.Swiper !== 'function') {
      if (window.console) console.error('[Static Export] Swiper failed to load from CDN — sliders will not initialize.');
      return;
    }
    var sliders = document.querySelectorAll('[data-slider-id]');
    sliders.forEach(function (el) {
      var raw = el.getAttribute('data-slider-settings');
      if (!raw) return;
      var s; try { s = JSON.parse(raw); } catch (_) { return; }
      var config = buildConfig(s);
      configureBulletRenderer(el, config.pagination);
      try {
        var swiper = new window.Swiper(el, config);
        applyEasing(el, s.easing);
        syncStateAttributes(swiper);
        var pag = el.querySelector('[data-slider-pagination]');
        if (pag) pag.style.visibility = '';
      } catch (err) {
        if (window.console) console.error('[Static Export] Slider init failed:', err);
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
`.trim()

function buildDocument({
  page,
  bodyHtml,
  publishedCss,
  colorVariablesCss,
  includeSwiper,
}: BuildHtmlInput): string {
  const seo = extractSeo(page)
  const title = seo.title || page.name
  const description = seo.description ?? ''
  const ogImage = resolveSeoImage(seo.image)
  const noindex = seo.noindex || page.error_page !== null

  const head: string[] = []
  head.push('<meta charset="UTF-8" />')
  head.push('<meta name="viewport" content="width=device-width, initial-scale=1.0" />')
  head.push(`<title>${escapeHtml(title)}</title>`)
  if (description) {
    head.push(`<meta name="description" content="${escapeHtml(description)}" />`)
    head.push(`<meta property="og:description" content="${escapeHtml(description)}" />`)
  }
  head.push(`<meta property="og:title" content="${escapeHtml(title)}" />`)
  head.push(`<meta property="og:type" content="website" />`)
  if (ogImage) {
    head.push(`<meta property="og:image" content="${escapeHtml(ogImage)}" />`)
    head.push(`<meta name="twitter:card" content="summary_large_image" />`)
    head.push(`<meta name="twitter:image" content="${escapeHtml(ogImage)}" />`)
  }
  if (noindex) head.push('<meta name="robots" content="noindex" />')

  // Inline the same CSS bundle the live site serves so the page renders
  // without depending on a runtime Tailwind compiler.
  const css = [colorVariablesCss, publishedCss].filter(Boolean).join('\n')
  if (css) head.push(`<style>${css}</style>`)

  // Swiper CSS goes in <head> so the slider doesn't flash unstyled before
  // the bundle on jsDelivr arrives.
  if (includeSwiper) {
    head.push(`<link rel="stylesheet" href="${SWIPER_CSS_CDN}" />`)
  }

  const indent = '  '
  const trailingScripts: string[] = []
  if (includeSwiper) {
    // Plain (not deferred) script tag for Swiper: placed at end of <body>
    // so it runs after the slider DOM is parsed but before DOMContentLoaded.
    // The boot script then runs (also at body-end) and waits for
    // DOMContentLoaded internally if it hasn't fired yet.
    trailingScripts.push(`<script src="${SWIPER_JS_CDN}"></script>`)
    trailingScripts.push(`<script>${SLIDER_BOOT_SCRIPT}</script>`)
  }

  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    ...head.map((line) => indent + line),
    '</head>',
    '<body>',
    bodyHtml,
    ...trailingScripts,
    '</body>',
    '</html>',
    '',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Output path resolution
// ---------------------------------------------------------------------------

/**
 * Compute the key (relative path) where the page should be written.
 *
 * The conventions match how S3 static hosting and CloudFront expect files:
 *   - the homepage and folder index pages → `<dir>/index.html`
 *   - any other page → `<dir>/<slug>/index.html` for clean URLs
 *   - error pages → `<code>.html` at the bucket root, suitable for the
 *     "Error document" setting on an S3 website
 */
function computeOutputKey(page: Page, folders: PageFolder[]): string {
  if (page.error_page !== null && page.error_page !== undefined) {
    return `${page.error_page}.html`
  }

  const slugPath = buildSlugPath(page, folders, 'page') // '/' for homepage; '/foo' or '/foo/bar' otherwise
  const trimmed = slugPath.replace(/^\/+/, '').replace(/\/+$/, '')

  if (!trimmed) return 'index.html'
  return `${trimmed}/index.html`
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

interface ResolvedPage {
  page: Page
  bodyHtml: string
  outputKey: string
  hasSlider: boolean
}

interface PageCmsSettings {
  collection_id?: string
  slug_field_id?: string
}

/**
 * Yield one resolved page per route the source page produces:
 *   - static page  → 1
 *   - error page   → 1 (at /<code>.html)
 *   - homepage     → 1 (at /index.html)
 *   - dynamic page → N, one per published collection item (skipped if the
 *     collection has no items or the CMS config is missing)
 *
 * Each resolution goes through the same fetcher the live site uses so the
 * layer tree comes back with components, collections, references, and
 * assets all resolved.
 */
async function* resolvePages(
  page: Page,
  folders: PageFolder[],
  pages: Page[],
): AsyncGenerator<ResolvedPage> {
  // --- Error pages ----------------------------------------------------------
  if (page.error_page !== null && page.error_page !== undefined) {
    const data = (await fetchErrorPage(page.error_page, true)) as PageData | null
    if (data) {
      const resolved = renderResolved(data.page, data, folders, pages, `${page.error_page}.html`)
      if (resolved) yield resolved
    }
    return
  }

  // --- Homepage -------------------------------------------------------------
  if (page.is_index && page.page_folder_id === null) {
    const data = (await fetchHomepage(true)) as PageData | null
    if (data) {
      const resolved = renderResolved(data.page, data, folders, pages, 'index.html')
      if (resolved) yield resolved
    }
    return
  }

  // --- Dynamic CMS pages ---------------------------------------------------
  if (page.is_dynamic) {
    const cms = (page.settings as { cms?: PageCmsSettings } | undefined)?.cms
    if (!cms?.collection_id || !cms.slug_field_id) {
      console.warn(`[Static Export] Dynamic page "${page.name}" has no CMS config — skipping`)
      return
    }
    const slugValues = await getValuesByFieldId(cms.slug_field_id, true)
    if (slugValues.length === 0) {
      console.warn(`[Static Export] Dynamic page "${page.name}" has no published items — skipping`)
      return
    }
    for (const row of slugValues) {
      const itemSlug = typeof row.value === 'string' ? row.value : String(row.value ?? '')
      if (!itemSlug) continue
      const pattern = buildSlugPath(page, folders, 'page', '{slug}') // '/products/{slug}'
      const slugPath = pattern.replace(/\{slug\}/g, itemSlug).replace(/^\/+/, '')
      const data = await fetchPageByPath(slugPath, true)
      if (!data?.pageLayers?.layers) {
        console.warn(`[Static Export] Could not resolve "${page.name}" item "${itemSlug}"`)
        continue
      }
      const outputKey = `${slugPath}/index.html`
      const resolved = renderResolved(data.page, data, folders, pages, outputKey)
      if (resolved) yield resolved
    }
    return
  }

  // --- Static pages --------------------------------------------------------
  const slugPath = buildSlugPath(page, folders, 'page').replace(/^\/+/, '')
  const data = await fetchPageByPath(slugPath, true)
  if (!data?.pageLayers?.layers) return
  const resolved = renderResolved(data.page, data, folders, pages, computeOutputKey(page, folders))
  if (resolved) yield resolved
}

function renderResolved(
  page: Page,
  data: PageData,
  folders: PageFolder[],
  pages: Page[],
  outputKey: string,
): ResolvedPage | null {
  if (!data.pageLayers?.layers) return null
  const layers = data.pageLayers.layers
  const bodyHtml = renderPageBody(layers, {
    pages,
    folders,
    components: data.components,
    locale: data.locale ?? null,
    translations: data.translations,
  })
  return {
    page,
    bodyHtml,
    outputKey,
    hasSlider: layerTreeContains(layers, 'slider'),
  }
}

function layerTreeContains(layers: Layer[], name: string): boolean {
  for (const layer of layers) {
    if (layer.name === name) return true
    if (layer.children && layerTreeContains(layer.children, name)) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Writers (collect-then-flush model)
// ---------------------------------------------------------------------------
//
// Each writer takes the full list of output files at once. This shape:
//   - lets the GitHub writer commit atomically (one push per export)
//   - lets the local + S3 writers stay simple per-file loops
//   - lets multiple targets run sequentially against the same artifact set

interface OutputFile {
  /** Relative key, e.g. "index.html" or "ycode/layouts/assets/foo.webp" */
  key: string
  body: string | Buffer
  contentType: string
}

interface Writer {
  /** Human-readable target name for logging. */
  name: OutputTarget
  /** Writes the file list and returns the count actually written. */
  flush(files: OutputFile[]): Promise<number>
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
}

function contentTypeFor(key: string): string {
  const ext = path.extname(key).toLowerCase()
  return MIME_TYPES[ext] ?? 'application/octet-stream'
}

const MEDIA_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

function mediaContentType(filename: string): string {
  const ext = path.extname(filename).toLowerCase()
  return MEDIA_MIME_TYPES[ext] ?? 'application/octet-stream'
}

// ---------------------------------------------------------------------------
// Local writer
// ---------------------------------------------------------------------------

function createLocalWriter(config: ExportConfig): Writer {
  const basePath = path.isAbsolute(config.localPath)
    ? config.localPath
    : path.resolve(config.localPath)

  return {
    name: 'local',
    async flush(files) {
      for (const f of files) {
        const filePath = path.join(basePath, f.key)
        await fs.mkdir(path.dirname(filePath), { recursive: true })
        const body = typeof f.body === 'string' ? Buffer.from(f.body, 'utf-8') : f.body
        await fs.writeFile(filePath, body)
      }
      return files.length
    },
  }
}

// ---------------------------------------------------------------------------
// S3 writer
// ---------------------------------------------------------------------------

async function createS3Writer(config: ExportConfig): Promise<Writer> {
  if (!config.s3Bucket || !config.s3Region) {
    throw new Error('S3 export selected but bucket and region are required')
  }
  if (!config.s3AccessKey || !config.s3SecretKey) {
    throw new Error('S3 export selected but access key and secret are required')
  }

  // Dynamic import so the AWS SDK stays out of the bundle for users who only
  // export locally. The dependency is installed eagerly via package.json so
  // failures here mean a misconfigured environment, not a missing feature.
  type S3ClientCtor = typeof import('@aws-sdk/client-s3').S3Client
  type PutObjectCmdCtor = typeof import('@aws-sdk/client-s3').PutObjectCommand
  let S3Client: S3ClientCtor
  let PutObjectCommand: PutObjectCmdCtor
  try {
    const aws = await import('@aws-sdk/client-s3')
    S3Client = aws.S3Client
    PutObjectCommand = aws.PutObjectCommand
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(
      `Failed to load @aws-sdk/client-s3. Run "npm install @aws-sdk/client-s3" and retry. (${message})`,
    )
  }

  const client = new S3Client({
    region: config.s3Region,
    credentials: {
      accessKeyId: config.s3AccessKey,
      secretAccessKey: config.s3SecretKey,
    },
  })

  return {
    name: 's3',
    async flush(files) {
      let written = 0
      for (const f of files) {
        await client.send(
          new PutObjectCommand({
            Bucket: config.s3Bucket,
            Key: f.key,
            Body: f.body,
            ContentType: f.contentType,
            // HTML pages must revalidate so a publish is visible
            // immediately. Hashed asset URLs would use a long max-age.
            CacheControl: 'public, max-age=0, must-revalidate',
          }),
        )
        written++
      }
      return written
    },
  }
}

// ---------------------------------------------------------------------------
// GitHub writer
// ---------------------------------------------------------------------------

const GITHUB_REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/
const GITHUB_BRANCH_RE = /^[A-Za-z0-9._/-]+$/
const GITHUB_TOKEN_RE = /^[A-Za-z0-9_-]+$/

interface GithubWriterContext {
  config: ExportConfig
}

async function createGithubWriter(config: ExportConfig): Promise<Writer> {
  if (!GITHUB_REPO_RE.test(config.githubRepo)) {
    throw new Error('GitHub export selected but `githubRepo` must look like "owner/repo"')
  }
  if (!GITHUB_BRANCH_RE.test(config.githubBranch)) {
    throw new Error('GitHub export selected but `githubBranch` has invalid characters')
  }
  if (!GITHUB_TOKEN_RE.test(config.githubToken)) {
    throw new Error('GitHub export selected but `githubToken` looks malformed')
  }

  // The actual git work happens at flush() time so we don't clone an empty
  // repo on construction. Pulling git out into a small ESM-only helper keeps
  // the static-export entry tree-shakeable for local-only deployments.
  const ctx: GithubWriterContext = { config }
  return {
    name: 'github',
    async flush(files) {
      return runGithubFlush(ctx, files)
    },
  }
}

async function runGithubFlush(
  ctx: GithubWriterContext,
  files: OutputFile[],
): Promise<number> {
  const { spawn } = await import('node:child_process')
  const os = await import('node:os')

  const { config } = ctx
  const authorName = config.githubAuthorName.trim() || 'Ycode Static Export'
  const authorEmail = config.githubAuthorEmail.trim() || 'static-export@ycode.local'

  // Build the auth URL once; the token never goes through a shell.
  // git uses the URL we hand it via argv, so injection isn't a risk as long
  // as we pass argv (not a shell string) and the inputs match the regexes.
  const cloneUrl =
    `https://x-access-token:${encodeURIComponent(config.githubToken)}@github.com/` +
    `${config.githubRepo}.git`

  // Each export gets a fresh tmpdir to avoid stale state between runs and to
  // sidestep concurrent-export races at the cost of one clone per run.
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ycode-static-export-'))
  try {
    const exec = (args: string[], opts: { env?: NodeJS.ProcessEnv; cwd?: string; stdin?: string } = {}) =>
      new Promise<{ stdout: string; stderr: string; code: number }>((resolve, reject) => {
        const child = spawn('git', args, {
          cwd: opts.cwd ?? workDir,
          env: { ...process.env, ...opts.env, GIT_TERMINAL_PROMPT: '0' },
        })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (d) => { stdout += d.toString() })
        child.stderr.on('data', (d) => { stderr += d.toString() })
        child.on('error', reject)
        child.on('close', (code) => resolve({ stdout, stderr, code: code ?? -1 }))
        if (opts.stdin !== undefined) {
          child.stdin.end(opts.stdin)
        }
      })

    // Try to clone the target branch shallowly. If the branch doesn't exist
    // yet (empty repo / first deploy), fall back to cloning the default
    // branch and switching to a new orphan branch.
    let cloneOk = false
    {
      const r = await exec(
        ['clone', '--depth=1', '--single-branch', `--branch=${config.githubBranch}`, cloneUrl, '.'],
        { cwd: workDir },
      )
      cloneOk = r.code === 0
      if (!cloneOk && !/(Remote branch .* not found|empty repository)/i.test(r.stderr)) {
        throw new Error(`git clone failed (${r.code}): ${trimGitOutput(r.stderr)}`)
      }
    }

    if (!cloneOk) {
      // Fresh init in workDir for the case of an empty repository.
      const init = await exec(['init', '-b', config.githubBranch], { cwd: workDir })
      if (init.code !== 0) throw new Error(`git init failed: ${trimGitOutput(init.stderr)}`)
      const remote = await exec(['remote', 'add', 'origin', cloneUrl])
      if (remote.code !== 0) throw new Error(`git remote add failed: ${trimGitOutput(remote.stderr)}`)
    }

    // Identity must be set before commits — author info is signed into the
    // commit object, not pulled from global ~/.gitconfig.
    await exec(['config', 'user.name', authorName])
    await exec(['config', 'user.email', authorEmail])

    // Wipe non-.git contents so deletions reflect in the commit. Without
    // this, removing a page from Ycode wouldn't remove the file from the
    // deploy repo.
    for (const entry of await fs.readdir(workDir)) {
      if (entry === '.git') continue
      await fs.rm(path.join(workDir, entry), { recursive: true, force: true })
    }

    // Drop all output files into the working tree.
    for (const f of files) {
      const target = path.join(workDir, f.key)
      await fs.mkdir(path.dirname(target), { recursive: true })
      const body = typeof f.body === 'string' ? Buffer.from(f.body, 'utf-8') : f.body
      await fs.writeFile(target, body)
    }

    const add = await exec(['add', '-A'])
    if (add.code !== 0) throw new Error(`git add failed: ${trimGitOutput(add.stderr)}`)

    // If nothing changed, skip the commit + push so the deploy repo doesn't
    // collect empty no-op commits.
    const status = await exec(['status', '--porcelain'])
    if (status.code === 0 && status.stdout.trim().length === 0) {
      return 0
    }

    const message = `Static export — ${files.length} file${files.length === 1 ? '' : 's'} — ${new Date().toISOString()}`
    const commit = await exec(['commit', '-m', message])
    if (commit.code !== 0) throw new Error(`git commit failed: ${trimGitOutput(commit.stderr)}`)

    const push = await exec(['push', '-u', 'origin', config.githubBranch])
    if (push.code !== 0) throw new Error(`git push failed: ${trimGitOutput(push.stderr)}`)

    return files.length
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {})
  }
}

/** Trim known token leakage from git stderr so it's safe to log. */
function trimGitOutput(stderr: string): string {
  // The token can leak into a URL stderr line. Redact anything between
  // `x-access-token:` and `@github.com` to be safe.
  return stderr
    .replace(/x-access-token:[^@\s]+@/g, 'x-access-token:***@')
    .slice(0, 4096)
}

// ---------------------------------------------------------------------------
// Public-asset bundler (used after the page loop)
// ---------------------------------------------------------------------------

/**
 * Read referenced Ycode template placeholders from /public and append them
 * to the output list. Only the URLs actually used are pulled in.
 */
async function collectPublicAssets(urlPaths: string[]): Promise<OutputFile[]> {
  const publicDir = path.join(process.cwd(), 'public')
  const out: OutputFile[] = []
  for (const urlPath of urlPaths) {
    const relPath = urlPath.replace(/^\/+/, '')
    try {
      const buf = await fs.readFile(path.join(publicDir, relPath))
      out.push({ key: relPath, body: buf, contentType: mediaContentType(relPath) })
    } catch (err) {
      // Some templates reference paths that aren't actually in /public
      // (e.g. user-deleted files). Logging is enough — the HTML still
      // renders, the image just 404s.
      console.warn(
        `[Static Export] Could not bundle ${urlPath}: ${
          err instanceof Error ? err.message : err
        }`,
      )
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function exportSite(): Promise<ExportJob> {
  const jobId = randomUUID()
  const job: ExportJob = {
    id: jobId,
    status: 'running',
    startedAt: new Date().toISOString(),
    completedAt: null,
    error: null,
    pagesExported: 0,
    filesWritten: 0,
  }

  try {
    const config = await getExportConfig()

    if (config.outputTargets.length === 0) {
      throw new Error('No output target selected — pick at least one of: local, S3, GitHub')
    }

    const client = await getSupabaseAdmin()
    if (!client) throw new Error('Supabase client not configured')

    // ---- Load pages (one query, all published, all routes) --------------
    const { data: pageRows, error: pagesError } = await client
      .from('pages')
      .select('*')
      .eq('is_published', true)
      .is('deleted_at', null)
      .order('depth', { ascending: true })
      .order('order', { ascending: true })

    if (pagesError) throw new Error(`Failed to fetch pages: ${pagesError.message}`)
    const pages = (pageRows ?? []) as Page[]
    if (pages.length === 0) {
      job.status = 'completed'
      job.completedAt = new Date().toISOString()
      return job
    }

    // ---- Folders + shared CSS in parallel --------------------------------
    const [folderResult, publishedCss, colorVariablesCss] = await Promise.all([
      client
        .from('page_folders')
        .select('*')
        .is('deleted_at', null)
        .order('depth', { ascending: true }),
      getSettingByKey('published_css').catch(() => null),
      getSettingByKey('color_variables_css').catch(() => null),
    ])
    if (folderResult.error) {
      throw new Error(`Failed to fetch folders: ${folderResult.error.message}`)
    }
    const folders = (folderResult.data ?? []) as PageFolder[]

    if (!publishedCss) {
      console.warn(
        '[Static Export] No published_css found — publish the site once to generate the CSS bundle.',
      )
    }

    // ---- Render every page into the OutputFile list ---------------------
    const outputs: OutputFile[] = []
    const referencedAssetPaths = new Set<string>()

    for (const page of pages) {
      let yieldedAny = false
      try {
        for await (const resolved of resolvePages(page, folders, pages)) {
          yieldedAny = true
          const html = buildDocument({
            page: resolved.page,
            bodyHtml: resolved.bodyHtml,
            publishedCss: publishedCss ?? null,
            colorVariablesCss: colorVariablesCss ?? null,
            includeSwiper: resolved.hasSlider,
          })

          // Collect Ycode's built-in placeholder URLs referenced from this
          // page so we can ship them alongside the HTML for fully
          // self-contained hosting on S3 or GitHub.
          for (const match of html.matchAll(/\/ycode\/layouts\/assets\/[^"'\s)]+/g)) {
            referencedAssetPaths.add(match[0])
          }

          outputs.push({
            key: resolved.outputKey,
            body: html,
            contentType: contentTypeFor(resolved.outputKey),
          })
          job.pagesExported++
        }
      } catch (err) {
        console.warn(
          `[Static Export] Failed to resolve "${page.name}" (${page.id}): ${
            err instanceof Error ? err.message : err
          }`,
        )
        continue
      }
      if (!yieldedAny) {
        console.warn(`[Static Export] Skipping "${page.name}" — no routes produced`)
      }
    }

    // ---- Bundle referenced placeholder assets ---------------------------
    // Ycode templates reference images under /ycode/layouts/assets/*. These
    // live in /public on the running app — for S3 or GitHub hosting they
    // need to ship with the export so the URLs resolve.
    if (referencedAssetPaths.size > 0) {
      const assetFiles = await collectPublicAssets(Array.from(referencedAssetPaths))
      outputs.push(...assetFiles)
    }

    // ---- Flush to every configured target -------------------------------
    const writers: Writer[] = []
    for (const target of config.outputTargets) {
      if (target === 'local') writers.push(createLocalWriter(config))
      else if (target === 's3') writers.push(await createS3Writer(config))
      else if (target === 'github') writers.push(await createGithubWriter(config))
    }

    for (const writer of writers) {
      try {
        const count = await writer.flush(outputs)
        job.filesWritten += count
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        throw new Error(`Writer "${writer.name}" failed: ${message}`)
      }
    }

    job.status = 'completed'
    job.completedAt = new Date().toISOString()
    return job
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown export error'
    console.error(`[Static Export] Export ${jobId} failed:`, message)
    job.status = 'failed'
    job.completedAt = new Date().toISOString()
    job.error = message
    return job
  }
}

export { computeOutputKey }

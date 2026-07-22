/**
 * Airtable richText → TipTap JSON conversion.
 *
 * The implementation now lives in the shared, app-agnostic `lib/markdown-to-tiptap`
 * module so other server-side paths (e.g. the AI agent's CMS collection item
 * tools) can reuse the exact same converter. Re-exported here to preserve the
 * existing Airtable import path.
 */

export { markdownToTiptapJson } from '@/lib/markdown-to-tiptap';

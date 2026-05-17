/**
 * Standalone static-export CLI
 *
 * Triggers the same export pipeline the Ycode app uses, but without
 * needing a logged-in session or a running Next.js server. Credentials
 * come from .env so nothing sensitive lives in source.
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/export.ts
 */

// `lib/credentials.ts` calls `import 'server-only'` which throws outside
// Next.js. We don't need that protection in a one-shot CLI, so install a
// shim BEFORE dynamic-importing anything that transitively reaches it.
import { Module } from 'node:module'

type RequireFn = (id: string) => unknown
const moduleProto = Module.prototype as unknown as { require: RequireFn }
const originalRequire: RequireFn = moduleProto.require
moduleProto.require = function patchedRequire(this: unknown, id: string): unknown {
  if (id === 'server-only') return {}
  return originalRequire.call(this, id)
}

async function main(): Promise<void> {
  if (!process.env.SUPABASE_URL && !process.env.SUPABASE_CONNECTION_URL) {
    console.error(
      'Missing Supabase credentials. Run with `npx tsx --env-file=.env scripts/export.ts` ' +
        'or export SUPABASE_URL / SUPABASE_SECRET_KEY in your shell.',
    )
    process.exit(1)
  }

  // Dynamic import so the require shim is in place before the engine loads
  // `lib/credentials.ts` via the supabase server client.
  const { exportSite } = await import('../lib/apps/static-export')

  console.log('Running static export…')
  const start = Date.now()
  const job = await exportSite()
  const ms = Date.now() - start

  if (job.status === 'failed') {
    console.error(`✗ Export failed: ${job.error}`)
    process.exit(1)
  }

  console.log(`✓ Exported ${job.pagesExported} pages → ${job.filesWritten} files in ${ms}ms`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

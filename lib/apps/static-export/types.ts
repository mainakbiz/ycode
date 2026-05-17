/**
 * Static Export Integration Types
 *
 * Type definitions for the static HTML/CSS/JS export integration.
 * Covers configuration, export jobs, and status tracking.
 */

// =============================================================================
// Export Configuration
// =============================================================================

/** Where exported files can be written. Multiple targets can be active. */
export type OutputTarget = 'local' | 's3' | 'github'

export interface ExportConfig {
  /** Active output destinations (multi-select). Empty array = no-op export. */
  outputTargets: OutputTarget[]
  /** Automatically trigger an export when the site is published */
  autoExportOnPublish: boolean

  // ---- Local target ----
  /** Local output directory (absolute or relative to process.cwd()) */
  localPath: string

  // ---- S3 / S3-compatible target ----
  /** Bucket name (e.g. my-bucket) */
  s3Bucket: string
  /** AWS region (e.g. us-east-1) */
  s3Region: string
  /** Access key ID */
  s3AccessKey: string
  /** Secret access key */
  s3SecretKey: string

  // ---- GitHub target ----
  /** Target repository as "owner/name" (e.g. "ycode/my-static-site") */
  githubRepo: string
  /** Branch to push to (created if missing, default: "main") */
  githubBranch: string
  /** Personal access token with `repo` (or fine-grained Contents:write) scope */
  githubToken: string
  /** Commit author name. Defaults to "Ycode Static Export" if empty. */
  githubAuthorName: string
  /** Commit author email. Defaults to "static-export@ycode.local" if empty. */
  githubAuthorEmail: string
}

// =============================================================================
// Export Status
// =============================================================================

export type ExportStatus = 'idle' | 'running' | 'completed' | 'failed'

// =============================================================================
// Export Job
// =============================================================================

export interface ExportJob {
  /** Unique job identifier (UUID) */
  id: string
  /** Current status of the export */
  status: ExportStatus
  /** ISO timestamp when the export started */
  startedAt: string | null
  /** ISO timestamp when the export completed (or failed) */
  completedAt: string | null
  /** Error message if status is 'failed' */
  error: string | null
  /** Number of pages successfully exported */
  pagesExported: number
  /** Number of files written across all targets (counts duplicate writes per target) */
  filesWritten: number
}

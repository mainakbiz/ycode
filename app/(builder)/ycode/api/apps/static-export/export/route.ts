import { NextRequest } from 'next/server';
import { exportSite } from '@/lib/apps/static-export';
import { noCache } from '@/lib/api-response';

import type { ExportJob } from '@/lib/apps/static-export/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * In-memory storage for the most recent export job.
 * Simple module-level variable — resets on server restart.
 */
export let lastExportJob: ExportJob | null = null;

/**
 * POST /ycode/api/apps/static-export/export
 * Trigger a static export of all published pages.
 *
 * Fire-and-forget: starts the export async and returns immediately
 * with the initial job status. Use /status to poll for completion.
 */
export async function POST(_request: NextRequest) {
  try {
    // Start the export — fire it off without awaiting for the HTTP response
    exportSite().then((job) => {
      lastExportJob = job;
    }).catch((err) => {
      console.error('[Static Export] Export job failed:', err);
    });

    return noCache({
      data: {
        message: 'Export started',
        status: 'running',
      },
    });
  } catch (error) {
    console.error('Error starting static export:', error);
    return noCache(
      { error: error instanceof Error ? error.message : 'Failed to start export' },
      500
    );
  }
}

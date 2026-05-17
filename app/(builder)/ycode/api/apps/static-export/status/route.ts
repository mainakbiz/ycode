import { noCache } from '@/lib/api-response';
import { lastExportJob } from '@/app/(builder)/ycode/api/apps/static-export/export/route';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /ycode/api/apps/static-export/status
 * Return the current export status (last ExportJob).
 *
 * Returns null data if no export has been triggered yet.
 */
export async function GET() {
  try {
    if (!lastExportJob) {
      return noCache({ data: null });
    }

    return noCache({ data: lastExportJob });
  } catch (error) {
    console.error('Error fetching export status:', error);
    return noCache(
      { error: error instanceof Error ? error.message : 'Failed to fetch status' },
      500
    );
  }
}

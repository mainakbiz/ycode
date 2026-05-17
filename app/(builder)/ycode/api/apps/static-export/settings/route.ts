import { NextRequest } from 'next/server';
import { getExportConfig, saveExportConfig } from '@/lib/apps/static-export';
import { deleteAllAppSettings } from '@/lib/repositories/appSettingsRepository';
import { noCache } from '@/lib/api-response';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /ycode/api/apps/static-export/settings
 * Retrieve the current static export configuration
 */
export async function GET() {
  try {
    const config = await getExportConfig();
    return noCache({ data: config });
  } catch (error) {
    console.error('Error fetching static export config:', error);
    return noCache(
      { error: error instanceof Error ? error.message : 'Failed to fetch config' },
      500
    );
  }
}

/**
 * PUT /ycode/api/apps/static-export/settings
 * Save the static export configuration
 *
 * Body: ExportConfig object
 */
const ALLOWED_TARGETS = ['local', 's3', 'github'] as const;
const GITHUB_REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const GITHUB_BRANCH_RE = /^[A-Za-z0-9._/-]+$/;
const GITHUB_TOKEN_RE = /^[A-Za-z0-9_-]+$/;

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();

    // outputTargets must be an array of allowed strings, at least one entry
    if (!Array.isArray(body.outputTargets) || body.outputTargets.length === 0) {
      return noCache({ error: 'outputTargets must include at least one of: local, s3, github' }, 400);
    }
    for (const t of body.outputTargets) {
      if (!ALLOWED_TARGETS.includes(t)) {
        return noCache({ error: `Unknown output target: "${t}"` }, 400);
      }
    }

    if (body.outputTargets.includes('local')) {
      if (typeof body.localPath !== 'string' || !body.localPath.trim()) {
        return noCache({ error: 'localPath is required when "local" is a target' }, 400);
      }
    }

    if (body.outputTargets.includes('github')) {
      if (typeof body.githubRepo !== 'string' || !GITHUB_REPO_RE.test(body.githubRepo)) {
        return noCache({ error: 'githubRepo must look like "owner/repo"' }, 400);
      }
      if (typeof body.githubBranch !== 'string' || !GITHUB_BRANCH_RE.test(body.githubBranch)) {
        return noCache({ error: 'githubBranch has invalid characters' }, 400);
      }
      if (typeof body.githubToken !== 'string' || !GITHUB_TOKEN_RE.test(body.githubToken)) {
        return noCache({ error: 'githubToken looks malformed (expected PAT)' }, 400);
      }
    }

    await saveExportConfig(body);

    const config = await getExportConfig();
    return noCache({ data: config });
  } catch (error) {
    console.error('Error saving static export config:', error);
    return noCache(
      { error: error instanceof Error ? error.message : 'Failed to save config' },
      500
    );
  }
}

/**
 * DELETE /ycode/api/apps/static-export/settings
 * Remove all static-export settings (disconnect)
 */
export async function DELETE() {
  try {
    await deleteAllAppSettings('static-export');
    return noCache({ message: 'Static export settings cleared' });
  } catch (error) {
    console.error('Error deleting static export settings:', error);
    return noCache(
      { error: error instanceof Error ? error.message : 'Failed to delete settings' },
      500
    );
  }
}

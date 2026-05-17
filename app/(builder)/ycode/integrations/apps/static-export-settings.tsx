'use client'

import { useState, useEffect } from 'react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import {
  Field,
  FieldDescription,
  FieldLabel,
} from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import {
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'

// =============================================================================
// Types — mirrors lib/apps/static-export/types.ts ExportConfig
// =============================================================================

type OutputTarget = 'local' | 's3' | 'github'

interface StaticExportConfig {
  outputTargets: OutputTarget[]
  autoExportOnPublish: boolean
  localPath: string
  s3Bucket: string
  s3Region: string
  s3AccessKey: string
  s3SecretKey: string
  githubRepo: string
  githubBranch: string
  githubToken: string
  githubAuthorName: string
  githubAuthorEmail: string
}

const DEFAULT_CONFIG: StaticExportConfig = {
  outputTargets: ['local'],
  autoExportOnPublish: false,
  localPath: './out',
  s3Bucket: '',
  s3Region: 'us-east-1',
  s3AccessKey: '',
  s3SecretKey: '',
  githubRepo: '',
  githubBranch: 'main',
  githubToken: '',
  githubAuthorName: '',
  githubAuthorEmail: '',
}

const TARGET_OPTIONS: Array<{ value: OutputTarget; label: string; hint: string }> = [
  { value: 'local', label: 'Local filesystem', hint: 'Write files to a folder on this server' },
  { value: 's3', label: 'Amazon S3', hint: 'Upload to an S3 (or S3-compatible) bucket' },
  { value: 'github', label: 'GitHub repository', hint: 'Push to a repo — auto-deploys via Amplify, Pages, Netlify, Vercel' },
]

const TARGET_ORDER: OutputTarget[] = ['local', 's3', 'github']

// =============================================================================
// Component
// =============================================================================

export default function StaticExportSettings() {
  // Config state
  const [config, setConfig] = useState<StaticExportConfig>(DEFAULT_CONFIG)
  const [savedConfig, setSavedConfig] = useState<StaticExportConfig | null>(null)
  const [isConnected, setIsConnected] = useState(false)
  const [isLoading, setIsLoading] = useState(true)

  // Action state
  const [isSaving, setIsSaving] = useState(false)
  const [isExporting, setIsExporting] = useState(false)

  // Disconnect dialog
  const [showDisconnect, setShowDisconnect] = useState(false)

  // =========================================================================
  // Load settings on mount
  // =========================================================================

  useEffect(() => {
    loadSettings()
  }, [])

  const loadSettings = async () => {
    setIsLoading(true)
    try {
      const response = await fetch('/ycode/api/apps/static-export/settings')
      const result = await response.json()

      if (result.data && Object.keys(result.data).length > 0) {
        // Merge incoming data over defaults so any new fields stay populated.
        const loaded: StaticExportConfig = {
          ...DEFAULT_CONFIG,
          ...result.data,
          outputTargets:
            Array.isArray(result.data.outputTargets) && result.data.outputTargets.length > 0
              ? result.data.outputTargets
              : DEFAULT_CONFIG.outputTargets,
        }
        setConfig(loaded)
        setSavedConfig(loaded)
        setIsConnected(true)
      }
    } catch {
      // Not connected — that's fine
    } finally {
      setIsLoading(false)
    }
  }

  // =========================================================================
  // Helpers
  // =========================================================================

  const updateConfig = (updates: Partial<StaticExportConfig>) => {
    setConfig((prev) => ({ ...prev, ...updates }))
  }

  const toggleTarget = (target: OutputTarget, checked: boolean) => {
    setConfig((prev) => {
      const set = new Set(prev.outputTargets)
      if (checked) set.add(target)
      else set.delete(target)
      // Preserve canonical order for stable diffs / saves.
      const ordered: OutputTarget[] = TARGET_ORDER.filter((t) => set.has(t))
      return { ...prev, outputTargets: ordered }
    })
  }

  const has = (target: OutputTarget) => config.outputTargets.includes(target)

  const hasChanges = savedConfig
    ? JSON.stringify(config) !== JSON.stringify(savedConfig)
    : true

  // =========================================================================
  // Save settings
  // =========================================================================

  const handleSave = async () => {
    setIsSaving(true)
    try {
      const response = await fetch('/ycode/api/apps/static-export/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      })

      if (response.ok) {
        setSavedConfig({ ...config })
        setIsConnected(true)
        toast.success('Settings saved')
      } else {
        const result = await response.json().catch(() => ({}))
        toast.error(result.error || 'Failed to save settings')
      }
    } catch {
      toast.error('Failed to save settings')
    } finally {
      setIsSaving(false)
    }
  }

  // =========================================================================
  // Export Now
  // =========================================================================

  const handleExport = async () => {
    setIsExporting(true)
    try {
      if (hasChanges) {
        await fetch('/ycode/api/apps/static-export/settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(config),
        })
      }

      const response = await fetch('/ycode/api/apps/static-export/export', {
        method: 'POST',
      })

      const result = await response.json()

      if (response.ok) {
        toast.success('Export started', {
          description: result.data?.message || 'Static site export has been triggered.',
        })
      } else {
        toast.error('Export failed', {
          description: result.error || 'The export service returned an error.',
        })
      }
    } catch {
      toast.error('Export failed', {
        description: 'Could not reach the export service.',
      })
    } finally {
      setIsExporting(false)
    }
  }

  // =========================================================================
  // Disconnect
  // =========================================================================

  const handleDisconnect = async () => {
    try {
      await fetch('/ycode/api/apps/static-export/settings', {
        method: 'DELETE',
      })

      setConfig(DEFAULT_CONFIG)
      setSavedConfig(null)
      setIsConnected(false)
      setShowDisconnect(false)
      toast.success('Static export disconnected')
    } catch {
      toast.error('Failed to disconnect')
    }
  }

  // =========================================================================
  // Render
  // =========================================================================

  if (isLoading) {
    return (
      <>
        <SheetHeader>
          <SheetTitle>Static Export</SheetTitle>
          <SheetDescription className="sr-only">
            Static export integration settings
          </SheetDescription>
        </SheetHeader>
        <div className="flex items-center justify-center py-12">
          <Spinner />
        </div>
      </>
    )
  }

  return (
    <>
      <SheetHeader>
        <SheetTitle className="mr-auto">Static Export</SheetTitle>
        <div className="flex items-center gap-2">
          {isConnected && (
            <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
              Connected
            </Badge>
          )}
          {isConnected && (
            <Button
              variant="secondary"
              size="xs"
              onClick={() => setShowDisconnect(true)}
            >
              Disconnect
            </Button>
          )}
        </div>
        <SheetDescription className="sr-only">
          Static export integration settings
        </SheetDescription>
      </SheetHeader>

      <div className="mt-3 space-y-8">
        {/* Description */}
        <FieldDescription className="flex flex-col gap-2">
          <span>
            Export your published site as static HTML/CSS/JS files. Host anywhere:
            local filesystem, S3, or push to a GitHub repo that triggers Amplify /
            Cloudflare Pages / Netlify / Vercel.
          </span>
        </FieldDescription>

        {/* Export Targets — multi-select */}
        <Field>
          <FieldLabel>Export Targets</FieldLabel>
          <FieldDescription>Select one or more destinations.</FieldDescription>
          <div className="mt-2 space-y-2">
            {TARGET_OPTIONS.map((opt) => (
              <label key={opt.value} className="flex items-start gap-2 cursor-pointer">
                <Checkbox
                  checked={has(opt.value)}
                  onCheckedChange={(checked) => toggleTarget(opt.value, checked === true)}
                  className="mt-0.5"
                />
                <div className="flex flex-col">
                  <span className="text-xs font-medium">{opt.label}</span>
                  <span className="text-[11px] text-muted-foreground">{opt.hint}</span>
                </div>
              </label>
            ))}
          </div>
        </Field>

        {/* Local Path */}
        {has('local') && (
          <Field>
            <FieldLabel htmlFor="local-path">Local Path</FieldLabel>
            <Input
              id="local-path"
              placeholder="./out"
              value={config.localPath}
              onChange={(e) => updateConfig({ localPath: e.target.value })}
              className="font-mono text-xs"
            />
          </Field>
        )}

        {/* S3 Section */}
        {has('s3') && (
          <div className="space-y-4 border-t pt-6">
            <FieldLabel>Amazon S3</FieldLabel>

            <Field>
              <FieldLabel htmlFor="s3-bucket">Bucket Name</FieldLabel>
              <Input
                id="s3-bucket"
                placeholder="my-static-site"
                value={config.s3Bucket}
                onChange={(e) => updateConfig({ s3Bucket: e.target.value })}
                className="font-mono text-xs"
              />
            </Field>

            <Field>
              <FieldLabel htmlFor="s3-region">Region</FieldLabel>
              <Input
                id="s3-region"
                placeholder="us-east-1"
                value={config.s3Region}
                onChange={(e) => updateConfig({ s3Region: e.target.value })}
                className="font-mono text-xs"
              />
            </Field>

            <Field>
              <FieldLabel htmlFor="s3-access-key">Access Key</FieldLabel>
              <Input
                id="s3-access-key"
                placeholder="AKIAIO...MPLE"
                value={config.s3AccessKey}
                onChange={(e) => updateConfig({ s3AccessKey: e.target.value })}
                className="font-mono text-xs"
              />
            </Field>

            <Field>
              <FieldLabel htmlFor="s3-secret-key">Secret Key</FieldLabel>
              <Input
                id="s3-secret-key"
                type="password"
                placeholder="Enter your S3 secret key"
                value={config.s3SecretKey}
                onChange={(e) => updateConfig({ s3SecretKey: e.target.value })}
                className="font-mono text-xs"
              />
            </Field>
          </div>
        )}

        {/* GitHub Section */}
        {has('github') && (
          <div className="space-y-4 border-t pt-6">
            <FieldLabel>GitHub repository</FieldLabel>
            <FieldDescription>
              Pushes the export as a commit on each run. Hook this branch up to
              Amplify, Cloudflare Pages, Netlify, Vercel, or GitHub Pages for
              auto-deploy.
            </FieldDescription>

            <Field>
              <FieldLabel htmlFor="github-repo">Repository</FieldLabel>
              <Input
                id="github-repo"
                placeholder="owner/repo"
                value={config.githubRepo}
                onChange={(e) => updateConfig({ githubRepo: e.target.value })}
                className="font-mono text-xs"
              />
            </Field>

            <Field>
              <FieldLabel htmlFor="github-branch">Branch</FieldLabel>
              <Input
                id="github-branch"
                placeholder="main"
                value={config.githubBranch}
                onChange={(e) => updateConfig({ githubBranch: e.target.value })}
                className="font-mono text-xs"
              />
            </Field>

            <Field>
              <FieldLabel htmlFor="github-token">Personal Access Token</FieldLabel>
              <Input
                id="github-token"
                type="password"
                placeholder="ghp_..."
                value={config.githubToken}
                onChange={(e) => updateConfig({ githubToken: e.target.value })}
                className="font-mono text-xs"
              />
              <FieldDescription>
                Needs `repo` (or fine-grained Contents: write) scope on the target repo.
              </FieldDescription>
            </Field>

            <Field>
              <FieldLabel htmlFor="github-author-name">Commit Author Name (optional)</FieldLabel>
              <Input
                id="github-author-name"
                placeholder="Ycode Static Export"
                value={config.githubAuthorName}
                onChange={(e) => updateConfig({ githubAuthorName: e.target.value })}
                className="text-xs"
              />
            </Field>

            <Field>
              <FieldLabel htmlFor="github-author-email">Commit Author Email (optional)</FieldLabel>
              <Input
                id="github-author-email"
                placeholder="static-export@ycode.local"
                value={config.githubAuthorEmail}
                onChange={(e) => updateConfig({ githubAuthorEmail: e.target.value })}
                className="font-mono text-xs"
              />
            </Field>
          </div>
        )}

        {/* Auto-export Toggle */}
        <div className="space-y-4 border-t pt-6">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label className="text-xs font-medium">
                Auto-export on publish
              </Label>
              <FieldDescription>
                Automatically trigger an export every time you publish your site.
              </FieldDescription>
            </div>
            <Switch
              checked={config.autoExportOnPublish}
              onCheckedChange={(checked) =>
                updateConfig({ autoExportOnPublish: checked })
              }
              size="sm"
            />
          </div>
        </div>

        {/* Actions */}
        <div className="flex gap-2 pt-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={handleExport}
            disabled={isExporting || config.outputTargets.length === 0}
          >
            {isExporting && <Spinner className="size-3" />}
            Export Now
          </Button>
          <Button
            size="sm"
            onClick={handleSave}
            disabled={!hasChanges || isSaving}
          >
            {isSaving && <Spinner className="size-3" />}
            Save
          </Button>
        </div>
      </div>

      {/* Disconnect Dialog */}
      <ConfirmDialog
        open={showDisconnect}
        onOpenChange={setShowDisconnect}
        title="Disconnect Static Export?"
        description="This will remove your export configuration. Auto-export will be disabled and you'll need to reconfigure to export again."
        confirmLabel="Disconnect"
        cancelLabel="Cancel"
        confirmVariant="destructive"
        onConfirm={handleDisconnect}
        onCancel={() => setShowDisconnect(false)}
      />
    </>
  )
}

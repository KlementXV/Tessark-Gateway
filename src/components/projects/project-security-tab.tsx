"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { FileBox, RadioTower, TriangleAlert } from "lucide-react"
import { toast } from "sonner"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { extractErrorMessage } from "@/lib/api-error"

interface SaveResult {
  succeeded: number
  failed: number
  /** Registry names that took the policy but are too old for SBOM generation. */
  sbomUnsupported: string[]
  errors: { registryName: string; error: string }[]
}

function Toggle({
  id,
  checked,
  onChange,
  disabled,
  icon: Icon,
  title,
  hint,
}: {
  id: string
  checked: boolean
  onChange: (value: boolean) => void
  disabled: boolean
  icon: React.ComponentType<{ className?: string }>
  title: string
  hint: string
}) {
  return (
    <div className="flex items-start gap-3 rounded-md border p-3">
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <Label htmlFor={id} className="text-sm font-medium">
          {title}
        </Label>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} disabled={disabled} />
    </div>
  )
}

/**
 * Scan-on-push and SBOM-on-push for the project, across every Harbor of its cluster.
 *
 * These are Harbor project metadata, not Gateway bookkeeping: turning one on changes what
 * each member does with every image pushed from now on. The per-member outcome is reported
 * rather than reduced to "saved" — a policy that reached three Harbors out of four is a
 * different situation from one that reached all of them, and only the first needs acting on.
 */
export function ProjectSecurityTab({
  projectId,
  autoScan: initialAutoScan,
  autoSbom: initialAutoSbom,
  canEdit,
  isActive,
}: {
  projectId: string
  autoScan: boolean
  autoSbom: boolean
  /** Global ADMIN: may change what every Harbor of the cluster does on push. */
  canEdit: boolean
  isActive: boolean
}) {
  const t = useTranslations("projects.security")
  const router = useRouter()
  const [autoScan, setAutoScan] = React.useState(initialAutoScan)
  const [autoSbom, setAutoSbom] = React.useState(initialAutoSbom)
  const [saving, setSaving] = React.useState(false)
  const [result, setResult] = React.useState<SaveResult | null>(null)

  const dirty = autoScan !== initialAutoScan || autoSbom !== initialAutoSbom
  const locked = !canEdit || !isActive || saving

  async function save() {
    setSaving(true)
    setResult(null)
    try {
      const res = await fetch(`/api/projects/${projectId}/scan-policy`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ autoScan, autoSbom }),
      })
      const body = await res.json().catch(() => null)
      if (!res.ok) {
        toast.error(extractErrorMessage(body, t("saveFailed")))
        return
      }
      const summary = body as SaveResult
      setResult(summary)
      if (summary.failed === 0) toast.success(t("saved", { count: summary.succeeded }))
      else toast.warning(t("savedPartial", { ok: summary.succeeded, ko: summary.failed }))
      router.refresh()
    } catch {
      toast.error(t("saveFailed"))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <p className="text-sm text-muted-foreground">{t("intro")}</p>

      <div className="flex flex-col gap-2">
        <Toggle
          id="auto-scan"
          checked={autoScan}
          onChange={setAutoScan}
          disabled={locked}
          icon={RadioTower}
          title={t("autoScanTitle")}
          hint={t("autoScanHint")}
        />
        <Toggle
          id="auto-sbom"
          checked={autoSbom}
          onChange={setAutoSbom}
          disabled={locked}
          icon={FileBox}
          title={t("autoSbomTitle")}
          hint={t("autoSbomHint")}
        />
      </div>

      {!isActive && (
        <p className="rounded-md border border-dashed px-3 py-2.5 text-xs text-muted-foreground">
          {t("inactive")}
        </p>
      )}

      {canEdit && (
        <div className="flex items-center gap-3">
          <Button type="button" onClick={save} disabled={!dirty || locked}>
            {saving ? t("saving") : t("save")}
          </Button>
          {dirty && <span className="text-xs text-muted-foreground">{t("unsaved")}</span>}
        </div>
      )}

      {/* What actually happened, per Harbor. A member that refused is queued and will be
          retried by the reconciler, which is worth saying rather than leaving as a red count. */}
      {result && (result.failed > 0 || result.sbomUnsupported.length > 0) && (
        <div className="flex flex-col gap-2 rounded-md border border-warning/40 bg-warning/5 p-3 text-xs">
          {result.sbomUnsupported.length > 0 && (
            <p className="flex items-start gap-2">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden="true" />
              <span>{t("sbomUnsupported", { registries: result.sbomUnsupported.join(", ") })}</span>
            </p>
          )}
          {result.errors.map((entry) => (
            <p key={entry.registryName} className="flex items-start gap-2">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden="true" />
              <span>
                <span className="font-medium">{entry.registryName}</span> — {entry.error}{" "}
                {t("queued")}
              </span>
            </p>
          ))}
        </div>
      )}
    </div>
  )
}

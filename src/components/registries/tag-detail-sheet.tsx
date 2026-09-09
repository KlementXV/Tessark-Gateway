"use client"

import * as React from "react"
import { AlertCircle, RefreshCw } from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { CopyButton } from "@/components/ui/copy-button"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import type { HarborArtifactDetail } from "@/lib/registries/harbor"
import type { ManifestInfo } from "@/lib/registries/types"
import { ArtifactSecurity } from "./artifact-security"
import { ArtifactKindBadge } from "./artifact-kind"

function formatBytes(bytes: number): string {
  if (!bytes) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB"]
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / 1024 ** i).toFixed(1)} ${units[i]}`
}

interface ManifestResponse {
  manifest: ManifestInfo
  /** Null when Harbor has nothing on this artifact — the manifest still renders. */
  artifact: HarborArtifactDetail | null
}

export function TagDetailSheet({
  open,
  onOpenChange,
  manifestUrl,
  vulnerabilitiesUrl,
  sbomUrl,
  scanTrigger,
  tag,
  repo,
  imageHost,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  manifestUrl: string
  /** Sibling of manifestUrl for the full CVE list — fetched lazily, only if asked. */
  vulnerabilitiesUrl: string
  /** Sibling of manifestUrl serving the SBOM as a download. */
  sbomUrl: string
  /** Registry id and repo, so the sheet can ask Harbor to redo a scan. Absent for non-admins. */
  scanTrigger?: { url: string; repo: string; reference: string }
  tag: string
  /** Repository path, project prefix included. */
  repo: string
  /** Host of the registry, when known — see TagList.pullReference. */
  imageHost: string | null
}) {
  const t = useTranslations("registries.tagSheet")
  const tr = useTranslations("registries")
  const tc = useTranslations("common")
  const [data, setData] = React.useState<ManifestResponse | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const loadFailed = t("loadFailed")
  const [reloadKey, setReloadKey] = React.useState(0)
  const repoPath = imageHost ? `${imageHost}/${repo}` : repo
  const tagReference = `${repoPath}:${tag}`

  React.useEffect(() => {
    if (!open) return
    const controller = new AbortController()

    // Reset state for the newly opened tag, then fetch its manifest.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true)
    setError(null)
    setData(null)

    fetch(manifestUrl, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(
            (await res.json().catch(() => null))?.error ?? loadFailed
          )
        }
        return res.json() as Promise<ManifestResponse>
      })
      .then(setData)
      .catch((err) => {
        if (!controller.signal.aborted) {
          setError(err instanceof Error ? err.message : loadFailed)
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })

    return () => controller.abort()
  }, [open, manifestUrl, reloadKey, loadFailed])

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full gap-0 sm:max-w-lg">
        <SheetHeader className="border-b pr-12">
          <SheetTitle className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="break-all font-mono text-base">{tag}</span>
            {data?.artifact && <ArtifactKindBadge artifact={data.artifact} />}
          </SheetTitle>
          <SheetDescription>{t("description")}</SheetDescription>
          {/* The pull reference sits above the manifest because it is what most visits to
              this sheet are for, and it is available before the manifest has loaded. */}
          <div className="mt-1 flex min-w-0 items-center gap-2 rounded-md border bg-muted/40 py-1 pl-3">
            <code className="min-w-0 flex-1 truncate font-mono text-xs" title={tagReference}>
              {tagReference}
            </code>
            <CopyButton value={tagReference} label={t("copyReference", { reference: tagReference })} />
          </div>
        </SheetHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
          {loading && (
            <div className="flex flex-col gap-4" aria-busy="true" aria-label={t("loading")}>
              <div className="flex flex-col gap-2">
                <Skeleton className="h-3 w-16" />
                <Skeleton className="h-4 w-full" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="flex flex-col gap-2">
                  <Skeleton className="h-3 w-20" />
                  <Skeleton className="h-4 w-16" />
                </div>
                <div className="flex flex-col gap-2">
                  <Skeleton className="h-3 w-20" />
                  <Skeleton className="h-4 w-28" />
                </div>
              </div>
              <div className="flex flex-col gap-2">
                <Skeleton className="h-3 w-16" />
                <Skeleton className="h-24 w-full rounded-md" />
              </div>
            </div>
          )}

          {error && (
            <div
              role="alert"
              className="flex flex-col gap-3 rounded-md border border-destructive/30 bg-destructive/5 p-3"
            >
              <div className="flex items-start gap-2">
                <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-destructive">{t("unavailable")}</p>
                  <p className="mt-0.5 break-words text-xs text-muted-foreground">{error}</p>
                </div>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="self-start"
                onClick={() => setReloadKey((key) => key + 1)}
              >
                <RefreshCw />
                {tr("retry")}
              </Button>
            </div>
          )}

          {data && (
            <div className="animate-enter flex flex-col gap-4">
              <section className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-xs font-medium text-muted-foreground">{t("digest")}</h3>
                  <div className="flex items-center gap-1">
                    {/* Two useful strings, not one: the bare digest for an API call or a
                        comparison, and the digest-pinned reference for an immutable pull. */}
                    <CopyButton
                      value={`${repoPath}@${data.manifest.digest}`}
                      label={t("copyPinnedReference", {
                        reference: `${repoPath}@${data.manifest.digest}`,
                      })}
                      size="icon-xs"
                    />
                    <CopyButton value={data.manifest.digest} label={t("copyDigest")} size="icon-xs" />
                  </div>
                </div>
                <code className="block break-all rounded-md border bg-muted/40 px-3 py-2 text-xs leading-relaxed">
                  {data.manifest.digest}
                </code>
              </section>

              <dl className="grid grid-cols-2 divide-x rounded-md border">
                <div className="flex min-w-0 flex-col gap-1 px-3 py-2.5">
                  <dt className="text-xs font-medium text-muted-foreground">{t("totalSize")}</dt>
                  <dd className="text-sm tabular-nums">{formatBytes(data.manifest.totalSize)}</dd>
                </div>
                <div className="flex min-w-0 flex-col gap-1 px-3 py-2.5">
                  <dt className="text-xs font-medium text-muted-foreground">{t("platform")}</dt>
                  {/* A chart targets no platform at all, which is not the same as a platform
                      nobody could determine — an index Harbor has not expanded reads "—" too,
                      so the chart case says so in words. */}
                  <dd className="text-sm">
                    {data.artifact?.kind === "chart"
                      ? t("platformNotApplicable")
                      : (data.artifact?.platform ?? tc("none"))}
                  </dd>
                </div>
                <div className="col-span-2 flex min-w-0 flex-col gap-1 border-t px-3 py-2.5">
                  <dt className="text-xs font-medium text-muted-foreground">{t("mediaType")}</dt>
                  <dd className="break-words text-xs leading-relaxed">{data.manifest.mediaType}</dd>
                </div>
              </dl>

              {data.artifact?.chart && (
                <section className="flex flex-col gap-2">
                  <h3 className="text-xs font-medium text-muted-foreground">{t("chartTitle")}</h3>
                  <dl className="grid grid-cols-2 divide-x rounded-md border">
                    <div className="flex min-w-0 flex-col gap-1 px-3 py-2.5">
                      <dt className="text-xs font-medium text-muted-foreground">{t("chartVersion")}</dt>
                      <dd className="truncate font-mono text-sm">
                        {data.artifact.chart.version ?? tc("none")}
                      </dd>
                    </div>
                    <div className="flex min-w-0 flex-col gap-1 px-3 py-2.5">
                      {/* The version of what the chart deploys, which is what someone asking
                          "is this the nginx we run?" actually wants — and which the tag,
                          being the chart's own version, never answers. */}
                      <dt className="text-xs font-medium text-muted-foreground">{t("chartAppVersion")}</dt>
                      <dd className="truncate font-mono text-sm">
                        {data.artifact.chart.appVersion ?? tc("none")}
                      </dd>
                    </div>
                    {data.artifact.chart.description && (
                      <div className="col-span-2 flex min-w-0 flex-col gap-1 border-t px-3 py-2.5">
                        <dt className="text-xs font-medium text-muted-foreground">
                          {t("chartDescription")}
                        </dt>
                        <dd className="text-xs leading-relaxed">{data.artifact.chart.description}</dd>
                      </div>
                    )}
                  </dl>
                </section>
              )}

              <section className="flex flex-col gap-2">
                <h3 className="text-xs font-medium text-muted-foreground">{t("securityTitle")}</h3>
                <ArtifactSecurity
                  vulnerabilities={data.artifact?.vulnerabilities ?? null}
                  supplyChain={data.artifact?.supplyChain ?? null}
                  isChart={data.artifact?.kind === "chart"}
                  cvesUrl={vulnerabilitiesUrl}
                  sbomUrl={sbomUrl}
                  scanTrigger={scanTrigger}
                  onRefresh={() => setReloadKey((key) => key + 1)}
                />
              </section>

              <section className="flex flex-col gap-2">
                <h3 className="text-xs font-medium text-muted-foreground">
                  {t("layers", { count: data.manifest.layers.length })}
                </h3>
                {data.manifest.layers.length === 0 ? (
                  <p className="rounded-md border border-dashed px-3 py-2.5 text-xs text-muted-foreground">
                    {t("noLayers")}
                  </p>
                ) : (
                  <ul className="divide-y overflow-hidden rounded-md border">
                    {data.manifest.layers.map((layer, i) => (
                      <li
                        key={`${layer.digest}-${i}`}
                        className="flex items-center justify-between gap-3 px-3 py-2.5 text-xs"
                      >
                        <div className="min-w-0 flex-1">
                          <code className="block truncate" title={layer.digest}>
                            {layer.digest}
                          </code>
                          <span
                            className="mt-0.5 block truncate text-muted-foreground"
                            title={layer.mediaType}
                          >
                            {layer.mediaType}
                          </span>
                        </div>
                        <span className="shrink-0 tabular-nums text-muted-foreground">
                          {formatBytes(layer.size)}
                        </span>
                        <CopyButton
                          value={layer.digest}
                          label={t("copyLayerDigest")}
                          size="icon-xs"
                          className="shrink-0"
                        />
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

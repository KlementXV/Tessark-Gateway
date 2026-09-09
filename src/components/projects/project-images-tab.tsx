"use client"

import * as React from "react"
import { useSearchParams } from "next/navigation"
import { ChevronRight, Layers, PackageOpen, RefreshCw, Search } from "lucide-react"

import { ArtifactKindBadge, artifactIcon, repositoryIcon } from "@/components/registries/artifact-kind"
import { DeleteArtifactDialog } from "@/components/projects/delete-artifact-dialog"
import { ArtifactSecurity } from "@/components/registries/artifact-security"
import type { HarborArtifact } from "@/lib/registries/harbor"
import { useLocale, useTranslations } from "next-intl"

import { SearchInput } from "@/components/ui/search-input"
import { extractErrorMessage } from "@/lib/api-error"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { CopyButton } from "@/components/ui/copy-button"
import { Skeleton } from "@/components/ui/skeleton"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { clusterImageDigestReference, clusterImageReference } from "@/lib/clusters/registry-url"
import { formatDateTime } from "@/lib/format-date"
import type { RepositoryPulls } from "@/lib/projects/images"
import { cn } from "@/lib/utils"

interface Repository {
  name: string
  artifactCount: number
  updatedAt: string | null
  /** Undefined when Harbor was not asked — the row then keeps the neutral icon. */
  kind?: HarborArtifact["kind"]
  /**
   * Pulls summed over the cluster, with the per-member breakdown. Harbor counts pulls per
   * instance and replication does not carry that counter, so one member's number is only the
   * traffic it happened to serve — see RepositoryPulls in lib/projects/images.ts.
   */
  pulls: RepositoryPulls
}

// Mirrors HarborArtifact rather than redeclaring a subset of it: this tab and the registry's
// repository page render the same objects from the same endpoint, and the local copy is
// precisely how a Helm chart came to be shown as an image on one screen and not the other.
type Artifact = Pick<
  HarborArtifact,
  | "digest"
  | "tags"
  | "size"
  | "pushedAt"
  | "platform"
  | "kind"
  | "rawType"
  | "chart"
  | "vulnerabilities"
  | "supplyChain"
>

function formatBytes(bytes: number) {
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"]
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

/** `sha256:1f3c4d5e…` — enough to recognise a digest, short enough to sit on one line. */
function shortDigest(digest: string) {
  const [algorithm, hex] = digest.split(":")
  return hex ? `${algorithm}:${hex.slice(0, 12)}…` : `${digest.slice(0, 19)}…`
}

// What a user actually wants off this screen is the string to paste after `docker pull`, so
// every tag and every artifact carries it, host included.
//
// The cluster's published host is preferred: it is the one address that stays true whichever
// member serves the pull. When the cluster publishes none, the host of the Harbor that
// answered this listing is used instead — a real, pullable address for the image on screen,
// which beats handing the user a bare `team-app/api:1.4` to complete by hand. Only a registry
// whose base URL will not parse leaves the reference without a host.
function imageReference(
  host: string | null,
  projectName: string,
  repo: string,
  reference: string,
  kind: "tag" | "digest"
): string {
  if (kind === "digest") {
    return host
      ? clusterImageDigestReference(host, projectName, repo, reference)
      : `${projectName}/${repo}@${reference}`
  }
  return host
    ? clusterImageReference(host, projectName, repo, reference)
    : `${projectName}/${repo}:${reference}`
}

// A tag, and the one-click copy of the reference it names. The chip carries the copy itself
// rather than sitting next to a shared button: an artifact commonly holds several tags
// (`1.4.2`, `1.4`, `latest`) which are different references, and only the user knows which
// one they mean to pin.
function TagChip({ tag, reference }: { tag: string; reference: string }) {
  const t = useTranslations("projects.images")
  return (
    <span className="group/tag inline-flex max-w-full items-center overflow-hidden rounded border bg-background">
      <Tooltip>
        <TooltipTrigger asChild>
          <code className="min-w-0 truncate py-0.5 pl-1.5 font-mono text-xs">{tag}</code>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs break-all font-mono">{reference}</TooltipContent>
      </Tooltip>
      <CopyButton
        value={reference}
        label={t("copyReference", { reference })}
        size="icon-xs"
        className="size-5 shrink-0 rounded-none opacity-60 transition-opacity group-hover/tag:opacity-100 sm:size-5"
      />
    </span>
  )
}

// The artifacts of one repository, fetched the first time it is expanded. Harbor answers per
// repository, so loading all of them up front would be one request per image on a project
// that may hold hundreds.
/**
 * The cluster total, with the per-member breakdown behind it.
 *
 * The breakdown is not a nicety: a total of 64 that is 64 on one member and 0 on the other
 * says something quite different from 32/32 — the first means clients only ever reach one
 * Harbor. And when a member could not be read, the number is a floor, which the "≥" says on
 * screen rather than leaving it to a tooltip nobody opens.
 */
function PullCount({ pulls }: { pulls: RepositoryPulls }) {
  const t = useTranslations("projects.images")
  const incomplete = pulls.missing.length > 0

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="hidden shrink-0 cursor-default text-xs tabular-nums text-muted-foreground sm:inline">
          {incomplete && <span aria-hidden="true">≥ </span>}
          {t("pulls", { count: pulls.total })}
        </span>
      </TooltipTrigger>
      <TooltipContent>
        <div className="flex flex-col gap-0.5">
          {pulls.byRegistry.map((entry) => (
            <span key={entry.registryName} className="tabular-nums">
              {entry.registryName} — {t("pulls", { count: entry.pullCount })}
            </span>
          ))}
          {incomplete && (
            <span className="text-warning">
              {t("pullsIncomplete", { registries: pulls.missing.join(", ") })}
            </span>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  )
}

function RepositoryArtifacts({
  projectId,
  projectName,
  host,
  repo,
  canScan,
  canDelete,
  onChanged,
}: {
  projectId: string
  projectName: string
  /** Registry host the references are built on — see imageReference. */
  host: string | null
  repo: string
  /** Global ADMIN: may spend the cluster's Harbors on a scan. */
  canScan: boolean
  /** Write access to the project: may remove what it holds. */
  canDelete: boolean
  /** Refreshes the repository list — an emptied repository disappears from it. */
  onChanged: () => void
}) {
  const t = useTranslations("projects.images")
  const locale = useLocale()
  const [artifacts, setArtifacts] = React.useState<Artifact[] | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const loadFailed = t("loadTagsFailed")

  // Re-readable rather than fetched once: a scan triggered from a row below finishes on
  // Harbor's schedule, and the verdict on screen has to be able to catch up with it.
  //
  // The liveness ref is not ceremony. Refreshes are fired from timers that outlive a collapse
  // — the user folds the repository away while a scan is still running — so without it those
  // land on a component that is gone.
  const alive = React.useRef(true)
  React.useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const load = React.useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/images?repo=${encodeURIComponent(repo)}`)
      const body = await res.json().catch(() => null)
      if (!alive.current) return
      if (!res.ok) {
        setError(extractErrorMessage(body, loadFailed))
        return
      }
      setError(null)
      setArtifacts((body as { artifacts: Artifact[] }).artifacts)
    } catch {
      if (alive.current) setError(loadFailed)
    }
  }, [projectId, repo, loadFailed])

  React.useEffect(() => {
    // `load` only reaches a setState after awaiting the network, so nothing here renders
    // synchronously — but the rule cannot see past the call.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
  }, [load])

  if (error) {
    return <p className="px-4 py-3 text-sm text-destructive">{error}</p>
  }
  if (!artifacts) {
    return (
      <div className="flex flex-col gap-2 px-4 py-3">
        <Skeleton className="h-5 w-56" />
        <Skeleton className="h-5 w-40" />
      </div>
    )
  }
  if (artifacts.length === 0) {
    return <p className="px-4 py-3 text-sm text-muted-foreground">{t("noArtifacts")}</p>
  }

  return (
    <ul className="divide-y border-t bg-muted/30" aria-label={t("tagsIn", { repo })}>
      {artifacts.map((artifact) => {
        const digestReference = imageReference(host, projectName, repo, artifact.digest, "digest")
        return (
          <li key={artifact.digest} className="flex flex-col gap-1.5 px-4 py-3">
            {/* What the artifact is called: its tags, or the fact that it has none. */}
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              {artifact.tags.length > 0 ? (
                <>
                  {/* The artifact's own icon rather than a generic tag: a Helm chart sitting
                      among images is worth seeing before opening anything. */}
                  {(() => {
                    const Icon = artifactIcon(artifact.kind ?? "image")
                    return <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  })()}
                  {artifact.tags.map((tag) => (
                    <TagChip
                      key={tag}
                      tag={tag}
                      reference={imageReference(host, projectName, repo, tag, "tag")}
                    />
                  ))}
                </>
              ) : (
                // An untagged artifact is still pullable — by digest, which is all it has.
                <Badge variant="outline" className="gap-1 font-normal text-muted-foreground">
                  {t("untagged")}
                </Badge>
              )}
              {artifact.kind && <ArtifactKindBadge artifact={artifact} />}
              {canDelete && (
                <span className="ml-auto">
                  <DeleteArtifactDialog
                    projectId={projectId}
                    repo={repo}
                    digest={artifact.digest}
                    tags={artifact.tags}
                    onDeleted={() => {
                      void load()
                      onChanged()
                    }}
                  />
                </span>
              )}
            </div>

            {/* What it is: the immutable identity, then the facts about it. */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <code className="font-mono">{shortDigest(artifact.digest)}</code>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs break-all font-mono">{artifact.digest}</TooltipContent>
                </Tooltip>
                <CopyButton
                  value={digestReference}
                  label={t("copyReference", { reference: digestReference })}
                  size="icon-xs"
                  className="size-5 sm:size-5"
                />
              </span>
              {artifact.platform && (
                <Badge variant="outline" className="font-normal text-muted-foreground">
                  {artifact.platform}
                </Badge>
              )}
              <span className="tabular-nums">{formatBytes(artifact.size)}</span>
              {artifact.pushedAt && (
                <span title={t("pushed", { date: formatDateTime(artifact.pushedAt, locale) })}>
                  {formatDateTime(artifact.pushedAt, locale)}
                </span>
              )}
            </div>

            {/* One strip for the whole security verdict — comparable down the list when
                collapsed, the CVE list and the SBOM when opened. */}
            <ArtifactSecurity
              vulnerabilities={artifact.vulnerabilities}
              supplyChain={artifact.supplyChain}
              isChart={artifact.kind === "chart"}
              scanTrigger={
                canScan
                  ? { url: `/api/projects/${projectId}/scan`, repo, reference: artifact.digest }
                  : undefined
              }
              onRefresh={load}
              cvesUrl={`/api/projects/${projectId}/vulnerabilities?repo=${encodeURIComponent(
                repo
              )}&reference=${encodeURIComponent(artifact.digest)}`}
              sbomUrl={`/api/projects/${projectId}/sbom?repo=${encodeURIComponent(
                repo
              )}&reference=${encodeURIComponent(artifact.digest)}`}
            />
          </li>
        )
      })}
    </ul>
  )
}

// Read live from Harbor rather than from the Gateway's database: images arrive by
// `docker push`, a path that never goes through here, so there is nothing local to list.
export function ProjectImagesTab({
  projectId,
  projectName,
  registryHost,
  isActive,
  canScan = false,
  canDelete = false,
}: {
  projectId: string
  projectName: string
  /** The cluster's published host, when one is configured — see clusterImageReference. */
  registryHost: string | null
  isActive: boolean
  /** Global ADMIN: shows the per-artifact scan and SBOM buttons. */
  canScan?: boolean
  /**
   * Write access to the project — owner, a member above GUEST, or a global admin. Same footing
   * Harbor demands to push: whoever puts an image here may take it back out.
   */
  canDelete?: boolean
}) {
  const t = useTranslations("projects.images")
  const tc = useTranslations("common")
  const locale = useLocale()
  const [repositories, setRepositories] = React.useState<Repository[] | null>(null)
  const [registryName, setRegistryName] = React.useState<string | null>(null)
  // The Harbor that answered — the fallback host, see imageReference.
  const [harborHost, setHarborHost] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(false)
  // `?repo=` is how the command palette hands over a repository it found: the list opens
  // filtered on that name and with it already expanded, instead of dropping the user in front
  // of the whole catalogue to look for what they just picked.
  const deepLinkedRepo = useSearchParams().get("repo")
  const [query, setQuery] = React.useState(deepLinkedRepo ?? "")
  const [expanded, setExpanded] = React.useState<string | null>(deepLinkedRepo)
  const searchId = React.useId()

  const loadFailed = t("loadFailed")
  const load = React.useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/projects/${projectId}/images`)
      const body = await res.json().catch(() => null)
      if (!res.ok) {
        setError(extractErrorMessage(body, loadFailed))
        setRepositories(null)
        return
      }
      const data = body as {
        registryName: string
        registryHost: string | null
        repositories: Repository[]
      }
      setError(null)
      setRegistryName(data.registryName)
      setHarborHost(data.registryHost)
      setRepositories(data.repositories)
    } catch {
      setError(loadFailed)
      setRepositories(null)
    } finally {
      setLoading(false)
    }
  }, [projectId, loadFailed])

  React.useEffect(() => {
    // The list is only worth a request once the project exists on a Harbor.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load() flips the spinner on
    if (isActive) void load()
  }, [isActive, load])

  if (!isActive) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed px-12 py-10 text-center sm:px-5 sm:py-14">
        <div className="flex size-11 items-center justify-center rounded-md bg-muted">
          <PackageOpen className="size-5 text-muted-foreground" />
        </div>
        <div>
          <p className="text-sm font-medium">{t("inactiveTitle")}</p>
          <p className="mt-1 text-sm text-muted-foreground">{t("inactiveHint")}</p>
        </div>
      </div>
    )
  }

  const normalizedQuery = query.trim().toLowerCase()
  const filtered = (repositories ?? []).filter((repo) => repo.name.toLowerCase().includes(normalizedQuery))
  const host = registryHost ?? harborHost
  const pushReference = host
    ? clusterImageReference(host, projectName, "my-image", "latest")
    : null
  const pushCommands = pushReference
    ? `docker tag my-image:latest ${pushReference}\ndocker push ${pushReference}`
    : null

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <SearchInput
            id={searchId}
            label={t("searchLabel")}
            placeholder={t("searchPlaceholder")}
            value={query}
            onChange={setQuery}
            className="max-w-sm"
          />
        <div className="flex items-center gap-3">
          {repositories && (
            <p aria-live="polite" className="text-xs tabular-nums text-muted-foreground">
              {normalizedQuery
                ? t("countFiltered", { filtered: filtered.length, total: repositories.length })
                : t("count", { count: repositories.length })}
              {registryName && <span className="hidden sm:inline">{t("readFrom", { registry: registryName })}</span>}
            </p>
          )}
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={cn(loading && "animate-spin")} />
            {tc("refresh")}
          </Button>
        </div>
      </div>

      {error ? (
        <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </p>
      ) : !repositories ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed px-12 py-10 text-center sm:px-5 sm:py-14">
          <div className="flex size-11 items-center justify-center rounded-md bg-muted">
            {repositories.length === 0 ? (
              <PackageOpen className="size-5 text-muted-foreground" />
            ) : (
              <Search className="size-5 text-muted-foreground" />
            )}
          </div>
          <div>
            <p className="text-sm font-medium">
              {repositories.length === 0 ? t("noImages") : t("noResults", { query })}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {repositories.length === 0 ? t("pushHint") : t("tryDifferent")}
            </p>
          </div>
          {repositories.length === 0 && pushCommands && (
            <div className="mt-2 flex w-full max-w-xl flex-col gap-3 rounded-lg border bg-muted/25 p-4 text-left">
              <div>
                <p className="text-sm font-medium">{t("pushFirstTitle")}</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">{t("pushFirstHint")}</p>
              </div>
              <div className="flex min-w-0 items-center gap-2 rounded-md bg-background p-2 pl-3">
                <pre className="min-w-0 flex-1 overflow-x-auto font-mono text-xs leading-5 whitespace-pre">
                  {pushCommands}
                </pre>
                <CopyButton value={pushCommands} label={t("copyPushCommands")} />
              </div>
              <p className="text-xs text-muted-foreground">
                {t.rich("replaceNote", { code: (chunks) => <code className="font-mono">{chunks}</code> })}
              </p>
            </div>
          )}
        </div>
      ) : (
        <ul className="divide-y overflow-hidden rounded-lg border" aria-label={t("listAria")}>
          {filtered.map((repo) => {
            const isOpen = expanded === repo.name
            // The repository path without a tag: what someone pasting into a Dockerfile or a
            // Helm `image.repository` needs, where the tag comes from elsewhere.
            const repoReference = host
              ? `${host}/${projectName}/${repo.name}`
              : `${projectName}/${repo.name}`
            return (
              <li key={repo.name}>
                <div className="group flex items-center gap-1 pr-2 transition-colors hover:bg-accent/50 has-focus-visible:bg-accent/50">
                  <button
                    type="button"
                    onClick={() => setExpanded(isOpen ? null : repo.name)}
                    aria-expanded={isOpen}
                    className="flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-sm px-4 py-3 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  >
                    {(() => {
                      const Icon = repositoryIcon(repo.kind)
                      return <Icon className="size-4 shrink-0 text-muted-foreground" />
                    })()}
                    <span className="min-w-0 flex-1 truncate font-mono" title={repo.name}>
                      {repo.name}
                    </span>
                    <span className="inline-flex shrink-0 items-center gap-1 text-xs tabular-nums text-muted-foreground">
                      <Layers className="size-3.5" aria-hidden="true" />
                      {t("artifacts", { count: repo.artifactCount })}
                    </span>
                    <PullCount pulls={repo.pulls} />
                    {repo.updatedAt && (
                      <span className="hidden shrink-0 text-xs text-muted-foreground md:inline">
                        {formatDateTime(repo.updatedAt, locale)}
                      </span>
                    )}
                    <ChevronRight
                      className={cn(
                        "size-4 shrink-0 text-muted-foreground transition-transform duration-200",
                        isOpen && "rotate-90"
                      )}
                    />
                  </button>
                  <CopyButton value={repoReference} label={t("copyReference", { reference: repoReference })} />
                  {canDelete && (
                    <DeleteArtifactDialog
                      projectId={projectId}
                      repo={repo.name}
                      digest={null}
                      artifactCount={repo.artifactCount}
                      onDeleted={() => void load()}
                    />
                  )}
                </div>
                {isOpen && (
                  <RepositoryArtifacts
                    projectId={projectId}
                    projectName={projectName}
                    host={host}
                    repo={repo.name}
                    canScan={canScan}
                    canDelete={canDelete}
                    onChanged={() => void load()}
                  />
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

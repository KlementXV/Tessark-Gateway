"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { ChevronRight, Search, Tags, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { useTranslations } from "next-intl"

import { SearchInput } from "@/components/ui/search-input"
import { extractErrorMessage } from "@/lib/api-error"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { CopyButton } from "@/components/ui/copy-button"
import { TagDetailSheet } from "@/components/registries/tag-detail-sheet"
import { ArtifactKindBadge, artifactIcon } from "@/components/registries/artifact-kind"
import type { ArtifactMeta } from "@/lib/registries/harbor"

/**
 * The string to paste after `docker pull`. `repo` already carries the project prefix here —
 * this list is fed by the registry-wide catalog, not by a project view. When the registry's
 * address is unknown the path alone is offered rather than a guess at the host.
 */
function pullReference(imageHost: string | null, repo: string, tag?: string): string {
  const path = imageHost ? `${imageHost}/${repo}` : repo
  return tag ? `${path}:${tag}` : path
}

export function TagList({
  registryId,
  repo,
  tags,
  kinds,
  imageHost,
  canScan = false,
}: {
  registryId: string
  repo: string
  tags: string[]
  /**
   * What each tag is, keyed by tag. Empty when Harbor could not be asked — every tag then
   * falls back to being drawn as an image, which is what this list did before it could tell.
   */
  kinds: Record<string, ArtifactMeta>
  /** Host of the registry this repository lives on, e.g. `harbor.local`. */
  imageHost: string | null
  /** Global ADMIN on a MANAGED registry: may trigger a scan or an SBOM generation. */
  canScan?: boolean
}) {
  const t = useTranslations("registries.tagList")
  const tc = useTranslations("common")
  const router = useRouter()
  const [query, setQuery] = React.useState("")
  const [activeTag, setActiveTag] = React.useState<string | null>(null)
  const [deletingTag, setDeletingTag] = React.useState<string | null>(null)
  const searchId = React.useId()

  const normalizedQuery = query.trim().toLowerCase()
  const filtered = tags.filter((tag) => tag.toLowerCase().includes(normalizedQuery))
  const countLabel = normalizedQuery
    ? t("countFiltered", { filtered: filtered.length, total: tags.length })
    : t("count", { count: tags.length })
  const manifestBaseUrl = `/api/registries/${registryId}/manifest?repo=${encodeURIComponent(repo)}`
  const vulnBaseUrl = `/api/registries/${registryId}/vulnerabilities?repo=${encodeURIComponent(repo)}`
  const sbomBaseUrl = `/api/registries/${registryId}/sbom?repo=${encodeURIComponent(repo)}`

  async function handleDelete(tag: string) {
    setDeletingTag(tag)
    try {
      const res = await fetch(`${manifestBaseUrl}&reference=${encodeURIComponent(tag)}`, {
        method: "DELETE",
      })

      if (!res.ok) {
        const body = await res.json().catch(() => null)
        toast.error(extractErrorMessage(body, t("deleteFailed")))
        return
      }

      toast.success(t("deleted", { tag }))
      router.refresh()
    } catch {
      toast.error(t("deleteFailed"))
    } finally {
      setDeletingTag(null)
    }
  }

  return (
    <div className="flex flex-col gap-4 px-4 lg:px-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <SearchInput
            id={searchId}
            label={t("searchLabel")}
            placeholder={t("searchPlaceholder")}
            value={query}
            onChange={setQuery}
            className="max-w-sm"
          />
        <div className="flex shrink-0 items-center gap-2">
          <p aria-live="polite" className="text-xs tabular-nums text-muted-foreground">
            {countLabel}
          </p>
          <CopyButton
            value={pullReference(imageHost, repo)}
            label={t("copyRepository", { reference: pullReference(imageHost, repo) })}
          />
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="animate-enter flex flex-col items-center justify-center gap-3 rounded-md border border-dashed px-4 py-16 text-center sm:py-20">
          <div className="flex size-11 items-center justify-center rounded-full bg-muted">
            {tags.length === 0 ? (
              <Tags className="size-5 text-muted-foreground" />
            ) : (
              <Search className="size-5 text-muted-foreground" />
            )}
          </div>
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium">
              {tags.length === 0 ? t("empty") : t("noResults", { query })}
            </p>
            <p className="text-sm text-muted-foreground">
              {tags.length === 0 ? t("emptyHint") : t("tryDifferent")}
            </p>
          </div>
        </div>
      ) : (
        <ul className="divide-y overflow-hidden rounded-md border" aria-label={t("listAria", { repo })}>
          {filtered.map((tag, i) => (
            <li
              key={tag}
              className="animate-enter group flex min-h-11 items-center gap-1 px-2 transition-colors duration-200 hover:bg-accent/30"
              style={{ "--enter-delay": `${Math.min(i, 12) * 30}ms` } as React.CSSProperties}
            >
              <button
                type="button"
                onClick={() => setActiveTag(tag)}
                aria-label={t("viewManifest", { tag })}
                className="flex min-w-0 flex-1 items-center gap-2.5 self-stretch rounded-sm px-1 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {(() => {
                  const meta = kinds[tag]
                  const Icon = artifactIcon(meta?.kind ?? "image")
                  return (
                    <Icon className="size-4 shrink-0 text-muted-foreground transition-colors duration-200 group-hover:text-foreground" />
                  )
                })()}
                <span className="min-w-0 truncate font-mono" title={tag}>
                  {tag}
                </span>
                {kinds[tag] && <ArtifactKindBadge artifact={kinds[tag]} />}
                <span className="flex-1" />
                <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:translate-x-0.5 motion-reduce:group-hover:translate-x-0" />
              </button>

              <CopyButton
                value={pullReference(imageHost, repo, tag)}
                label={t("copyReference", { reference: pullReference(imageHost, repo, tag) })}
              />

              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    disabled={deletingTag !== null}
                    aria-label={t("deleteAria", { tag })}
                    title={t("deleteAria", { tag })}
                    className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  >
                    <Trash2 />
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>{t("deleteTitle", { tag })}</AlertDialogTitle>
                    <AlertDialogDescription>
                      {t.rich("deleteDescription", {
                        reference: `${repo}:${tag}`,
                        code: (chunks) => <code className="break-all font-mono">{chunks}</code>,
                      })}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{tc("cancel")}</AlertDialogCancel>
                    <AlertDialogAction
                      variant="destructive"
                      disabled={deletingTag === tag}
                      onClick={() => handleDelete(tag)}
                    >
                      {deletingTag === tag ? tc("deleting") : t("deleteSubmit")}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </li>
          ))}
        </ul>
      )}

      {activeTag && (
        <TagDetailSheet
          open={Boolean(activeTag)}
          onOpenChange={(open) => !open && setActiveTag(null)}
          manifestUrl={`${manifestBaseUrl}&reference=${encodeURIComponent(activeTag)}`}
          vulnerabilitiesUrl={`${vulnBaseUrl}&reference=${encodeURIComponent(activeTag)}`}
          sbomUrl={`${sbomBaseUrl}&reference=${encodeURIComponent(activeTag)}`}
          scanTrigger={
            canScan
              ? { url: `/api/registries/${registryId}/scan`, repo, reference: activeTag }
              : undefined
          }
          tag={activeTag}
          repo={repo}
          imageHost={imageHost}
        />
      )}
    </div>
  )
}

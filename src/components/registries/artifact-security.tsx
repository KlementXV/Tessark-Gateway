"use client"

import * as React from "react"
import {
  ChevronRight,
  Download,
  FileBox,
  RadioTower,
  ShieldCheck,
  ShieldOff,
  ShieldQuestion,
} from "lucide-react"
import { useLocale, useTranslations } from "next-intl"
import { toast } from "sonner"

import { badgeVariants } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Skeleton } from "@/components/ui/skeleton"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { extractErrorMessage } from "@/lib/api-error"
import { formatDateTime } from "@/lib/format-date"
import type { HarborVulnerability } from "@/lib/registries/harbor"
import type { HarborSupplyChainSummary, HarborVulnerabilitySummary } from "@/lib/registries/types"
import { cn } from "@/lib/utils"

const SEVERITIES = ["Critical", "High", "Medium", "Low", "Unknown"] as const
type Severity = (typeof SEVERITIES)[number]

// Four severities, one colour each, used identically by the bar, the counts, the filter chips
// and the CVE rows. Declared once so a "High" is the same orange everywhere it appears —
// severity is the only thing a reader scans for, and it has to be recognisable by colour
// alone before any label is read.
const SEVERITY_STYLE: Record<Severity, { bar: string; text: string; chip: string }> = {
  Critical: { bar: "bg-destructive", text: "text-destructive", chip: "border-destructive/40 text-destructive" },
  High: { bar: "bg-orange-500", text: "text-orange-500", chip: "border-orange-500/40 text-orange-500" },
  Medium: { bar: "bg-warning", text: "text-warning", chip: "border-warning/40 text-warning" },
  Low: { bar: "bg-muted-foreground/50", text: "text-muted-foreground", chip: "text-muted-foreground" },
  // Trivy grades a real share of findings as ungraded. Shown, never folded into Low: "we do
  // not know how bad this is" is a different statement from "this is minor".
  Unknown: { bar: "bg-muted-foreground/25", text: "text-muted-foreground", chip: "border-dashed text-muted-foreground" },
}

type Counts = Record<Severity, number>

type HarborScanKind = "vulnerability" | "sbom"

// A Trivy pass takes seconds to a minute or so depending on the image. Rather than hold a
// spinner for an unknown duration or leave a stale verdict on screen, the list is re-read a
// few times on a decaying schedule and then left alone — the user can always reopen.
const REFRESH_DELAYS_MS = [4_000, 10_000, 20_000, 40_000]

function countsOf(summary: HarborVulnerabilitySummary): Counts {
  return {
    Critical: summary.critical,
    High: summary.high,
    Medium: summary.medium,
    Low: summary.low,
    Unknown: summary.unknown,
  }
}

/**
 * Proportional severity bar.
 *
 * The point is comparison down a column of artifacts: a bar that is mostly red reads as worse
 * than one that is mostly grey before a single number is read. Every non-zero severity gets a
 * visible sliver whatever its share — one Critical among four hundred Lows must not round
 * away to nothing, which is exactly the case that matters most.
 */
function SeverityBar({ counts }: { counts: Counts }) {
  const total = SEVERITIES.reduce((sum, s) => sum + counts[s], 0)
  if (total === 0) return null

  return (
    <span
      className="flex h-1.5 w-20 shrink-0 overflow-hidden rounded-full bg-muted"
      aria-hidden="true"
    >
      {SEVERITIES.map((severity) =>
        counts[severity] > 0 ? (
          <span
            key={severity}
            className={cn("h-full", SEVERITY_STYLE[severity].bar)}
            style={{ width: `${(counts[severity] / total) * 100}%`, minWidth: "3px" }}
          />
        ) : null
      )}
    </span>
  )
}

// A filter chip. Styled off badgeVariants rather than reimplemented so it sits at the same
// size and radius as every other pill on the row.
function FilterChip({
  active,
  onClick,
  className,
  children,
}: {
  active: boolean
  onClick: () => void
  className?: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        badgeVariants({ variant: "outline" }),
        "cursor-pointer transition-colors hover:bg-accent",
        active && "bg-accent ring-1 ring-ring/40",
        className
      )}
    >
      {children}
    </button>
  )
}

function CveRows({ rows }: { rows: HarborVulnerability[] }) {
  const t = useTranslations("registries.vulnerabilities")

  if (rows.length === 0) {
    return (
      <p className="rounded-md border border-dashed px-3 py-2.5 text-xs text-muted-foreground">
        {t("noMatch")}
      </p>
    )
  }

  return (
    <ul className="max-h-72 divide-y overflow-y-auto rounded-md border bg-background">
      {rows.map((cve, i) => (
        <li key={`${cve.id}-${cve.package}-${i}`} className="flex flex-col gap-1 px-3 py-2 text-xs">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span
              className={cn(
                "inline-flex items-center gap-1 font-medium",
                SEVERITY_STYLE[cve.severity as Severity]?.text ?? "text-muted-foreground"
              )}
            >
              <span
                className={cn(
                  "size-1.5 rounded-full",
                  SEVERITY_STYLE[cve.severity as Severity]?.bar ?? "bg-muted-foreground/50"
                )}
                aria-hidden="true"
              />
              {cve.severity}
            </span>
            {cve.links[0] ? (
              <a
                href={cve.links[0]}
                target="_blank"
                rel="noreferrer"
                className="font-mono underline decoration-dotted underline-offset-2 hover:decoration-solid"
              >
                {cve.id}
              </a>
            ) : (
              <span className="font-mono">{cve.id}</span>
            )}
            {cve.cvssScore != null && (
              <span className="tabular-nums text-muted-foreground">CVSS {cve.cvssScore}</span>
            )}
          </div>

          {/* The actionable half: what to bump, and to what. A published fix is the only thing
              on this row anyone can act on today, so it is the only thing given colour. */}
          <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-muted-foreground">
            <span className="truncate font-mono" title={cve.package}>
              {cve.package}
            </span>
            <span className="font-mono">{cve.version}</span>
            {cve.fixVersion ? (
              <>
                <span aria-hidden="true">→</span>
                <span className="font-mono font-medium text-success">{cve.fixVersion}</span>
              </>
            ) : (
              <span className="italic">· {t("noFix")}</span>
            )}
          </div>
        </li>
      ))}
    </ul>
  )
}

/**
 * Everything Harbor knows about one artifact's security, as one collapsible strip.
 *
 * Collapsed, it is a verdict a reader can compare down a list without opening anything:
 * severity bar, counts, and whether the artifact carries a signature and an SBOM. Expanded, it
 * is the evidence — who scanned it and when, the SBOM to download, and the CVE list with its
 * filters.
 *
 * The CVE report is fetched once, on first expand, and kept: a report runs to hundreds of rows
 * and a repository page holds dozens of artifacts, so loading them up front would cost a
 * request per artifact for information most visits never look at.
 */
export function ArtifactSecurity({
  vulnerabilities,
  supplyChain,
  cvesUrl,
  sbomUrl,
  scanTrigger,
  isChart = false,
  onRefresh,
}: {
  vulnerabilities: HarborVulnerabilitySummary | null
  supplyChain: HarborSupplyChainSummary | null
  /** Route returning `{ vulnerabilities: HarborVulnerability[] | null }`. */
  cvesUrl: string
  /** Route serving the SBOM as a download, when this surface has one. */
  sbomUrl?: string
  /**
   * Route accepting `{ repo, reference, scanType }` to trigger a scan. Given only to viewers
   * allowed to spend the Harbors' compute — the buttons are what an ADMIN sees, the route
   * guard is what actually holds.
   */
  scanTrigger?: { url: string; repo: string; reference: string }
  isChart?: boolean
  /** Re-reads the artifact list, so a finished scan shows up without a manual reload. */
  onRefresh?: () => void
}) {
  const t = useTranslations("registries.vulnerabilities")
  const locale = useLocale()
  const [open, setOpen] = React.useState(false)
  // Distinct from `open`: the report is fetched on the first expand and kept, so collapsing
  // and re-expanding costs nothing. Folding this into `open` would abort an in-flight request
  // the moment the user changed their mind.
  const [requested, setRequested] = React.useState(false)
  const [rows, setRows] = React.useState<HarborVulnerability[]>([])
  const [state, setState] = React.useState<"idle" | "loading" | "ready" | "error">("idle")
  const [err, setErr] = React.useState<string | null>(null)
  const [severity, setSeverity] = React.useState<Severity | null>(null)
  const [fixableOnly, setFixableOnly] = React.useState(false)
  const [triggering, setTriggering] = React.useState<HarborScanKind | null>(null)
  const failed = t("failed")

  const counts = vulnerabilities ? countsOf(vulnerabilities) : null
  // Harbor's total, not the sum of the buckets above: a severity label this build does not
  // enumerate must still count as a finding, or the artifact would be declared clean.
  const total = vulnerabilities?.total ?? 0

  // `state` is deliberately NOT a dependency. It used to be, and setting it to "loading" from
  // inside re-ran the effect, whose cleanup aborted the request it had just issued — the panel
  // then sat on a skeleton for ever. The fetch is gated on `requested`, which only ever flips
  // once, so nothing here re-runs on its own state.
  React.useEffect(() => {
    if (!requested || total === 0) return
    const controller = new AbortController()
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState("loading")

    fetch(cvesUrl, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? failed)
        return res.json() as Promise<{ vulnerabilities: HarborVulnerability[] | null }>
      })
      .then((body) => {
        setRows(body.vulnerabilities ?? [])
        setState("ready")
      })
      .catch((e) => {
        if (controller.signal.aborted) return
        setErr(e instanceof Error ? e.message : failed)
        setState("error")
      })

    return () => controller.abort()
  }, [requested, total, cvesUrl, failed])

  async function trigger(scanType: HarborScanKind) {
    if (!scanTrigger) return
    setTriggering(scanType)
    try {
      const res = await fetch(scanTrigger.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repo: scanTrigger.repo,
          reference: scanTrigger.reference,
          scanType,
        }),
      })
      if (!res.ok) {
        toast.error(extractErrorMessage(await res.json().catch(() => null), t("triggerFailed")))
        return
      }
      // Harbor answered 202 and will do the work on its own schedule, so the toast promises
      // acceptance, not a result — and the refreshes below are polls, not a guarantee.
      toast.success(scanType === "sbom" ? t("sbomQueued") : t("scanQueued"))
      if (onRefresh) {
        for (const delay of REFRESH_DELAYS_MS) setTimeout(onRefresh, delay)
      }
    } catch {
      toast.error(t("triggerFailed"))
    } finally {
      setTriggering(null)
    }
  }

  // Nothing Harbor said at all — not a Harbor, or an artifact it has never indexed. Showing a
  // "not scanned" verdict here would be a claim the Gateway cannot make.
  if (!vulnerabilities && !supplyChain) return null

  const present = counts ? SEVERITIES.filter((s) => counts[s] > 0) : []
  const shown = rows.filter(
    (cve) =>
      (!severity || cve.severity === severity) && (!fixableOnly || cve.fixVersion !== null)
  )
  const fixableTotal = rows.filter((cve) => cve.fixVersion !== null).length

  return (
    <Collapsible
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) setRequested(true)
      }}
    >
      <CollapsibleTrigger
        className={cn(
          "flex w-full min-w-0 items-center gap-2 rounded-md border px-2 py-1.5 text-xs transition-colors",
          "hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
          open && "bg-accent/40"
        )}
        aria-label={t("toggle")}
      >
        <ChevronRight
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90"
          )}
          aria-hidden="true"
        />

        {/* The verdict, in the three shapes it can take: findings, clean, never scanned. */}
        {counts && total > 0 ? (
          <>
            <SeverityBar counts={counts} />
            <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
              {present.length > 0 ? (
                present.map((s) => (
                  <span key={s} className={cn("font-medium tabular-nums", SEVERITY_STYLE[s].text)}>
                    {t(`count${s}`, { count: counts[s] })}
                  </span>
                ))
              ) : (
                <span className="font-medium tabular-nums">{t("countTotal", { count: total })}</span>
              )}
            </span>
          </>
        ) : counts ? (
          <span className="inline-flex items-center gap-1.5 font-medium text-success">
            <ShieldCheck className="size-3.5" aria-hidden="true" />
            {t("clean")}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-muted-foreground">
            <ShieldQuestion className="size-3.5" aria-hidden="true" />
            {isChart ? t("notScannedChart") : t("notScanned")}
          </span>
        )}

        {/* Supply-chain state as icons: it is secondary to the CVE verdict but has to be
            comparable down the list, which words in a pill are not. */}
        {supplyChain && (
          <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <span className={supplyChain.signed ? "text-success" : "text-muted-foreground/50"}>
                  {supplyChain.signed ? (
                    <ShieldCheck className="size-3.5" />
                  ) : (
                    <ShieldOff className="size-3.5" />
                  )}
                </span>
              </TooltipTrigger>
              <TooltipContent>
                {supplyChain.signed ? t("signed") : t("unsigned")}
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className={supplyChain.sbom ? "text-foreground" : "text-muted-foreground/50"}>
                  <FileBox className="size-3.5" />
                </span>
              </TooltipTrigger>
              <TooltipContent>{supplyChain.sbom ? t("sbomPresent") : t("sbomAbsent")}</TooltipContent>
            </Tooltip>
          </span>
        )}
      </CollapsibleTrigger>

      <CollapsibleContent>
        <div className="mt-1.5 flex flex-col gap-2.5 rounded-md border bg-muted/20 p-2.5">
          {/* Provenance of the verdict above. A count with no scanner and no date is a number
              nobody can weigh — this is the line that makes it evidence. */}
          {vulnerabilities && (vulnerabilities.scanner || vulnerabilities.scanCompletedAt) && (
            <p className="text-xs text-muted-foreground">
              {vulnerabilities.scanner && vulnerabilities.scanCompletedAt
                ? t("scannedBy", {
                    scanner: vulnerabilities.scanner,
                    date: formatDateTime(vulnerabilities.scanCompletedAt, locale),
                  })
                : vulnerabilities.scanner
                  ? t("scannedWith", { scanner: vulnerabilities.scanner })
                  : t("scannedAt", {
                      date: formatDateTime(vulnerabilities.scanCompletedAt!, locale),
                    })}
            </p>
          )}

          {/* The SBOM, as a file someone can actually take away. */}
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="inline-flex items-center gap-1.5 text-muted-foreground">
              <FileBox className="size-3.5" aria-hidden="true" />
              SBOM
            </span>
            {supplyChain?.sbom && sbomUrl ? (
              <a
                href={sbomUrl}
                className={cn(
                  badgeVariants({ variant: "outline" }),
                  "gap-1 transition-colors hover:bg-accent"
                )}
              >
                <Download className="size-3" aria-hidden="true" />
                {t("sbomDownload")}
              </a>
            ) : (
              <span className="text-muted-foreground">
                {supplyChain?.sbom ? t("sbomPresent") : t("sbomAbsent")}
              </span>
            )}
            {supplyChain && supplyChain.attestationCount > 0 && (
              <span className="text-muted-foreground">
                · {t("attestations", { count: supplyChain.attestationCount })}
              </span>
            )}
          </div>

          {/* Ask Harbor to redo the work. Placed at the bottom of the panel, under the
              evidence it replaces: the reason to press either of these is having just read
              a stale date or an absent SBOM directly above. */}
          {scanTrigger && (
            <div className="flex flex-wrap items-center gap-2 border-t pt-2.5">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={triggering !== null}
                onClick={() => trigger("vulnerability")}
              >
                <RadioTower className={triggering === "vulnerability" ? "animate-pulse" : undefined} />
                {vulnerabilities ? t("rescan") : t("scan")}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={triggering !== null}
                onClick={() => trigger("sbom")}
              >
                <FileBox className={triggering === "sbom" ? "animate-pulse" : undefined} />
                {supplyChain?.sbom ? t("sbomRegenerate") : t("sbomGenerate")}
              </Button>
            </div>
          )}

          {/* The CVE list, only when there is something to list. */}
          {total > 0 && (
            <div className="flex flex-col gap-2">
              {state === "loading" && <Skeleton className="h-24 w-full rounded-md" />}

              {state === "error" && (
                <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                  {err}
                </p>
              )}

              {state === "ready" && rows.length === 0 && (
                <p className="rounded-md border border-dashed px-3 py-2.5 text-xs text-muted-foreground">
                  {t("none")}
                </p>
              )}

              {state === "ready" && rows.length > 0 && (
                <>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <FilterChip active={severity === null} onClick={() => setSeverity(null)}>
                      {t("all", { count: rows.length })}
                    </FilterChip>
                    {present.map((s) => (
                      <FilterChip
                        key={s}
                        active={severity === s}
                        onClick={() => setSeverity(s === severity ? null : s)}
                        className={SEVERITY_STYLE[s].chip}
                      >
                        {t(`count${s}`, { count: counts![s] })}
                      </FilterChip>
                    ))}
                    {/* The only filter that answers a question rather than narrowing a view:
                        "what can I fix right now?" */}
                    {fixableTotal > 0 && (
                      <FilterChip
                        active={fixableOnly}
                        onClick={() => setFixableOnly((v) => !v)}
                        className="border-success/40 text-success"
                      >
                        {t("fixable", { count: fixableTotal })}
                      </FilterChip>
                    )}
                  </div>

                  <CveRows rows={shown} />
                </>
              )}
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

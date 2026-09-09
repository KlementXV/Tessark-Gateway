"use client"

import * as React from "react"
import { AlertTriangle, CheckCircle2, Loader2, XCircle } from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { verdictOf, type SourceCheckResult } from "@/lib/sources/check-result"

// The first glob that names an actual repository rather than a subtree — "myteam/myapp" is
// probeable, "library/**" is not. Saves asking for something the admin has usually already
// typed into Allowed repositories.
function concreteGlob(globs: string[]): string {
  return globs.find((g) => !g.includes("*")) ?? ""
}

// Advisory only. The gateway is not the machine that runs the pull — skopeo does, from inside
// the Harbor clusters — so a failure here can simply mean this box has no egress while the
// clusters do. Nothing in this component disables the submit button, and that is on purpose.
export function SourceConnectionTest({
  sourceId,
  host,
  authType,
  username,
  secret,
  globs,
  presetRepo,
}: {
  sourceId?: string
  host: string
  authType: "none" | "basic" | "token"
  username: string
  secret: string
  globs: string[]
  /** The preset's known-good repository, when the source came from one. */
  presetRepo: string
}) {
  const t = useTranslations("sources.test")
  const [testing, setTesting] = React.useState(false)
  const [tested, setTested] = React.useState<{ signature: string; result: SourceCheckResult } | null>(
    null,
  )
  // Only ever surfaced when a test could not prove the credentials on its own — most of the
  // time the repository is already known and this input never appears.
  const [manualRepo, setManualRepo] = React.useState("")

  const probeRepo = manualRepo || presetRepo || concreteGlob(globs)

  // Any edit to what is being probed invalidates the last verdict, so a stale green tick can
  // never sit under changed credentials.
  const signature = React.useMemo(
    () => JSON.stringify([host, authType, username, secret, probeRepo]),
    [host, authType, username, secret, probeRepo],
  )
  const result = tested?.signature === signature ? tested.result : null

  async function runTest() {
    setTesting(true)
    setTested(null)

    const res = await fetch("/api/sources/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: sourceId,
        host: host.trim().toLowerCase(),
        authType,
        username: authType !== "none" ? username || null : null,
        secret: authType !== "none" ? secret || null : null,
        probeRepo: probeRepo || null,
      }),
    }).catch(() => null)

    setTesting(false)

    if (!res?.ok) {
      setTested({
        signature,
        result: {
          base: host,
          reachable: false,
          authenticated: false,
          probe: null,
          error: res ? t("checkFailed") : t("gatewayUnreachable"),
          durationMs: 0,
        },
      })
      return
    }

    setTested({ signature, result: (await res.json()) as SourceCheckResult })
  }

  const verdict = result ? verdictOf(result) : null

  return (
    <div className="flex flex-col gap-2 rounded-md border p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <Label>{t("connection")}</Label>
          <p className="text-xs text-muted-foreground">{t("hint")}</p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={testing || !host}
          onClick={runTest}
        >
          {testing && <Loader2 className="animate-spin" />}
          {testing ? t("testing") : t("test")}
        </Button>
      </div>

      {result && (
        <div className="flex items-start gap-2 rounded-md bg-muted/50 p-2.5">
          {verdict === "ok" && <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />}
          {verdict === "reachable" && (
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
          )}
          {(verdict === "denied" || verdict === "unreachable") && (
            <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
          )}

          <div className="flex min-w-0 flex-col gap-0.5 text-xs">
            <span className="font-medium">
              {verdict === "ok" && t("ok", { repo: result.probe?.repo ?? "", count: result.probe?.tagCount ?? 0 })}
              {verdict === "reachable" && t("reachable", { base: result.base })}
              {verdict === "denied" && t("denied")}
              {verdict === "unreachable" && t("unreachable")}
            </span>
            <span className="text-muted-foreground">
              {result.error ?? result.probe?.error ?? t("probed", { base: result.base, ms: result.durationMs })}
            </span>
            {verdict !== "ok" && (
              <span className="text-muted-foreground">{t("stillAddable")}</span>
            )}
          </div>
        </div>
      )}

      {/* Nothing concrete to read means the probe could only ping. Asking for a repository is
          the one thing that turns that into a real credential check, so it is offered here —
          after the fact — rather than as a field everyone has to look at. */}
      {verdict === "reachable" && (
        <div className="flex items-end gap-2">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Label htmlFor="probeRepo" className="text-xs font-normal text-muted-foreground">
              {t("probeRepoLabel")}
            </Label>
            <Input
              id="probeRepo"
              value={manualRepo}
              onChange={(e) => setManualRepo(e.target.value)}
              placeholder={t("probeRepoPlaceholder")}
              className="h-8 font-mono text-xs"
            />
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8"
            disabled={testing || !manualRepo}
            onClick={runTest}
          >
            {t("read")}
          </Button>
        </div>
      )}
    </div>
  )
}

"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { Plus, Play, Pause, RefreshCw, Pencil, Trash2, Hammer } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import { extractErrorMessage } from "@/lib/api-error"
import type { PublicBuild } from "@/lib/builds/public"
import type { BuildInput } from "@/lib/builds/schema"

const initial: BuildInput = { name: "", description: "", projectId: "", targetRepo: "", tag: "latest", sourceKind: "inline", dockerfileContent: "FROM docker.io/library/alpine:3.22\nRUN echo hello\n", gitUrl: "", gitRef: "", contextPath: ".", dockerfilePath: "Dockerfile", buildArgs: {}, schedule: "0 3 * * 1", enabled: true }
const selectClass = "h-9 w-full rounded-md border bg-background px-3 text-sm"
async function request(url: string, method = "GET", body?: unknown) {
  const res = await fetch(url, { method, ...(body !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) })
  const data = await res.json()
  if (!res.ok) throw new Error(extractErrorMessage(data, "Build request failed"))
  return data
}
export function BuildsBoard({ builds, projects, enabled }: { builds: PublicBuild[]; projects: Array<{ id: string; name: string }>; enabled: boolean }) {
  const t = useTranslations("builds")
  function statusLabel(status: string) {
    const known = ["pending", "running", "succeeded", "failed", "cancelled", "skipped", "unknown"] as const
    return t(`status.${known.find((s) => s === status) ?? "unknown"}`)
  }
  const router = useRouter()
  const [editing, setEditing] = useState<PublicBuild | "new" | null>(null)
  const [form, setForm] = useState<BuildInput>(initial)
  const [customSchedule, setCustomSchedule] = useState(false)
  const [args, setArgs] = useState("{}")
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState<PublicBuild | null>(null)
  const [detail, setDetail] = useState<PublicBuild | null>(null)
  const [runs, setRuns] = useState<PublicBuild["runs"]>([])
  const [page, setPage] = useState(0)
  const [more, setMore] = useState(false)
  const [logs, setLogs] = useState<string | null>(null)
  const [runError, setRunError] = useState<string | null>(null)
  const [runBusy, setRunBusy] = useState(false)

  useEffect(() => { const timer = setInterval(() => router.refresh(), 15000); return () => clearInterval(timer) }, [router])
  useEffect(() => {
    if (!detail) return
    let cancelled = false
    const load = async () => {
      setRunBusy(true)
      try {
        const data = await request(`/api/builds/${detail.id}/runs?page=${page}`)
        if (!cancelled) { setRuns(data.runs); setMore(data.hasMore); setRunError(null) }
      } catch (err) { if (!cancelled) setRunError(err instanceof Error ? err.message : t("error")) }
      finally { if (!cancelled) setRunBusy(false) }
    }
    void load(); const timer = setInterval(load, 15000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [detail, page, t])
  function edit(build: PublicBuild | "new") {
    setEditing(build)
    setCustomSchedule(build !== "new" && !["0 * * * *", "0 3 * * *", "0 3 * * 1", "0 3 1 * *"].includes(build.schedule))
    if (build === "new") { setForm({ ...initial, projectId: projects[0]?.id ?? "" }); setArgs("{}") }
    else {
      const { name, description, projectId, targetRepo, tag, sourceKind, dockerfileContent, gitUrl, gitRef, contextPath, dockerfilePath, buildArgs, schedule, enabled } = build
      setForm({ name, description, projectId, targetRepo, tag, sourceKind, dockerfileContent, gitUrl, gitRef, contextPath, dockerfilePath, buildArgs, schedule, enabled }); setArgs(JSON.stringify(buildArgs, null, 2))
    }
  }
  async function action(url: string, method = "POST", body?: unknown) {
    setBusy(true)
    try { const result = await request(url, method, body); router.refresh(); if (result.applied === false && result.lastError) toast.error(result.lastError); else toast.success(t("saved")); return true }
    catch (err) { toast.error(err instanceof Error ? err.message : t("error")); return false }
    finally { setBusy(false) }
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault()
    let buildArgs: unknown
    try { buildArgs = JSON.parse(args) } catch { toast.error(t("argsInvalid")); return }
    const ok = await action(editing === "new" ? "/api/builds" : `/api/builds/${editing?.id}`, editing === "new" ? "POST" : "PATCH", { ...form, buildArgs })
    if (ok) setEditing(null)
  }
  const field = (key: keyof BuildInput, value: string | boolean) => setForm((old) => ({ ...old, [key]: value }))
  return <div className="space-y-5 px-4 pb-8 lg:px-6">
    {!enabled && <p className="rounded-md border bg-muted/40 p-4 text-sm text-muted-foreground">{t("disabled")}</p>}
    <div className="flex items-center justify-between gap-4"><p className="text-sm text-muted-foreground">{t("count", { count: builds.length })}</p><Button disabled={!enabled || !projects.length} onClick={() => edit("new")}><Plus />{t("create")}</Button></div>
    {!projects.length && enabled && <p className="text-sm text-muted-foreground">{t("noProjects")}</p>}
    {!builds.length ? <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed px-6 py-16 text-center"><Hammer className="size-8 text-muted-foreground" /><h2 className="font-medium">{t("empty")}</h2><p className="max-w-lg text-sm text-muted-foreground">{t("emptyHint")}</p></div> :
    <div className="overflow-x-auto rounded-lg border"><table className="w-full text-left text-sm"><thead className="border-b bg-muted/40 text-muted-foreground"><tr>{(["name", "destination", "schedule", "state", "actions"] as const).map((key) => <th key={key} className="px-4 py-3 font-medium">{t(key)}</th>)}</tr></thead><tbody>{builds.map((b) => <tr key={b.id} className="border-b last:border-0 align-top">
      <td className="px-4 py-4"><button className="font-medium underline-offset-4 hover:underline" onClick={() => { setDetail(b); setPage(0); setLogs(null); setRuns([]) }}>{b.name}</button><p className="mt-1 max-w-64 truncate text-xs text-muted-foreground">{b.sourceKind === "git" ? b.gitUrl : t("inline")}</p></td>
      <td className="px-4 py-4"><span className="break-all font-mono text-xs">{b.projectName}/{b.targetRepo}:{b.tag}</span></td>
      <td className="px-4 py-4"><span className="font-mono text-xs">{b.schedule} UTC</span>{b.nextRunAt && <p className="mt-1 text-xs text-muted-foreground">{t("next")}: {new Date(b.nextRunAt).toISOString().replace("T", " ").slice(0, 16)} UTC</p>}</td>
      <td className="max-w-80 px-4 py-4"><Badge variant={b.applied ? "secondary" : "outline"}>{b.deleting ? t("deleting") : !b.applied ? t("notApplied") : b.enabled ? t("active") : t("paused")}</Badge>{b.runs[0] && <p className="mt-2 text-xs">{t("last")}: {statusLabel(b.runs[0].status)}</p>}{b.lastError && <p className="mt-2 text-xs text-destructive">{b.lastError}</p>}</td>
      <td className="px-4 py-4"><div className="flex flex-wrap gap-1">
        <Button size="sm" variant="outline" disabled={busy || !enabled || !b.applied || b.deleting} onClick={() => action(`/api/builds/${b.id}/run`)}><Play />{t("run")}</Button>
        <Button size="sm" variant="ghost" disabled={busy || b.deleting || !enabled} aria-label={t("edit")} title={t("edit")} onClick={() => edit(b)}><Pencil /></Button>
        <Button size="sm" variant="ghost" disabled={busy || b.deleting || !enabled} aria-label={t("apply")} title={t("apply")} onClick={() => action(`/api/builds/${b.id}/apply`)}><RefreshCw /></Button>
        <Button size="sm" variant="ghost" disabled={busy || b.deleting || (!b.enabled && !enabled)} aria-label={t(b.enabled ? "pause" : "resume")} title={t(b.enabled ? "pause" : "resume")} onClick={() => action(`/api/builds/${b.id}`, "PATCH", { enabled: !b.enabled })}>{b.enabled ? <Pause /> : <Play />}</Button>
        <Button size="sm" variant="ghost" disabled={busy} aria-label={t("delete")} title={t("delete")} onClick={() => setConfirm(b)}><Trash2 /></Button>
      </div></td>
    </tr>)}</tbody></table></div>}
    <Dialog open={editing !== null} onOpenChange={(open) => { if (!open && !busy) setEditing(null) }}><DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl"><DialogHeader><DialogTitle>{editing === "new" ? t("create") : t("edit")}</DialogTitle><DialogDescription>{t("formHint")}</DialogDescription></DialogHeader>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2"><div className="space-y-2"><Label htmlFor="build-name">{t("name")}</Label><Input id="build-name" required value={form.name} onChange={(e) => field("name", e.target.value)} /></div><div className="space-y-2"><Label htmlFor="build-project">{t("project")}</Label><select id="build-project" className={selectClass} disabled={editing !== "new"} value={form.projectId} onChange={(e) => field("projectId", e.target.value)}>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div></div>
        <div className="grid gap-4 sm:grid-cols-2"><div className="space-y-2"><Label htmlFor="build-repo">{t("repo")}</Label><Input id="build-repo" required disabled={editing !== "new"} value={form.targetRepo} onChange={(e) => field("targetRepo", e.target.value)} /></div><div className="space-y-2"><Label htmlFor="build-tag">{t("tag")}</Label><Input id="build-tag" required disabled={editing !== "new"} value={form.tag} onChange={(e) => field("tag", e.target.value)} /></div></div>
        <div className="space-y-2"><Label htmlFor="build-source">{t("source")}</Label><select id="build-source" className={selectClass} value={form.sourceKind} onChange={(e) => setForm((f) => ({ ...f, sourceKind: e.target.value as "inline" | "git", dockerfileContent: e.target.value === "inline" ? initial.dockerfileContent : "", gitUrl: "", gitRef: "" }))}><option value="inline">{t("inline")}</option><option value="git">{t("git")}</option></select></div>
        {form.sourceKind === "inline" ? <div className="space-y-2"><Label htmlFor="dockerfile">Dockerfile</Label><Textarea id="dockerfile" required rows={7} className="font-mono text-xs" value={form.dockerfileContent} onChange={(e) => field("dockerfileContent", e.target.value)} /><p className="text-xs text-muted-foreground">{t("inlineHint")}</p></div> : <div className="space-y-4"><div className="space-y-2"><Label htmlFor="git-url">{t("gitUrl")}</Label><Input id="git-url" type="url" required value={form.gitUrl} onChange={(e) => field("gitUrl", e.target.value)} /></div><div className="grid gap-4 sm:grid-cols-3">{(["gitRef", "contextPath", "dockerfilePath"] as const).map((key) => <div key={key} className="space-y-2"><Label htmlFor={key}>{t(key)}</Label><Input id={key} required value={form[key]} onChange={(e) => field(key, e.target.value)} /></div>)}</div><p className="text-xs text-muted-foreground">{t("gitHint")}</p></div>}
        <div className="grid gap-4 sm:grid-cols-2"><div className="space-y-2"><Label htmlFor="build-preset">{t("frequency")}</Label><select id="build-preset" className={selectClass} value={!customSchedule && ["0 * * * *", "0 3 * * *", "0 3 * * 1", "0 3 1 * *"].includes(form.schedule) ? form.schedule : "custom"} onChange={(e) => { setCustomSchedule(e.target.value === "custom"); if (e.target.value !== "custom") field("schedule", e.target.value) }}><option value="0 * * * *">{t("hourly")}</option><option value="0 3 * * *">{t("daily")}</option><option value="0 3 * * 1">{t("weekly")}</option><option value="0 3 1 * *">{t("monthly")}</option><option value="custom">{t("custom")}</option></select></div><div className="space-y-2"><Label htmlFor="build-schedule">{t("cron")}</Label><Input id="build-schedule" required value={form.schedule} onChange={(e) => { setCustomSchedule(true); field("schedule", e.target.value) }} /></div></div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.enabled} onChange={(e) => field("enabled", e.target.checked)} />{t("enable")}</label>
        <details className="rounded-md border p-3"><summary className="cursor-pointer text-sm">{t("advanced")}</summary><div className="mt-4 space-y-2"><Label htmlFor="build-description">{t("descriptionLabel")}</Label><Input id="build-description" value={form.description} onChange={(e) => field("description", e.target.value)} /><Label htmlFor="build-args">{t("args")}</Label><Textarea id="build-args" className="font-mono text-xs" value={args} onChange={(e) => setArgs(e.target.value)} /><p className="text-xs text-muted-foreground">{t("argsHint")}</p></div></details>
        <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={() => setEditing(null)}>{t("cancel")}</Button><Button disabled={busy}>{busy ? t("saving") : t("save")}</Button></DialogFooter>
      </form></DialogContent></Dialog>
    <Dialog open={!!confirm} onOpenChange={(open) => { if (!open && !busy) setConfirm(null) }}><DialogContent><DialogHeader><DialogTitle>{t("delete")}</DialogTitle><DialogDescription>{t("deleteHint", { name: confirm?.name ?? "" })}</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={() => setConfirm(null)}>{t("cancel")}</Button><Button variant="destructive" disabled={busy} onClick={async () => { if (await action(`/api/builds/${confirm?.id}`, "DELETE")) setConfirm(null) }}>{t("delete")}</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={!!detail} onOpenChange={(open) => { if (!open) setDetail(null) }}><DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-3xl"><DialogHeader><DialogTitle>{detail?.name} — {t("history")}</DialogTitle><DialogDescription>{t("historyHint")}</DialogDescription></DialogHeader>
      {runError && <p role="alert" className="text-sm text-destructive">{runError}</p>}
      {!runs.length && <p className="text-sm text-muted-foreground">{runBusy ? t("loading") : t("noRuns")}</p>}
      <div className="space-y-3">{runs.map((r) => <div key={r.id} className="space-y-2 border-b pb-3"><div className="flex flex-wrap items-center justify-between gap-2"><span className="text-sm">{statusLabel(r.status)} · {t(r.origin === "manual" ? "manual" : "scheduled")} · {new Date(r.createdAt).toISOString().replace("T", " ").slice(0, 19)} UTC</span><div className="flex gap-1">{["build", "claim"].map((container) => <Button key={container} size="sm" variant="outline" onClick={async () => { setLogs(t("loading")); try { const data = await request(`/api/builds/${detail?.id}/runs/${r.id}/logs?container=${container}`); setLogs(data.status === "ok" ? data.text : t("logsGone")) } catch (err) { setLogs(err instanceof Error ? err.message : t("error")) } }}>{t(container === "build" ? "logs" : "claimLogs")}</Button>)}</div></div>{r.commit && <p className="break-all font-mono text-xs">commit: {r.commit}</p>}{r.digest && <p className="break-all font-mono text-xs">{r.digest}</p>}{r.error && <p className="text-xs text-destructive">{r.stage ? `${r.stage}: ` : ""}{r.error}</p>}</div>)}</div>
      <div className="flex justify-end gap-2"><Button variant="outline" disabled={page === 0 || runBusy} onClick={() => setPage((p) => p - 1)}>{t("previous")}</Button><Button variant="outline" disabled={!more || runBusy} onClick={() => setPage((p) => p + 1)}>{t("more")}</Button></div>
      {logs !== null && <pre className="max-h-80 overflow-auto rounded-md bg-muted p-4 text-xs whitespace-pre-wrap break-all">{logs}</pre>}
    </DialogContent></Dialog>
  </div>
}

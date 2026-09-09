"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Bot, Copy, Eye, EyeOff, KeyRound, Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { useLocale, useTranslations } from "next-intl"

import { extractErrorMessage } from "@/lib/api-error"
import { useUnsavedChanges } from "@/hooks/use-unsaved-changes"
import { copyToClipboard } from "@/lib/clipboard"
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
  ROBOT_SECRET_MAX_LENGTH,
  ROBOT_SECRET_MIN_LENGTH,
  robotSecretPolicyViolation,
  type RobotSecretViolation,
} from "@/lib/clusters/robot-secret"
import { formatDate } from "@/lib/format-date"

interface RobotAccount {
  id: string
  name: string
  expiresAt: string | null
  createdAt: string
  /** False when a Harbor refused the secret alignment and kept its own — see the warning below. */
  unifiedSecret: boolean
  syncedCount: number
  memberCount: number
}

function SecretChoiceFields({
  idPrefix,
  custom,
  onCustomChange,
  secret,
  onSecretChange,
  error,
}: {
  idPrefix: string
  custom: boolean
  onCustomChange: (value: boolean) => void
  secret: string
  onSecretChange: (value: string) => void
  error: RobotSecretViolation | null
}) {
  const t = useTranslations("projects.robots")
  const [visible, setVisible] = React.useState(false)
  const policyMessages: Record<RobotSecretViolation, string> = {
    length: t("policyLength", { min: ROBOT_SECRET_MIN_LENGTH, max: ROBOT_SECRET_MAX_LENGTH }),
    lowercase: t("policyLowercase"),
    uppercase: t("policyUppercase"),
    digit: t("policyDigit"),
  }

  return (
    <>
      <div className="flex items-center justify-between gap-4 rounded-lg border px-3 py-2">
        <div className="flex flex-col gap-0.5">
          <Label htmlFor={`${idPrefix}Custom`}>{t("setSecretMyself")}</Label>
          <span className="text-xs text-muted-foreground">{t("generatedHint")}</span>
        </div>
        <Switch id={`${idPrefix}Custom`} checked={custom} onCheckedChange={onCustomChange} />
      </div>

      {custom && (
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${idPrefix}Secret`}>{t("secret")}</Label>
          <div className="relative">
            <Input
              id={`${idPrefix}Secret`}
              required
              type={visible ? "text" : "password"}
              value={secret}
              onChange={(e) => onSecretChange(e.target.value)}
              className="pr-10 font-mono text-sm"
              aria-invalid={Boolean(error)}
              autoComplete="new-password"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="absolute top-1/2 right-0.5 -translate-y-1/2 text-muted-foreground"
              aria-label={visible ? t("hideSecret") : t("showSecret")}
              onClick={() => setVisible((current) => !current)}
            >
              {visible ? <EyeOff /> : <Eye />}
            </Button>
          </div>
          <p className={`text-xs leading-5 ${error ? "text-destructive" : "text-muted-foreground"}`}>
            {error ? policyMessages[error] : t("policyHint", { min: ROBOT_SECRET_MIN_LENGTH })}
          </p>
        </div>
      )}
    </>
  )
}

function SecretField({ label, secret }: { label?: string; secret: string }) {
  const t = useTranslations("projects.robots")
  return (
    <div className="flex flex-col gap-1.5">
      {label && <span className="text-xs font-medium text-muted-foreground">{label}</span>}
      <div className="flex items-center gap-2">
        <Input readOnly value={secret} className="font-mono text-xs" />
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label={label ? t("copySecretFor", { label }) : t("copySecret")}
          onClick={() => {
            void copyToClipboard(secret).then((ok) =>
              ok ? toast.success(t("copied")) : toast.error(t("copyFailed"))
            )
          }}
        >
          <Copy />
        </Button>
      </div>
    </div>
  )
}

export function ProjectRobotsTab({
  projectId,
  robots,
  isManager,
  isActive,
}: {
  projectId: string
  robots: RobotAccount[]
  isManager: boolean
  isActive: boolean
}) {
  const t = useTranslations("projects.robots")
  const tc = useTranslations("common")
  const locale = useLocale()
  const router = useRouter()
  const [open, setOpen] = React.useState(false)
  const [submitting, setSubmitting] = React.useState(false)
  const [name, setName] = React.useState("")
  const [customSecret, setCustomSecret] = React.useState(false)
  const [secret, setSecret] = React.useState("")

  // Harbor's own policy, checked here so a rejection lands in the form rather than partway
  // through a fan-out that already created the robot on some members.
  const secretError = customSecret && secret !== "" ? robotSecretPolicyViolation(secret) : null
  // `memberSecrets` is only ever non-empty when a Harbor refused the cluster-wide secret and
  // kept its own — that credential is visible here and nowhere else, ever.
  const [revealedSecret, setRevealedSecret] = React.useState<{
    name: string
    secret: string
    memberSecrets: { registry: string; secret: string }[]
  } | null>(null)
  const [secretStored, setSecretStored] = React.useState(false)
  useUnsavedChanges(Boolean(revealedSecret) && !secretStored)
  const [deletingId, setDeletingId] = React.useState<string | null>(null)
  const [rotating, setRotating] = React.useState<RobotAccount | null>(null)
  const [rotateCustom, setRotateCustom] = React.useState(false)
  const [rotateSecret, setRotateSecret] = React.useState("")
  const [rotatingBusy, setRotatingBusy] = React.useState(false)

  const rotateError =
    rotateCustom && rotateSecret !== "" ? robotSecretPolicyViolation(rotateSecret) : null

  function closeRotate() {
    setRotating(null)
    setRotateCustom(false)
    setRotateSecret("")
  }

  async function handleRotate(e: React.FormEvent) {
    e.preventDefault()
    if (!rotating) return
    setRotatingBusy(true)
    try {
      const res = await fetch(`/api/projects/${projectId}/robots/${rotating.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret: rotateCustom ? rotateSecret : null }),
      })

      if (!res.ok) {
        const body = await res.json().catch(() => null)
        toast.error(extractErrorMessage(body, t("rotateFailed")))
        return
      }

      const rotated = await res.json()
      closeRotate()
      // Same one-shot reveal as creation — the new secret is not retrievable afterwards.
      setRevealedSecret({ name: rotated.name, secret: rotated.secret, memberSecrets: [] })
      setSecretStored(false)
      if (rotated.placements?.failed > 0) {
        toast.warning(t("keptPrevious", { count: rotated.placements.failed }))
      }
      router.refresh()
    } catch {
      toast.error(t("rotateFailed"))
    } finally {
      setRotatingBusy(false)
    }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    try {
      const res = await fetch(`/api/projects/${projectId}/robots`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, secret: customSecret ? secret : null }),
      })

      if (!res.ok) {
        const body = await res.json().catch(() => null)
        toast.error(extractErrorMessage(body, t("createFailed")))
        return
      }

      const created = await res.json()
      setName("")
      setSecret("")
      setCustomSecret(false)
      setOpen(false)
      setRevealedSecret({
        name: created.name,
        secret: created.secret,
        memberSecrets: created.memberSecrets ?? [],
      })
      setSecretStored(false)
      // A partial rollout still yields a working credential on the members that took it.
      if (created.placements?.failed > 0) {
        toast.warning(t("createdPartial", { succeeded: created.placements.succeeded, failed: created.placements.failed }))
      }
      router.refresh()
    } catch {
      toast.error(t("createFailed"))
    } finally {
      setSubmitting(false)
    }
  }

  async function handleDelete(id: string) {
    setDeletingId(id)
    try {
      const res = await fetch(`/api/projects/${projectId}/robots/${id}`, { method: "DELETE" })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        toast.error(extractErrorMessage(body, t("revokeFailed")))
        return
      }

      toast.success(t("revoked"))
      router.refresh()
    } catch {
      toast.error(t("revokeFailed"))
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {isManager && (
        <div className="flex flex-col items-end gap-1.5">
          {!isActive && (
            <p className="text-xs text-muted-foreground">{t("availableOnceActive")}</p>
          )}
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
            <Button
              disabled={!isActive}
            >
                <Plus />
                {t("newRobot")}
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-md">
              <form onSubmit={handleCreate}>
                <DialogHeader>
                  <DialogTitle>{t("newRobot")}</DialogTitle>
                  <DialogDescription>{t("newRobotDescription")}</DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-4 py-4">
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="robotName">{t("name")}</Label>
                    <Input id="robotName" required value={name} onChange={(e) => setName(e.target.value)} placeholder={t("namePlaceholder")} />
                  </div>

                  <SecretChoiceFields
                    idPrefix="create"
                    custom={customSecret}
                    onCustomChange={(checked) => {
                      setCustomSecret(checked)
                      if (!checked) setSecret("")
                    }}
                    secret={secret}
                    onSecretChange={setSecret}
                    error={secretError}
                  />
                </div>
                <DialogFooter>
                  <Button type="submit" disabled={submitting || Boolean(secretError)}>
                    {submitting ? t("creating") : t("create")}
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        </div>
      )}

      {robots.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed px-12 py-10 text-center sm:px-5 sm:py-14">
          <div className="flex size-11 items-center justify-center rounded-md bg-muted">
            <Bot className="size-5 text-muted-foreground" />
          </div>
          <div>
            <p className="text-sm font-medium">{t("emptyTitle")}</p>
            <p className="mt-1 text-sm text-muted-foreground">{t("emptyHint")}</p>
          </div>
        </div>
      ) : (
        <div className="divide-y overflow-hidden rounded-lg border">
          {robots.map((robot) => (
            <div key={robot.id} className="flex items-start justify-between gap-3 px-4 py-3">
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="font-mono text-sm">{robot.name}</span>
                <span className="text-xs text-muted-foreground">
                  {robot.expiresAt ? t("expires", { date: formatDate(robot.expiresAt, locale) }) : t("neverExpires")}
                  {robot.memberCount > 1 && ` · ${robot.syncedCount}/${robot.memberCount} Harbors`}
                </span>
                {!robot.unifiedSecret && (
                  <span className="text-xs text-warning">{t("secretDiffers")}</span>
                )}
              </div>
              {isManager && (
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("rotateAria", { name: robot.name })}
                    onClick={() => setRotating(robot)}
                  >
                    <KeyRound />
                  </Button>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      disabled={deletingId === robot.id}
                      aria-label={t("revokeAria", { name: robot.name })}
                    >
                      <Trash2 className="text-destructive" />
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>{t("revokeTitle", { name: robot.name })}</AlertDialogTitle>
                      <AlertDialogDescription>{t("revokeDescription")}</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>{tc("cancel")}</AlertDialogCancel>
                      <AlertDialogAction variant="destructive" onClick={() => handleDelete(robot.id)}>
                        {t("revoke")}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <Dialog open={Boolean(rotating)} onOpenChange={(open) => !open && closeRotate()}>
        <DialogContent className="sm:max-w-md">
          <form onSubmit={handleRotate}>
            <DialogHeader>
              <DialogTitle>{t("rotateTitle", { name: rotating?.name ?? "" })}</DialogTitle>
              <DialogDescription>{t("rotateDescription")}</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-4 py-4">
              <SecretChoiceFields
                idPrefix="rotate"
                custom={rotateCustom}
                onCustomChange={(checked) => {
                  setRotateCustom(checked)
                  if (!checked) setRotateSecret("")
                }}
                secret={rotateSecret}
                onSecretChange={setRotateSecret}
                error={rotateError}
              />
            </div>
            <DialogFooter>
              <Button type="submit" disabled={rotatingBusy || Boolean(rotateError)}>
                {rotatingBusy ? t("rotating") : t("rotateSecret")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(revealedSecret)}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && secretStored) setRevealedSecret(null)
        }}
      >
        <DialogContent
          className="sm:max-w-md"
          showCloseButton={false}
          onEscapeKeyDown={(event) => event.preventDefault()}
          onPointerDownOutside={(event) => event.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle>{t("createdTitle", { name: revealedSecret?.name ?? "" })}</DialogTitle>
            <DialogDescription>
              {revealedSecret && revealedSecret.memberSecrets.length > 0 ? t("shownOnceMany") : t("shownOnce")}
            </DialogDescription>
          </DialogHeader>

          {revealedSecret && revealedSecret.memberSecrets.length > 0 && (
            <p className="rounded-lg border border-warning/20 bg-warning/6 px-3 py-2 text-xs leading-5 text-muted-foreground">
              {t("refusedShared", { count: revealedSecret.memberSecrets.length })}
            </p>
          )}

          <SecretField
            label={revealedSecret && revealedSecret.memberSecrets.length > 0 ? t("everyOtherHarbor") : undefined}
            secret={revealedSecret?.secret ?? ""}
          />

          {revealedSecret?.memberSecrets.map((member) => (
            <SecretField key={member.registry} label={member.registry} secret={member.secret} />
          ))}
          <label className="flex cursor-pointer items-start gap-3 rounded-lg border bg-muted/30 px-3 py-3 text-sm">
            <input
              type="checkbox"
              checked={secretStored}
              onChange={(event) => setSecretStored(event.target.checked)}
              className="mt-0.5 size-4 accent-primary"
            />
            <span>{t("storedConfirm")}</span>
          </label>
          <DialogFooter>
            <Button disabled={!secretStored} onClick={() => setRevealedSecret(null)}>
              {t("done")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

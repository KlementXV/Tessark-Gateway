"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { ShieldCheck } from "lucide-react"
import { toast } from "sonner"
import { useTranslations } from "next-intl"

import { extractErrorMessage } from "@/lib/api-error"
import { SubHeader } from "@/components/layout/page-header"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"

/**
 * The company's own certificate authority, for the whole instance.
 *
 * One bundle rather than a field on every registry and every source: an internal CA signs the
 * whole estate, and a copy pasted in ten places is nine copies to miss when it is rotated.
 *
 * The stored PEM never comes back to the browser — the server returns whether one is set and
 * its SHA-256, which is what an operator compares a bundle against. So an empty textarea means
 * "leave it alone", and removing is its own button rather than clearing the field: the two
 * would otherwise be the same gesture.
 */
export function EnterpriseCaSection({
  configured,
  fingerprint,
  jobDefault,
  enabled,
}: {
  configured: boolean
  fingerprint: string | null
  /** Whether the skopeo copy Jobs get the bundle unless a transfer says otherwise. */
  jobDefault: boolean
  /** CUSTOM_CA_BETA_ENABLED. False keeps what is stored and refuses new runs that need it. */
  enabled: boolean
}) {
  const t = useTranslations("enterpriseCa")
  const router = useRouter()
  const [pem, setPem] = React.useState("")
  const [submitting, setSubmitting] = React.useState(false)

  // One endpoint, two independent fields: flipping the Job default must not require pasting
  // the certificate again, so only what changed is sent.
  async function save(
    body: { enterpriseCaPem?: string | null; enterpriseCaJobDefault?: boolean },
    success: string,
  ) {
    setSubmitting(true)
    try {
      const res = await fetch("/api/settings/ca", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const payload = await res.json().catch(() => null)
        toast.error(extractErrorMessage(payload, t("saveFailed")))
        return
      }
      toast.success(success)
      setPem("")
      router.refresh()
    } catch {
      toast.error(t("saveFailed"))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section className="flex flex-col gap-4 px-4 lg:px-6">
      <SubHeader
        title={
          <span className="flex items-center gap-2">
            {t("title")}
            <Badge variant="outline">{t("beta")}</Badge>
          </span>
        }
        description={t("description")}
      />

      <div className="flex flex-col gap-4 rounded-lg border p-4">
        {!enabled && <p className="text-sm text-muted-foreground">{t("disabled")}</p>}

        <div className="flex items-start gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted">
            <ShieldCheck className="size-4 text-muted-foreground" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-medium">{configured ? t("configured") : t("notConfigured")}</p>
            {fingerprint && (
              <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
                SHA-256 {fingerprint}
              </p>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="enterpriseCaPem">{configured ? t("replaceLabel") : t("addLabel")}</Label>
          <Textarea
            id="enterpriseCaPem"
            className="font-mono text-xs"
            rows={6}
            value={pem}
            onChange={(e) => setPem(e.target.value)}
            placeholder="-----BEGIN CERTIFICATE-----"
          />
          <p className="text-xs text-muted-foreground">{t("hint")}</p>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            disabled={submitting || !pem.trim()}
            onClick={() => save({ enterpriseCaPem: pem }, t("saved"))}
          >
            {submitting ? t("saving") : configured ? t("replace") : t("add")}
          </Button>
          {configured && (
            <Button
              type="button"
              variant="outline"
              disabled={submitting}
              onClick={() => save({ enterpriseCaPem: null }, t("removed"))}
            >
              {t("remove")}
            </Button>
          )}
        </div>
      </div>

      <div className="flex items-start justify-between gap-4 rounded-lg border p-4">
        <div className="min-w-0">
          <Label htmlFor="enterpriseCaJobDefault">{t("jobDefault")}</Label>
          <p className="mt-0.5 text-sm text-muted-foreground">{t("jobDefaultHint")}</p>
        </div>
        <Switch
          id="enterpriseCaJobDefault"
          checked={jobDefault}
          disabled={submitting}
          onCheckedChange={(value) =>
            save({ enterpriseCaJobDefault: value }, value ? t("jobDefaultOn") : t("jobDefaultOff"))
          }
        />
      </div>
    </section>
  )
}

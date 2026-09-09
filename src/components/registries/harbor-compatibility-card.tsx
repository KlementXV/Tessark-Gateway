import { CheckCircle2, CircleHelp, MinusCircle, XCircle } from "lucide-react"
import { getLocale, getTranslations } from "next-intl/server"

import { formatRelativeTime } from "@/lib/format-date"
import type { Locale } from "@/i18n/locale"
import type { RegistryCompatibility } from "@/lib/registries/compatibility"
import type { Availability, ProofState } from "@/lib/registries/harbor-capabilities"

/**
 * What this Harbor can be asked to do, and on what evidence.
 *
 * Availability and proof are shown as two different things, because they are: a function this
 * Harbor cannot perform is an operator's problem (upgrade it), while a function nobody has
 * certified here is ours. Nothing on this card refuses anything — the Gateway does not gate a
 * feature on the absence of a certificate.
 */
const AVAILABILITY_ICON: Record<Availability, typeof CheckCircle2> = {
  available: CheckCircle2,
  unavailable: MinusCircle,
  unknown: CircleHelp,
}

const PROOF_ICON: Record<ProofState, typeof CheckCircle2> = {
  verified: CheckCircle2,
  expected: CircleHelp,
  broken: XCircle,
  inconclusive: CircleHelp,
  unknown: CircleHelp,
}

export async function HarborCompatibilityCard({
  assessment,
  seenAt,
  fresh,
}: {
  assessment: RegistryCompatibility
  seenAt: Date | null
  fresh: boolean
}) {
  const [t, locale] = await Promise.all([getTranslations("harborCompatibility"), getLocale()])

  return (
    <section className="mx-4 rounded-lg border bg-muted/25 px-4 py-3 lg:mx-6">
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-sm font-medium">{t("cardTitle")}</h2>
        <p className="text-xs text-muted-foreground">
          {assessment.version ? (
            <>
              {t("observedVersion", { version: assessment.version })}
              {seenAt ? (
                <>
                  {" · "}
                  {/* The age is the point: a reading from last week is not a claim about now. */}
                  <span className={fresh ? undefined : "text-amber-600 dark:text-amber-500"}>
                    {t("seenAt", { ago: formatRelativeTime(seenAt, locale as Locale) })}
                  </span>
                </>
              ) : null}
            </>
          ) : (
            t("noObservation")
          )}
        </p>
      </header>

      <p className="mt-1 text-xs text-muted-foreground">{t(`support.${assessment.support}`)}</p>

      <ul className="mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-2">
        {assessment.capabilities.map((capability) => {
          const AvailabilityIcon = AVAILABILITY_ICON[capability.availability]
          const ProofIcon = PROOF_ICON[capability.proof]
          const degraded = capability.availability !== "available"
          return (
            <li key={capability.capabilityId} className="flex items-start gap-2 text-sm">
              <AvailabilityIcon
                aria-hidden
                className={`mt-0.5 size-4 shrink-0 ${
                  capability.availability === "available"
                    ? "text-muted-foreground"
                    : capability.availability === "unavailable"
                      ? "text-amber-600 dark:text-amber-500"
                      : "text-muted-foreground/60"
                }`}
              />
              <span className="min-w-0">
                <span className={degraded ? "text-muted-foreground" : undefined}>
                  {t(`capabilities.${capability.capabilityId}.name`)}
                </span>
                <span className="ml-2 inline-flex items-center gap-1 text-xs text-muted-foreground">
                  <ProofIcon aria-hidden className="size-3" />
                  {t(`proof.${capability.proof}`)}
                </span>
                {/* The degradation is the only part an operator can act on, so it is the part
                    written out in full rather than left to a tooltip. */}
                {degraded && (
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {t(`capabilities.${capability.capabilityId}.degradation`)}
                  </span>
                )}
              </span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

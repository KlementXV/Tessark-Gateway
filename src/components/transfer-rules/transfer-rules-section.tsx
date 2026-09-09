import type { CSSProperties } from "react"
import { ArrowRight, ShieldCheck } from "lucide-react"
import { getTranslations } from "next-intl/server"

import { SubHeader } from "@/components/layout/page-header"
import { Badge } from "@/components/ui/badge"
import { DeleteTransferRuleButton } from "@/components/transfer-rules/delete-transfer-rule-button"
import { TransferRuleFormDialog } from "@/components/transfer-rules/transfer-rule-form-dialog"
import { prisma } from "@/lib/prisma"
import { listTransferRules, type PublicTransferRule } from "@/lib/transfers/rule-service"

// The policy, read as a list of sentences: "from X, to Y, these paths, reviewed or not". The
// point of this page is that an operator can answer "what is allowed to leave?" by reading it
// top to bottom — so each row spells the direction out rather than showing ids.
export async function TransferRulesSection() {
  const [rules, upstreams, registries, t] = await Promise.all([
    listTransferRules(),
    prisma.upstreamSource.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.registry.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
    getTranslations("transferRules"),
  ])

  function sourceLabel(rule: PublicTransferRule): string {
    return rule.sourceUpstreamName ?? rule.sourceRegistryName ?? t("any")
  }

  return (
    <section
      className="animate-enter flex flex-col gap-4 px-4 lg:px-6"
      style={{ "--enter-delay": "120ms" } as CSSProperties}
    >
      <SubHeader
        title={t("title")}
        description={t("description")}
        action={<TransferRuleFormDialog upstreams={upstreams} registries={registries} />}
      />
      {rules.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed px-6 py-12 text-center">
          <div className="flex size-11 items-center justify-center rounded-md bg-muted">
            <ShieldCheck className="size-5 text-muted-foreground" />
          </div>
          <div>
            <p className="text-sm font-medium">{t("emptyTitle")}</p>
            <p className="mt-1 text-sm text-muted-foreground">{t("emptyHint")}</p>
          </div>
          <TransferRuleFormDialog upstreams={upstreams} registries={registries} />
        </div>
      ) : (
        <div className="divide-y overflow-hidden rounded-lg border">
          {rules.map((rule) => (
            <div
              key={rule.id}
              className="flex flex-col items-stretch gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
            >
              <div className="flex min-w-0 flex-col gap-0.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-sm font-medium">{rule.name}</span>
                  <span className="inline-flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
                    {sourceLabel(rule)}
                    <ArrowRight className="size-3" aria-hidden="true" />
                    {rule.destRegistryName ?? t("any")}
                  </span>
                  {!rule.enabled && <Badge variant="outline">{t("off")}</Badge>}
                  <Badge variant="outline" className="font-normal">
                    {rule.requiresApproval ? t("reviewed") : t("automatic")}
                  </Badge>
                </div>
                <span className="line-clamp-2 break-all font-mono text-xs leading-5 text-muted-foreground sm:truncate">
                  {rule.repoFilter.join(" · ")} → {rule.projectFilter.join(" · ")}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-1 self-end sm:self-auto">
                <TransferRuleFormDialog rule={rule} upstreams={upstreams} registries={registries} />
                <DeleteTransferRuleButton id={rule.id} name={rule.name} />
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

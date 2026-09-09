import type { Metadata } from "next"
import { getTranslations } from "next-intl/server"

import { auth } from "@/auth"
import { caFingerprint } from "@/lib/ca"
import { getConfig } from "@/lib/config"
import { readEnterpriseCa } from "@/lib/settings/enterprise-ca"
import { Role } from "@/generated/prisma/client"
import { hasRole } from "@/lib/auth/guard"
import { PageHeader } from "@/components/layout/page-header"
import { EnterpriseCaSection } from "@/components/settings/enterprise-ca-section"
import { SourcesSection } from "@/components/sources/sources-section"
import { TransferRulesSection } from "@/components/transfer-rules/transfer-rules-section"

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("policy")
  return { title: t("title") }
}

/**
 * What is allowed, in one page and two halves: the upstream sources images may come *from*,
 * and the rules that say which source → destination routes are open. They used to be two
 * tabs, which made the page an operator had to assemble mentally out of both — a rule names
 * an upstream source, and a source with no rule pointing at it opens nothing.
 *
 * The role split survives the merge rather than being flattened: sources are ADMIN (matching
 * /api/sources), rules are SUPERADMIN (matching /api/transfer-rules — changing the policy
 * admins review requests *against* is a different authority from operating under it). An
 * admin therefore sees this page with one section, not a section that answers 403.
 */
export default async function PolicyPage() {
  const [session, t] = await Promise.all([auth(), getTranslations("policy")])
  const isSuperAdmin = hasRole(session, Role.SUPERADMIN)

  // Read only for the role that may change it — the section is not rendered otherwise, and a
  // page that fetched it anyway would be handing the fingerprint to an ADMIN who has no
  // control over it.
  const enterpriseCa = isSuperAdmin ? await readEnterpriseCa() : null

  return (
    <>
      <PageHeader title={t("title")} description={t("description")} />
      {isSuperAdmin && (
        <EnterpriseCaSection
          configured={Boolean(enterpriseCa?.pem)}
          fingerprint={enterpriseCa?.pem ? caFingerprint(enterpriseCa.pem) : null}
          jobDefault={enterpriseCa?.jobDefault ?? true}
          enabled={getConfig().customCaBetaEnabled}
        />
      )}
      <SourcesSection />
      {isSuperAdmin && <TransferRulesSection />}
    </>
  )
}

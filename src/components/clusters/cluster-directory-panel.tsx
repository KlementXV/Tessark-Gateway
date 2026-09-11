import type { CSSProperties, ReactNode } from "react"
import { getTranslations } from "next-intl/server"

import { SubHeader } from "@/components/layout/page-header"
import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type {
  DirectoryClusterView,
  DirectoryField,
  DirectoryFindingKind,
  DirectoryMemberView,
  DirectoryVerdict,
} from "@/lib/clusters/directory-view"

// The directory half of "is this cluster healthy?", next to the mesh on the cluster's own page:
// what each Harbor signs people in with, which LDAP directory it reads, and whether the members
// agree. Read-only on purpose (src/lib/clusters/directory-view.ts) — and explicit about the one
// thing it cannot see, the bind password, so that a clean table is never read as proof of it.

const FIELD_KEYS = {
  authMode: "fieldAuthMode",
  url: "fieldUrl",
  searchDn: "fieldSearchDn",
  baseDn: "fieldBaseDn",
  filter: "fieldFilter",
  uid: "fieldUid",
  scope: "fieldScope",
  verifyCert: "fieldVerifyCert",
  groupBaseDn: "fieldGroupBaseDn",
  groupSearchFilter: "fieldGroupSearchFilter",
  groupAttributeName: "fieldGroupAttributeName",
  groupMembershipAttribute: "fieldGroupMembershipAttribute",
} as const satisfies Record<DirectoryField, string>

const FINDING_KEYS = {
  unreachable: "findingUnreachable",
  forbidden: "findingForbidden",
  "directory-error": "findingDirectoryError",
  "verify-cert-off": "findingVerifyCertOff",
  plaintext: "findingPlaintext",
  "ldap-missing": "findingLdapMissing",
} as const satisfies Record<DirectoryFindingKind, string>

const VERDICT_KEYS = {
  consistent: "verdictConsistent",
  attention: "verdictAttention",
  incomplete: "verdictIncomplete",
  "no-directory": "verdictNoDirectory",
} as const satisfies Record<DirectoryVerdict, string>

const AUTH_MODE_KEYS: Record<string, "authModeDb" | "authModeLdap" | "authModeOidc"> = {
  db_auth: "authModeDb",
  ldap_auth: "authModeLdap",
  oidc_auth: "authModeOidc",
}

function VerdictBadge({ verdict, label }: { verdict: DirectoryVerdict; label: string }) {
  if (verdict === "consistent") return <Badge className="bg-success/15 text-success">{label}</Badge>
  if (verdict === "attention") return <Badge className="bg-warning/15 text-warning">{label}</Badge>
  return <Badge variant="outline">{label}</Badge>
}

export async function ClusterDirectoryPanel({
  view,
  action,
}: {
  view: DirectoryClusterView
  /** Rendered next to the title — the opt-in configuration dialog, for a SUPERADMIN. */
  action?: ReactNode
}) {
  const t = await getTranslations("clusters.directory")
  const { capability } = view
  const anyConfigured = view.members.some((member) => member.ldapConfigured)

  const capabilityText = !capability || capability.capability === "unreachable"
    ? t("capabilityUnreachable")
    : capability.capability === "ldap-live"
      ? t("capabilityLive", { registry: capability.registryName ?? "" })
      : capability.reason === "configuration-unreadable"
        ? t("capabilityUnreadable", { registry: capability.registryName ?? "" })
        : t("capabilityHarborKnown", { registry: capability.registryName ?? "" })

  const provisioningText =
    capability?.provisioning === "on-grant"
      ? t("provisioningOnGrant")
      : capability?.provisioning === "first-sign-in"
        ? t("provisioningFirstSignIn")
        : capability?.provisioning === "local-accounts"
          ? t("provisioningLocal")
          : null

  const authModeLabel = (mode: string | null) => {
    if (!mode) return "—"
    const key = AUTH_MODE_KEYS[mode]
    return key ? t(key) : mode
  }

  const statusBadge = (member: DirectoryMemberView) => {
    if (member.status === "unreachable") return <Badge variant="destructive">{t("statusUnreachable")}</Badge>
    if (member.status === "forbidden") return <Badge className="bg-warning/15 text-warning">{t("statusForbidden")}</Badge>
    if (!member.ldapConfigured) return <Badge variant="outline">{t("statusNotConfigured")}</Badge>
    if (member.directoryAnswered) return <Badge className="bg-success/15 text-success">{t("statusAnswers")}</Badge>
    return <Badge variant="destructive">{t("statusDirectoryError")}</Badge>
  }

  return (
    <section
      className="animate-enter flex flex-col gap-3 px-4 lg:px-6"
      style={{ "--enter-delay": "120ms" } as CSSProperties}
    >
      <SubHeader
        title={t("title")}
        description={t("description")}
        action={
          <div className="flex items-center gap-2">
            <VerdictBadge verdict={view.verdict} label={t(VERDICT_KEYS[view.verdict])} />
            {action}
          </div>
        }
      />

      <div className="flex flex-col gap-1 rounded-lg border px-4 py-3 text-sm">
        <p>{capabilityText}</p>
        {provisioningText && <p className="text-muted-foreground">{provisioningText}</p>}
      </div>

      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("columnRegistry")}</TableHead>
              <TableHead>{t("columnAuthMode")}</TableHead>
              <TableHead>{t("columnServer")}</TableHead>
              <TableHead>{t("columnBaseDn")}</TableHead>
              <TableHead>{t("columnUid")}</TableHead>
              <TableHead>{t("columnStatus")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {view.members.map((member) => (
              <TableRow key={member.registryId}>
                <TableCell className="font-medium">{member.registryName}</TableCell>
                <TableCell>{authModeLabel(member.authMode)}</TableCell>
                <TableCell className="break-all font-mono text-xs">{member.settings?.url || "—"}</TableCell>
                <TableCell className="break-all font-mono text-xs">{member.settings?.baseDn || "—"}</TableCell>
                <TableCell className="font-mono text-xs">{member.settings?.uid || "—"}</TableCell>
                <TableCell>{statusBadge(member)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {view.drifts.length > 0 && (
        <div className="flex flex-col gap-2 rounded-lg border border-warning/40 px-4 py-3 text-sm">
          <p className="font-medium">{t("driftTitle")}</p>
          <ul className="flex flex-col gap-2">
            {view.drifts.map((drift) => (
              <li key={drift.field} className="flex flex-col gap-0.5">
                <span className={drift.severity === "warning" ? "text-warning" : undefined}>
                  {t(FIELD_KEYS[drift.field])}
                </span>
                {drift.values.map((entry) => (
                  <span key={`${drift.field}:${entry.value}`} className="text-xs text-muted-foreground">
                    <span className="break-all font-mono">{entry.value || t("valueEmpty")}</span>
                    {" — "}
                    {entry.registries.join(", ")}
                  </span>
                ))}
                {drift.field === "url" && (
                  <span className="text-xs text-muted-foreground">{t("driftUrlHint")}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {view.findings.length > 0 && (
        <div className="flex flex-col gap-2 rounded-lg border px-4 py-3 text-sm">
          <p className="font-medium">{t("findingsTitle")}</p>
          <ul className="flex flex-col gap-1.5">
            {view.findings.map((finding) => (
              <li key={`${finding.kind}:${finding.registryName}`} className="flex flex-col">
                <span>{t(FINDING_KEYS[finding.kind], { registry: finding.registryName })}</span>
                {finding.detail && (
                  <span className="break-all text-xs text-muted-foreground">{finding.detail}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {anyConfigured && <p className="text-xs text-muted-foreground">{t("passwordNote")}</p>}
    </section>
  )
}

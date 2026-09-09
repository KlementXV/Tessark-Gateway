"use client"

import { useTranslations } from "next-intl"

export function CredentialGuidance({ weak, dedicated = false }: { weak: boolean; dedicated?: boolean }) {
  const t = useTranslations("registrySecurity")
  if (!weak && !dedicated) return null
  return (
    <div className="space-y-2 rounded-md border border-warning/30 bg-warning/5 p-3 text-sm">
      {weak && <p role="status" className="font-medium text-warning">{t("weak")}</p>}
      {weak && <p>{t("rotate")}</p>}
      {dedicated && (
        <details>
          <summary className="cursor-pointer font-medium">{t("dedicatedTitle")}</summary>
          <ol className="mt-2 list-decimal space-y-2 pl-5">
            <li>{t("create")}</li>
            <li>{t("permissions")}</li>
            <li>{t("connect")}</li>
          </ol>
          <p className="mt-2 text-muted-foreground">{t("original")}</p>
        </details>
      )}
    </div>
  )
}

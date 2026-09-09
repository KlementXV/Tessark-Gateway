"use client"

import * as React from "react"
import { useTranslations } from "next-intl"

/** Warn before a reload, tab close, or external navigation would discard edited form data. */
export function useUnsavedChanges(enabled: boolean) {
  const t = useTranslations("common")
  const message = t("unsavedChanges")
  React.useEffect(() => {
    if (!enabled) return

    function handleBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault()
      event.returnValue = ""
    }

    function handleDocumentClick(event: MouseEvent) {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return
      }

      const target = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null
      if (!target || target.target === "_blank" || target.hasAttribute("download")) return

      const destination = new URL(target.href, window.location.href)
      if (destination.origin !== window.location.origin || destination.href === window.location.href) return

      if (!window.confirm(message)) {
        event.preventDefault()
        event.stopPropagation()
      }
    }

    window.addEventListener("beforeunload", handleBeforeUnload)
    document.addEventListener("click", handleDocumentClick, true)
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload)
      document.removeEventListener("click", handleDocumentClick, true)
    }
  }, [enabled, message])
}

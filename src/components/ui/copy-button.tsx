"use client"

import * as React from "react"
import { Check, Copy } from "lucide-react"
import { toast } from "sonner"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { copyToClipboard } from "@/lib/clipboard"
import { cn } from "@/lib/utils"

// One copy affordance for the whole app. Success is reported in place — the icon becomes a
// tick for two seconds — rather than by a toast: copying a reference is something people do
// several times in a row on the images screens, and a stack of toasts saying the same thing
// is noise. A failure still toasts, because there is nothing on the button to explain it.
export function CopyButton({
  value,
  label,
  size = "icon-sm",
  variant = "ghost",
  className,
  children,
}: {
  /** The exact text placed on the clipboard. */
  value: string
  /** What is being copied, e.g. "Copier la référence d'image" — used as tooltip and aria-label. */
  label: string
  size?: React.ComponentProps<typeof Button>["size"]
  variant?: React.ComponentProps<typeof Button>["variant"]
  className?: string
  /** Optional visible text; without it the button is icon-only. */
  children?: React.ReactNode
}) {
  const t = useTranslations("common")
  const [copied, setCopied] = React.useState(false)
  const timeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  React.useEffect(
    () => () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
    },
    []
  )

  async function handleCopy() {
    if (!(await copyToClipboard(value))) {
      toast.error(t("copyFailed"))
      return
    }
    setCopied(true)
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
    timeoutRef.current = setTimeout(() => setCopied(false), 2000)
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant={variant}
          size={children ? (size === "icon-sm" ? "sm" : size) : size}
          aria-label={copied ? t("copied") : label}
          className={cn("text-muted-foreground hover:text-foreground", className)}
          onClick={() => void handleCopy()}
        >
          {copied ? <Check className="text-success" /> : <Copy />}
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs break-all">{copied ? t("copied") : label}</TooltipContent>
    </Tooltip>
  )
}

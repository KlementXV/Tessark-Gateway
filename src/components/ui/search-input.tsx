"use client"

import * as React from "react"
import { useTranslations } from "next-intl"
import { Search, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"

/**
 * The one search field used by every filterable list: leading icon, visually hidden label
 * (the placeholder does the talking), and a clear button that only appears once there is
 * something to clear.
 */
export function SearchInput({
  id,
  label,
  value,
  onChange,
  placeholder,
  className,
  ...props
}: Omit<React.ComponentProps<typeof Input>, "onChange" | "value" | "type"> & {
  label: string
  value: string
  onChange: (value: string) => void
}) {
  const t = useTranslations("ui")
  const generatedId = React.useId()
  const inputId = id ?? generatedId
  const containerRef = React.useRef<HTMLDivElement>(null)

  return (
    <div ref={containerRef} className={cn("relative w-full", className)}>
      <Label htmlFor={inputId} className="sr-only">
        {label}
      </Label>
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        id={inputId}
        type="search"
        autoComplete="off"
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="pr-8 pl-8 [&::-webkit-search-cancel-button]:hidden"
        {...props}
      />
      {value && (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="absolute top-1/2 right-1.5 -translate-y-1/2 text-muted-foreground"
          onClick={() => {
            onChange("")
            containerRef.current?.querySelector("input")?.focus()
          }}
          aria-label={t("clear", { label: label.toLowerCase() })}
        >
          <X />
        </Button>
      )}
    </div>
  )
}

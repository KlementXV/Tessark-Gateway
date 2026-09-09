"use client"

import * as React from "react"
import { useTranslations } from "next-intl"

import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { SOURCE_PRESETS, type SourcePreset } from "@/lib/sources/presets"

const CUSTOM = "custom"

// The catalog, as one row of the form rather than a screen of its own. Picking an entry only
// fills the fields below — nothing is written until the source is added, and every field
// stays editable afterwards.
//
// Presets whose host is already configured stay in the list but are disabled: "Docker Hub is
// already there" is more useful than a silently shorter list, and UpstreamSource.host is
// unique so a second one could not be saved anyway.
export function SourcePresetPicker({
  value,
  existingHosts,
  onSelect,
}: {
  value: string
  existingHosts: string[]
  onSelect: (preset: SourcePreset | null) => void
}) {
  const t = useTranslations("sources.picker")
  const taken = React.useMemo(
    () => new Set(existingHosts.map((h) => h.toLowerCase())),
    [existingHosts],
  )

  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor="sourcePreset">{t("startFrom")}</Label>
      <Select
        value={value}
        onValueChange={(v) =>
          onSelect(v === CUSTOM ? null : (SOURCE_PRESETS.find((p) => p.id === v) ?? null))
        }
      >
        <SelectTrigger id="sourcePreset" className="w-full">
          <SelectValue placeholder={t("placeholder")} />
        </SelectTrigger>
        <SelectContent className="max-h-72">
          <SelectItem value={CUSTOM}>{t("custom")}</SelectItem>
          {SOURCE_PRESETS.map((preset) => (
            <SelectItem key={preset.id} value={preset.id} disabled={taken.has(preset.host)}>
              <span className="flex items-baseline gap-2">
                {preset.name}
                <span className="font-mono text-xs text-muted-foreground">
                  {taken.has(preset.host) ? t("added", { host: preset.host }) : preset.host}
                </span>
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

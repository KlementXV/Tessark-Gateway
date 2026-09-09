"use client"

import { Box, Layers, LifeBuoy, Package } from "lucide-react"
import { useTranslations } from "next-intl"

import { Badge } from "@/components/ui/badge"
import type { ArtifactKind, ArtifactMeta } from "@/lib/registries/harbor"

/**
 * How an artifact is named and drawn, in one place.
 *
 * A registry holds Helm charts next to container images, and telling them apart used to
 * require reading the media type of a layer inside the detail panel. The icon carries that
 * distinction in the list, where the choice of what to open is actually made.
 *
 * LifeBuoy for a chart because Helm's own mark is a ship's wheel — the nearest thing lucide
 * offers, and recognisable next to the layered stack that means an image.
 */
const ICONS = { chart: LifeBuoy, image: Layers, other: Box } as const

export function artifactIcon(kind: ArtifactKind) {
  return ICONS[kind]
}

/**
 * The icon for a whole repository, which is a weaker claim than the one for an artifact.
 *
 * Only a chart repository gets a distinct mark; an image repository keeps the neutral package
 * it has always had, as does one whose kind could not be determined. Repainting every image
 * repository would be a large visual change to say something the reader already assumes,
 * and it would make "we did not look" indistinguishable from "it is an image".
 */
export function repositoryIcon(kind: ArtifactKind | undefined) {
  return kind === "chart" ? LifeBuoy : Package
}

export function ArtifactKindBadge({
  artifact,
}: {
  artifact: Pick<ArtifactMeta, "kind" | "rawType" | "chart">
}) {
  const t = useTranslations("registries.artifactKind")

  if (artifact.kind === "chart") {
    return (
      <Badge variant="outline" className="gap-1 font-normal">
        <LifeBuoy className="size-3" aria-hidden="true" />
        {artifact.chart?.appVersion ? t("chartWithApp", { app: artifact.chart.appVersion }) : t("chart")}
      </Badge>
    )
  }

  // An image gets no badge: it is the overwhelming majority and labelling every row "Image"
  // would say nothing while making the exceptions harder to spot.
  if (artifact.kind === "image") return null

  return (
    <Badge variant="outline" className="gap-1 font-normal">
      <Box className="size-3" aria-hidden="true" />
      {artifact.rawType ?? t("other")}
    </Badge>
  )
}

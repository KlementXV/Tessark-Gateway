import { cache } from "react"

import { getConfig } from "@/lib/config"
import { prisma } from "@/lib/prisma"
import type { InstanceBranding } from "@/lib/settings/branding"
import { isUploadedLogoUrl, uploadedLogoUrl } from "@/lib/settings/logo"
import {
  EMPTY_LOGIN_CONTENT,
  parseLoginFeatures,
  serializeLoginFeatures,
  type LoginContent,
} from "@/lib/settings/login-content"

const SETTINGS_ID = "default"

export type { InstanceBranding }
export type { LoginContent }

// White-labels a fresh instance from first boot, before anyone has ever opened
// /settings/branding — a helm install with config.defaultBrandName=Acme shows "Acme"
// immediately, with no row in the database yet.
function defaultBranding(): InstanceBranding {
  const config = getConfig()
  return {
    brandName: config.defaultBrandName,
    brandTagline: config.defaultBrandTagline,
    logoUrl: config.defaultLogoUrl ?? null,
    primaryColor: config.defaultPrimaryColor ?? null,
  }
}

function toBranding(settings: {
  brandName: string
  brandTagline: string
  logoUrl: string | null
  primaryColor: string | null
}): InstanceBranding {
  return {
    brandName: settings.brandName,
    brandTagline: settings.brandTagline,
    logoUrl: settings.logoUrl,
    primaryColor: settings.primaryColor,
  }
}

/**
 * Branding is read several times while rendering a single page (metadata, the root
 * layout's theme vars, the sidebar). `cache` collapses those into one query per
 * request; it is request-scoped, so an update is still visible on the next render.
 */
export const getInstanceSettings = cache(async (): Promise<InstanceBranding> => {
  const settings = await prisma.instanceSettings.findUnique({ where: { id: SETTINGS_ID } })
  return settings ? toBranding(settings) : defaultBranding()
})

export async function updateInstanceSettings(data: InstanceBranding): Promise<InstanceBranding> {
  // Pointing `logoUrl` somewhere else (an external URL, or nothing) orphans any
  // uploaded blob — drop it in the same write so the two can't drift apart.
  const clearUpload = isUploadedLogoUrl(data.logoUrl)
    ? {}
    : { logoData: null, logoMimeType: null }

  const settings = await prisma.instanceSettings.upsert({
    where: { id: SETTINGS_ID },
    create: { id: SETTINGS_ID, ...data },
    update: { ...data, ...clearUpload },
  })
  return toBranding(settings)
}

/** Stores an uploaded logo and repoints `logoUrl` at the internal, cache-busted path. */
export async function saveInstanceLogo(data: Uint8Array, mimeType: string): Promise<InstanceBranding> {
  const now = new Date()
  const logo = { logoData: Buffer.from(data), logoMimeType: mimeType, logoUrl: uploadedLogoUrl(now) }

  const settings = await prisma.instanceSettings.upsert({
    where: { id: SETTINGS_ID },
    create: { id: SETTINGS_ID, ...logo },
    update: logo,
  })
  return toBranding(settings)
}

export async function deleteInstanceLogo(): Promise<InstanceBranding> {
  const cleared = { logoData: null, logoMimeType: null, logoUrl: null }
  const settings = await prisma.instanceSettings.upsert({
    where: { id: SETTINGS_ID },
    create: { id: SETTINGS_ID, ...cleared },
    update: cleared,
  })
  return toBranding(settings)
}

/** Raw bytes for the logo route. Separate from `getInstanceSettings` so the blob
 *  never rides along in the RSC payload of every page render. */
export async function getInstanceLogo(): Promise<{ data: Buffer; mimeType: string } | null> {
  const settings = await prisma.instanceSettings.findUnique({
    where: { id: SETTINGS_ID },
    select: { logoData: true, logoMimeType: true, updatedAt: true },
  })
  if (!settings?.logoData || !settings.logoMimeType) return null
  return { data: Buffer.from(settings.logoData), mimeType: settings.logoMimeType }
}

type LoginContentRow = {
  loginDescription: string | null
  loginHeroTitle: string | null
  loginHeroSubtitle: string | null
  loginFootnote: string | null
  loginFeatures: string | null
}

const LOGIN_CONTENT_SELECT = {
  loginDescription: true,
  loginHeroTitle: true,
  loginHeroSubtitle: true,
  loginFootnote: true,
  loginFeatures: true,
} as const

function toLoginContent(row: LoginContentRow): LoginContent {
  return {
    description: row.loginDescription,
    heroTitle: row.loginHeroTitle,
    heroSubtitle: row.loginHeroSubtitle,
    footnote: row.loginFootnote,
    features: parseLoginFeatures(row.loginFeatures),
  }
}

/**
 * Login page copy. Read only by /login and the settings form, so it is fetched
 * separately from `getInstanceSettings` rather than riding in the branding payload
 * of every authenticated page.
 */
export const getLoginContent = cache(async (): Promise<LoginContent> => {
  const settings = await prisma.instanceSettings.findUnique({
    where: { id: SETTINGS_ID },
    select: LOGIN_CONTENT_SELECT,
  })
  return settings ? toLoginContent(settings) : EMPTY_LOGIN_CONTENT
})

export async function updateLoginContent(data: LoginContent): Promise<LoginContent> {
  const columns = {
    loginDescription: data.description,
    loginHeroTitle: data.heroTitle,
    loginHeroSubtitle: data.heroSubtitle,
    loginFootnote: data.footnote,
    loginFeatures: serializeLoginFeatures(data.features),
  }

  const settings = await prisma.instanceSettings.upsert({
    where: { id: SETTINGS_ID },
    create: { id: SETTINGS_ID, ...columns },
    update: columns,
    select: LOGIN_CONTENT_SELECT,
  })

  return toLoginContent(settings)
}

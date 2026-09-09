// Operator-supplied copy for the login page — no DB, no React, so both the server
// (the login page, the API route) and the client (the settings form preview) can
// import it. Every field is nullable: null means "fall back to the translated
// default", which is what a fresh instance and every untouched field look like.

export interface LoginFeature {
  title: string
  description: string
}

export interface LoginContent {
  /** Subtitle under the sign-in heading. */
  description: string | null
  /** Headline of the desktop showcase panel. */
  heroTitle: string | null
  heroSubtitle: string | null
  /** Small line at the bottom of the showcase panel. */
  footnote: string | null
  /**
   * Showcase bullets. `null` keeps the built-in, translated list; an empty array is a
   * deliberate "show none" and is preserved as such.
   */
  features: LoginFeature[] | null
}

export const EMPTY_LOGIN_CONTENT: LoginContent = {
  description: null,
  heroTitle: null,
  heroSubtitle: null,
  footnote: null,
  features: null,
}

export const MAX_LOGIN_FEATURES = 4
export const LOGIN_FEATURE_TITLE_MAX = 60
export const LOGIN_FEATURE_DESCRIPTION_MAX = 200
export const LOGIN_TEXT_MAX = 300

/**
 * Reads the `loginFeatures` column. Anything that isn't a well-formed array of
 * `{ title, description }` degrades to null (= built-in list) rather than throwing:
 * a hand-edited row must never take the login page down.
 */
export function parseLoginFeatures(raw: string | null): LoginFeature[] | null {
  if (raw === null) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null

  const features: LoginFeature[] = []
  for (const entry of parsed.slice(0, MAX_LOGIN_FEATURES)) {
    if (typeof entry !== "object" || entry === null) continue
    const { title, description } = entry as Record<string, unknown>
    if (typeof title !== "string" || typeof description !== "string") continue
    if (!title.trim()) continue
    features.push({
      title: title.slice(0, LOGIN_FEATURE_TITLE_MAX),
      description: description.slice(0, LOGIN_FEATURE_DESCRIPTION_MAX),
    })
  }
  return features
}

export function serializeLoginFeatures(features: LoginFeature[] | null): string | null {
  return features === null ? null : JSON.stringify(features)
}

/** True when nothing is overridden — used by the settings form to show "using defaults". */
export function isDefaultLoginContent(content: LoginContent): boolean {
  return (
    content.description === null &&
    content.heroTitle === null &&
    content.heroSubtitle === null &&
    content.footnote === null &&
    content.features === null
  )
}

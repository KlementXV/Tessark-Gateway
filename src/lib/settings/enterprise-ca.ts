// The instance-wide private certificate authority (InstanceSettings.enterpriseCaPem).
//
// One bundle for the whole Gateway rather than one per connection: a company CA signs the
// whole estate, and a copy pasted onto every registry and every source is a copy that will
// still be there after the authority is rotated. It is *added* to the public roots, never
// substituted for them, and it never turns verification off — a host whose chain does not
// resolve fails, it is not trusted blindly.
//
// Read on every outgoing request, so it is memoised in-process for a few seconds. The cost of
// that window is bounded and stated: after an edit, connections opened by *other* pods (and by
// this one, for at most CACHE_TTL_MS) keep the previous bundle. Writes through this module
// clear the local entry immediately, so the pod that made the change is never the one showing
// stale trust.
import { getConfig } from "@/lib/config"
import { normalizeCaPem } from "@/lib/ca"
import { prisma } from "@/lib/prisma"

const SETTINGS_ID = "default"
const CACHE_TTL_MS = 10_000

export interface EnterpriseCa {
  pem: string | null
  /** Whether the skopeo copy Jobs get it by default — see InstanceSettings.enterpriseCaJobDefault. */
  jobDefault: boolean
}

const DEFAULT_JOB_DEFAULT = true

let cached: { value: EnterpriseCa; readAt: number } | null = null

/**
 * The bundle to trust on top of the public roots, and whether copy Jobs get it by default.
 *
 * `pem` is null whenever the beta is off, whatever is stored: turning the flag back off must
 * stop new runs from depending on a CA without erasing what an admin configured.
 */
export async function getEnterpriseCa(): Promise<EnterpriseCa> {
  if (!getConfig().customCaBetaEnabled) return { pem: null, jobDefault: DEFAULT_JOB_DEFAULT }
  if (cached && Date.now() - cached.readAt < CACHE_TTL_MS) return cached.value

  const settings = await prisma.instanceSettings.findUnique({
    where: { id: SETTINGS_ID },
    select: { enterpriseCaPem: true, enterpriseCaJobDefault: true },
  })
  cached = {
    value: {
      pem: settings?.enterpriseCaPem ?? null,
      jobDefault: settings?.enterpriseCaJobDefault ?? DEFAULT_JOB_DEFAULT,
    },
    readAt: Date.now(),
  }
  return cached.value
}

/** Just the bundle — for the TLS layer, which has no notion of Jobs. */
export async function getEnterpriseCaPem(): Promise<string | null> {
  return (await getEnterpriseCa()).pem
}

/**
 * What a copy Job should use, given what the caller asked for.
 *
 * `undefined` means the caller said nothing — a REST or MCP client, or a scheduled mirror,
 * which has no switch of its own — and takes the instance default.
 */
export async function resolveJobCaPem(requested?: boolean): Promise<string | null> {
  const { pem, jobDefault } = await getEnterpriseCa()
  return (requested ?? jobDefault) ? pem : null
}

/** Stored state regardless of the flag — for the settings screen, which must still show it. */
export async function readEnterpriseCa(): Promise<EnterpriseCa> {
  const settings = await prisma.instanceSettings.findUnique({
    where: { id: SETTINGS_ID },
    select: { enterpriseCaPem: true, enterpriseCaJobDefault: true },
  })
  return {
    pem: settings?.enterpriseCaPem ?? null,
    jobDefault: settings?.enterpriseCaJobDefault ?? DEFAULT_JOB_DEFAULT,
  }
}

/**
 * Writes the parts the caller named. `pem: null` removes the bundle; a field left undefined is
 * untouched, so changing the Job default does not require re-pasting the certificate.
 */
async function updateEnterpriseCaInner(input: {
  pem?: string | null
  jobDefault?: boolean
}): Promise<EnterpriseCa> {
  const data = {
    ...(input.pem !== undefined ? { enterpriseCaPem: input.pem === null ? null : normalizeCaPem(input.pem) } : {}),
    ...(input.jobDefault !== undefined ? { enterpriseCaJobDefault: input.jobDefault } : {}),
  }
  const settings = await prisma.instanceSettings.upsert({
    where: { id: SETTINGS_ID },
    create: { id: SETTINGS_ID, ...data },
    update: data,
    select: { enterpriseCaPem: true, enterpriseCaJobDefault: true },
  })
  cached = null
  return { pem: settings.enterpriseCaPem, jobDefault: settings.enterpriseCaJobDefault }
}

export async function updateEnterpriseCa(input: { pem?: string | null; jobDefault?: boolean }): Promise<EnterpriseCa> {
  // Dynamic import avoids the build transport / CA module cycle at initialization.
  const { withBuildLock, invalidateProjectBuilds } = await import("@/lib/builds/service")
  return withBuildLock(async () => {
    if (input.pem !== undefined && input.pem !== null) normalizeCaPem(input.pem)
    await invalidateProjectBuilds(undefined, "Enterprise CA changed; reapply this build")
    return updateEnterpriseCaInner(input)
  })
}

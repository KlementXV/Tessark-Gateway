import * as tls from "node:tls"
import { Agent } from "undici"
import { getConfig } from "@/lib/config"
import { getEnterpriseCaPem } from "@/lib/settings/enterprise-ca"
import type { RegistryConnection } from "./types"

const insecureAgent = new Agent({ connect: { rejectUnauthorized: false } })

// One agent per distinct enterprise bundle, keyed by the PEM itself: a rotation produces a new
// key rather than reusing a pool that still trusts the old authority. Only a handful of entries
// can ever exist (the bundle changes when an admin edits it), but the map is bounded anyway so
// that repeated rotations cannot leak connection pools.
const caAgents = new Map<string, Agent>()
const MAX_CA_AGENTS = 8

// Node >=22.15 exposes the effective store, including system/extra certificates.
// Older supported runtimes still retain their bundled public roots.
export function defaultCaCertificates(): readonly string[] {
  const runtime = tls as typeof tls & { getCACertificates?: (type: string) => string[] }
  return runtime.getCACertificates?.("default") ?? tls.rootCertificates
}

function caAgent(pem: string): Agent {
  let agent = caAgents.get(pem)
  if (agent) return agent
  if (caAgents.size >= MAX_CA_AGENTS) {
    // Oldest first (Map preserves insertion order): closing it frees its sockets.
    const oldest = caAgents.keys().next()
    if (!oldest.done) {
      void caAgents.get(oldest.value)?.close()
      caAgents.delete(oldest.value)
    }
  }
  // An explicit TLS ca replaces the defaults, so retain the effective trust store too.
  agent = new Agent({ connect: { ca: [...defaultCaCertificates(), pem], rejectUnauthorized: true } })
  caAgents.set(pem, agent)
  return agent
}

/**
 * The dispatcher this connection needs, or undefined for undici's default.
 *
 * Two independent settings, and the per-registry one wins: a Harbor explicitly marked
 * "insecure TLS" was marked so on purpose, and the instance CA has nothing to add to a
 * connection that verifies nothing. Everything else picks up the enterprise bundle if one is
 * configured — Harbor API calls, probes, token endpoints on a third-party domain.
 *
 * Exported for the one probe that cannot go through registryFetch: sources/check.ts hits `/v2/`
 * with a bare fetch on purpose, to see the raw 401 challenge.
 */
export async function dispatcherFor(
  conn: Pick<RegistryConnection, "insecureTLS">,
): Promise<Agent | undefined> {
  if (conn.insecureTLS) return insecureAgent
  const pem = await getEnterpriseCaPem()
  return pem ? caAgent(pem) : undefined
}

// Docker Registry v2 token challenge (RFC: WWW-Authenticate: Bearer realm="...",service="...",scope="...")
interface BearerChallenge {
  realm: string
  service?: string
  scope?: string
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")
}

// Only applied when *we* picked the timeout (no caller-supplied signal, e.g. sources/check.ts
// which reports its own timeout in its own words) — turns an opaque DOMException into a
// message an admin can act on, instead of a 500 six screens later.
async function withReadableTimeout<T>(hostname: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (err) {
    if (isAbortError(err)) {
      throw new Error(`${hostname} did not respond within ${getConfig().harborHttpTimeoutMs / 1000}s`)
    }
    throw err
  }
}

function parseBearerChallenge(header: string): BearerChallenge | null {
  const match = /^Bearer\s+(.+)$/i.exec(header)
  if (!match) return null

  const params: Record<string, string> = {}
  const re = /(\w+)="([^"]*)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(match[1])) !== null) {
    params[m[1]] = m[2]
  }
  if (!params.realm) return null
  return { realm: params.realm, service: params.service, scope: params.scope }
}

async function fetchBearerToken(
  challenge: BearerChallenge,
  conn: RegistryConnection,
  signal: AbortSignal,
): Promise<string> {
  const url = new URL(challenge.realm)
  if (challenge.service) url.searchParams.set("service", challenge.service)
  if (challenge.scope) url.searchParams.set("scope", challenge.scope)

  const headers: Record<string, string> = {}
  if (conn.authType === "basic" && conn.username && conn.secret) {
    headers.Authorization = `Basic ${Buffer.from(`${conn.username}:${conn.secret}`).toString("base64")}`
  } else if (conn.authType === "token" && conn.secret) {
    headers.Authorization = `Bearer ${conn.secret}`
  }

  const dispatcher = await dispatcherFor(conn)
  const res = await fetch(url, {
    headers,
    signal,
    ...(dispatcher ? ({ dispatcher } as Record<string, unknown>) : {}),
  })
  if (!res.ok) {
    throw new Error(`Token endpoint ${url.hostname} responded ${res.status}`)
  }
  const body = (await res.json()) as { token?: string; access_token?: string }
  const token = body.token ?? body.access_token
  if (!token) throw new Error("Token endpoint did not return a token")
  return token
}

export interface RegistryFetchInit extends RequestInit {
  headers?: Record<string, string>
}

// GET/DELETE against `${conn.baseUrl}${path}` — handles Basic auth directly, and the
// Bearer token-exchange dance (401 + WWW-Authenticate challenge -> fetch token -> retry)
// used by Docker Hub / GHCR / Harbor-in-token-mode.
export async function registryFetch(
  conn: RegistryConnection,
  path: string,
  init: RegistryFetchInit = {}
): Promise<Response> {
  const url = new URL(path, conn.baseUrl)
  const dispatcher = await dispatcherFor(conn)
  const baseHeaders = { ...init.headers }
  // Callers with their own timeout policy (e.g. sources/check.ts) pass a signal of their own
  // and get its raw abort error back, since they already report it in their own words;
  // everything else — the ~20 Harbor call sites in registries/harbor.ts — falls back to the
  // configured default and gets a readable message on timeout.
  const hasOwnSignal = init.signal != null
  const signal = init.signal ?? AbortSignal.timeout(getConfig().harborHttpTimeoutMs)

  if (conn.authType === "basic" && conn.username && conn.secret) {
    baseHeaders.Authorization = `Basic ${Buffer.from(`${conn.username}:${conn.secret}`).toString("base64")}`
  } else if (conn.authType === "token" && conn.secret && !baseHeaders.Authorization) {
    baseHeaders.Authorization = `Bearer ${conn.secret}`
  }

  const doFetch = (headers: Record<string, string>) =>
    fetch(url, {
      ...init,
      headers,
      signal,
      ...(dispatcher ? ({ dispatcher } as Record<string, unknown>) : {}),
    })

  const first = hasOwnSignal
    ? await doFetch(baseHeaders)
    : await withReadableTimeout(url.hostname, () => doFetch(baseHeaders))

  if (first.status !== 401) return first

  const challengeHeader = first.headers.get("www-authenticate")
  if (!challengeHeader) return first
  const challenge = parseBearerChallenge(challengeHeader)
  if (!challenge) return first

  // Release the response we will not return, and keep the original deadline throughout
  // authentication (including reading the token body). Caller cancellation must reach it too.
  await first.body?.cancel()
  const token = hasOwnSignal
    ? await fetchBearerToken(challenge, conn, signal)
    : await withReadableTimeout(url.hostname, () => fetchBearerToken(challenge, conn, signal))
  const retryHeaders = { ...baseHeaders, Authorization: `Bearer ${token}` }

  return hasOwnSignal
    ? doFetch(retryHeaders)
    : withReadableTimeout(url.hostname, () => doFetch(retryHeaders))
}

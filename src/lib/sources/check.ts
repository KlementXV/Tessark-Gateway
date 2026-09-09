import { getConfig } from "@/lib/config"
import { dispatcherFor, registryFetch } from "@/lib/registries/http"
import type { RegistryConnection } from "@/lib/registries/types"

// Server-only: reaches undici via @/lib/registries/http. Client components import
// SourceCheckResult from ./check-result instead.
import type { SourceCheckResult } from "./check-result"

export type { SourceCheckResult }

// A source is stored as a bare image-reference host, which is not always where the v2 API
// lives. "docker.io" is the name you write in an image ref; the API answers on
// registry-1.docker.io. Everything else has so far been the same host.
export function registryApiBase(host: string): string {
  const bare = host.trim().toLowerCase()
  if (bare === "docker.io" || bare === "index.docker.io") return "https://registry-1.docker.io"
  return `https://${bare}`
}

export interface SourceCheckInput {
  host: string
  authType: "none" | "basic" | "token"
  username?: string | null
  secret?: string | null
  /** Concrete repository to pull a scoped token for — the only part that really tests auth. */
  probeRepo?: string | null
}

function connectionFor(input: SourceCheckInput): RegistryConnection {
  return {
    id: "",
    name: input.host,
    baseUrl: registryApiBase(input.host),
    authType: input.authType,
    username: input.username ?? null,
    secret: input.secret ?? null,
    insecureTLS: false,
  }
}

function message(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      return `No answer within ${getConfig().registryCheckTimeoutMs / 1000}s`
    }
    return err.message
  }
  return "Unreachable"
}

// registryFetch throws out of the token exchange rather than returning the upstream response,
// so a rejected credential arrives here as an Error, not as a 401 on the call we made. Telling
// the two apart is the difference between "your password is wrong" and "this box has no
// egress" — the whole point of the probe.
function isCredentialRejection(err: unknown): boolean {
  return err instanceof Error && /Token endpoint .* responded (401|403)/.test(err.message)
}

function encodeRepoPath(repo: string): string {
  return repo.split("/").map(encodeURIComponent).join("/")
}

// Two probes, reported separately because they fail for different reasons and mean different
// things to the admin:
//
//   /v2/                         — is anything answering, and does it speak the registry API
//   /v2/<repo>/tags/list         — do these credentials actually get a token for a real repo
//
// The second is the one worth trusting. A bare /v2/ succeeds anonymously on most public
// registries no matter what credentials are supplied, so on its own it proves nothing about
// auth. It is skipped when no concrete repository is available to probe.
export async function checkSource(input: SourceCheckInput): Promise<SourceCheckResult> {
  const startedAt = Date.now()
  const conn = connectionFor(input)
  const base = conn.baseUrl

  let reachable = false
  let status: number | undefined
  let error: string | undefined

  try {
    // Deliberately a bare fetch, not registryFetch: the token dance needs a scope to succeed,
    // and quay.io / ghcr.io reject the unscoped request outright. A 401 carrying a
    // WWW-Authenticate challenge *is* the proof that a registry v2 API is listening, so this
    // probe must see the raw response instead of trying to satisfy the challenge.
    // Bare, but not bare of the instance's trust: without the dispatcher a host signed by the
    // enterprise CA fails right here, and the scoped probe below — the one that actually proves
    // anything — never runs.
    const dispatcher = await dispatcherFor(conn)
    const res = await fetch(new URL("/v2/", base), {
      signal: AbortSignal.timeout(getConfig().registryCheckTimeoutMs),
      ...(dispatcher ? ({ dispatcher } as Record<string, unknown>) : {}),
    })
    reachable = true
    status = res.status
    if (!res.ok && res.status !== 401 && res.status !== 403) {
      error = `${base} answered HTTP ${res.status} — not a registry v2 API?`
    }
  } catch (err) {
    return {
      base,
      reachable: false,
      status: undefined,
      authenticated: false,
      probe: null,
      error: `Nothing answered at ${base} (${message(err)}).`,
      durationMs: Date.now() - startedAt,
    }
  }

  const repo = input.probeRepo?.trim().toLowerCase()
  if (!repo || repo.includes("*")) {
    return {
      base,
      reachable,
      status,
      // Unproven, not proven-good: a 200 on /v2/ from an anonymous-friendly registry says
      // nothing about the credentials. Only the scoped probe can set this.
      authenticated: false,
      probe: null,
      error,
      durationMs: Date.now() - startedAt,
    }
  }

  try {
    const res = await registryFetch(conn, `/v2/${encodeRepoPath(repo)}/tags/list`, {
      signal: AbortSignal.timeout(getConfig().registryCheckTimeoutMs),
    })
    if (res.ok) {
      const body = (await res.json().catch(() => null)) as { tags?: string[] | null } | null
      return {
        base,
        reachable,
        status,
        authenticated: true,
        probe: { repo, ok: true, tagCount: body?.tags?.length ?? 0 },
        error,
        durationMs: Date.now() - startedAt,
      }
    }

    return {
      base,
      reachable,
      status,
      authenticated: false,
      probe: {
        repo,
        ok: false,
        error:
          res.status === 401 || res.status === 403
            ? input.authType === "none"
              ? `${repo} is not readable anonymously (HTTP ${res.status}) — this source needs credentials.`
              : `The credentials were rejected for ${repo} (HTTP ${res.status}).`
            : res.status === 404
              ? `${repo} does not exist on this registry (HTTP 404).`
              : `Reading ${repo} failed (HTTP ${res.status}).`,
      },
      error,
      durationMs: Date.now() - startedAt,
    }
  } catch (err) {
    return {
      base,
      reachable,
      status,
      authenticated: false,
      probe: {
        repo,
        ok: false,
        error: isCredentialRejection(err)
          ? input.authType === "none"
            ? `${repo} needs credentials — the registry refused to issue an anonymous token.`
            : `The credentials were rejected — the registry refused to issue a token for ${repo}.`
          : message(err),
      },
      error,
      durationMs: Date.now() - startedAt,
    }
  }
}

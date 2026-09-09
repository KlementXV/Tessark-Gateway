import { getHarborVersion, harborPing } from "./harbor"
import { ping } from "./v2-client"
import type { RegistryConnection } from "./types"
import type { RegistryHealth } from "./health"

// Server-only: reaches undici via ./harbor -> ./http. Client components import the shape
// and isUsable() from ./health instead.
export type { RegistryHealth }

// The single probe behind the health badges, the "Test connection" button and the
// create/update guard. Harbor identity and credential validity are checked separately
// because they fail for different reasons and need different error messages: a Harbor
// with a bad password still pings fine, and a registry:2 with a good password never will.
export async function checkRegistryHealth(conn: RegistryConnection): Promise<RegistryHealth> {
  const [harbor, v2] = await Promise.all([harborPing(conn), ping(conn)])

  // No HTTP response from either probe — nothing is listening on that URL.
  if (!harbor && !v2.ok && v2.status === undefined) {
    return {
      reachable: false,
      harbor: false,
      authenticated: false,
      version: null,
      error: `Nothing answered at ${conn.baseUrl}${v2.error ? ` (${v2.error})` : ""}.`,
    }
  }

  if (!harbor) {
    return {
      reachable: true,
      harbor: false,
      authenticated: false,
      version: null,
      error: "Reachable, but this is not a Harbor registry — /api/v2.0/ping did not answer.",
    }
  }

  // Only Harbor gets this far, so a version read is worth the extra round trip.
  const version = await getHarborVersion(conn)

  return {
    reachable: true,
    harbor: true,
    authenticated: v2.ok,
    version,
    error: v2.ok ? undefined : credentialError(conn, v2.status),
  }
}

function credentialError(conn: RegistryConnection, status?: number): string {
  const detail = status ? ` (HTTP ${status})` : ""
  return conn.authType === "none"
    ? `Harbor is up but requires credentials${detail} — set an auth method for this registry.`
    : `Harbor is up but rejected the credentials${detail} — check the username and password.`
}

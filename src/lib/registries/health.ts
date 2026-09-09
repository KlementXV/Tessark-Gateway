// Client-safe half of the registry checker: the result shape and the predicates over it,
// with no Node-only imports. Client components must import from here, never from
// ./check — that module reaches undici through ./harbor -> ./http and would be pulled
// into the browser bundle.

export interface RegistryHealth {
  // The host answered an HTTP request at all — distinguishes "wrong URL / firewalled"
  // from "wrong software" and "wrong credentials".
  reachable: boolean
  // /api/v2.0/ping answered "Pong": this really is a Harbor, not a bare registry:2.
  harbor: boolean
  // The configured credentials were accepted by the Docker Registry v2 API.
  authenticated: boolean
  version: string | null
  error?: string
}

export function isUsable(health: RegistryHealth): boolean {
  return health.reachable && health.harbor && health.authenticated
}

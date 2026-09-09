/**
 * The Harbor a conformance campaign runs against.
 *
 * Never a default, never a guess: an unconfigured run does nothing and records nothing, because a
 * campaign that silently pointed somewhere unintended would put a signature on evidence nobody
 * asked for. Configure with:
 *
 *   HARBOR_CONFORMANCE_URL=http://localhost:1998 \
 *   HARBOR_CONFORMANCE_USERNAME=admin HARBOR_CONFORMANCE_PASSWORD=… npm run test:harbor
 */
import type { RegistryConnection } from "../../src/lib/registries/types"

export interface ConformanceTarget {
  conn: RegistryConnection
  /** Free-form label recorded with the run, so a result can be traced back to an instance. */
  label: string
}

export function resolveTarget(): ConformanceTarget | null {
  /* eslint-disable no-restricted-syntax -- The conformance harness is not application code: it
     takes its target from the operator's shell, and must never read the app's own registry rows. */
  const baseUrl = process.env.HARBOR_CONFORMANCE_URL
  if (!baseUrl) return null
  const username = process.env.HARBOR_CONFORMANCE_USERNAME ?? null
  const secret = process.env.HARBOR_CONFORMANCE_PASSWORD ?? null
  const insecureTLS = process.env.HARBOR_CONFORMANCE_INSECURE === "true"
  /* eslint-enable no-restricted-syntax */

  return {
    label: baseUrl,
    conn: {
      id: "",
      name: "conformance target",
      baseUrl: baseUrl.replace(/\/+$/, ""),
      authType: username ? "basic" : "none",
      username,
      secret,
      insecureTLS,
    },
  }
}

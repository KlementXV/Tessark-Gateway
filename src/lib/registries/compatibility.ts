import conformance from "../../../docs/harbor-conformance.json"
import specEvidenceFile from "../../../docs/harbor-spec-evidence.json"
import surface from "../../../docs/harbor-surface.json"
import {
  HARBOR_CAPABILITIES,
  minorSpread,
  evaluateCapability,
  parseHarborVersion,
  supportStatus,
  type CapabilityAssessment,
  type ConformanceRun,
  type SpecEvidence,
  type SupportStatus,
} from "./harbor-capabilities"

export { minorSpread }

/**
 * What this Harbor can be asked to do, for one registry, ready for display.
 *
 * The three files imported above are the evidence the campaigns and the spec diff produced. They
 * are *imported* rather than read from disk so the bundler carries them into the standalone
 * image: the pod has no project tree to read at runtime, and a matrix that silently emptied
 * itself in production would be worse than none.
 *
 * The same evaluator answers here, in the generated documentation and in the server guards —
 * that is the point of keeping it pure and free of I/O.
 */

const RUNS = (conformance.runs ?? []) as ConformanceRun[]
const SPEC_EVIDENCE = (specEvidenceFile.comparisons ?? []) as SpecEvidence[]
const DIGESTS = surface.digests as Record<string, string>

export interface RegistryCompatibility {
  /** The version this assessment was computed from — null when it could not be read. */
  version: string | null
  support: SupportStatus
  capabilities: CapabilityAssessment[]
}

export function assessHarborVersion(version: string | null, now: Date = new Date()): RegistryCompatibility {
  const parsed = parseHarborVersion(version)
  return {
    version,
    support: supportStatus(parsed),
    capabilities: HARBOR_CAPABILITIES.map((capability) =>
      evaluateCapability({
        capability,
        version: parsed,
        runs: RUNS,
        specEvidence: SPEC_EVIDENCE,
        surfaceDigests: DIGESTS,
        now,
      }),
    ),
  }
}

/**
 * The capabilities a user would notice losing, worst first.
 *
 * Availability leads, because it is the only class the operator can act on — upgrading the Harbor
 * changes it. An unproven capability is listed after, and never as a defect: the Gateway does not
 * refuse anything for want of a certificate (plan D4).
 */
export function degradedCapabilities(assessment: RegistryCompatibility): CapabilityAssessment[] {
  const rank: Record<string, number> = { unavailable: 0, unknown: 1, available: 2 }
  return assessment.capabilities
    .filter((capability) => capability.availability !== "available" || capability.proof === "broken")
    .sort((a, b) => rank[a.availability] - rank[b.availability])
}

// Resolving a transfer against the policy: is this direction open, and does it need review.
//
// The default is deny. A transfer with no matching enabled rule is refused even though the
// pod could physically carry it — the network is not the constraint here, the policy is (see
// TransferRule in prisma/schema.prisma). That inversion is what makes the same image usable
// by a client who lets everything move internally and by one who reviews every byte that
// leaves the estate.
//
// Matching runs per destination, not per request: one request may open a project the rules
// allow and another they don't, and the refusal has to name which.
import type { TransferRule } from "@/generated/prisma/client"
import { prisma } from "@/lib/prisma"
import { isRepoAllowed, parseAllowedRepos } from "@/lib/sources/repo"

// The coordinates a rule is matched against — one source, one destination, already resolved.
export interface RuleQuery {
  sourceUpstreamId: string | null
  sourceRegistryId: string | null
  /** Repository path within the source, normalised ("library/nginx"). */
  repo: string
  /** Null for a Gateway-managed project, which no delivery registry hosts. */
  destRegistryId: string | null
  /** The project name on the destination Harbor. */
  destProjectName: string
}

/**
 * The rule that governs one destination, or null when the policy has nothing to say about it.
 *
 * When several rules match, the most specific wins: a rule naming both ends beats one naming
 * a single end, which beats a rule that names neither. That ordering is what lets an operator
 * open a broad direction and then tighten one corner of it — the narrow rule is the one whose
 * `requiresApproval` applies, which would be pointless if a wildcard rule could override it.
 */
export async function findMatchingRule(query: RuleQuery): Promise<TransferRule | null> {
  const candidates = await prisma.transferRule.findMany({
    where: {
      enabled: true,
      // Null on either side of a rule means "any", so a candidate either names this exact
      // coordinate or leaves it open. Filtering here keeps the glob work off rows that could
      // never match anyway.
      AND: [
        {
          OR: [
            { sourceUpstreamId: null, sourceRegistryId: null },
            ...(query.sourceUpstreamId ? [{ sourceUpstreamId: query.sourceUpstreamId }] : []),
            ...(query.sourceRegistryId ? [{ sourceRegistryId: query.sourceRegistryId }] : []),
          ],
        },
        { OR: [{ destRegistryId: null }, { destRegistryId: query.destRegistryId }] },
      ],
    },
  })

  const matching = candidates.filter(
    (rule) =>
      isRepoAllowed(query.repo, parseAllowedRepos(rule.repoFilter)) &&
      isRepoAllowed(query.destProjectName, parseAllowedRepos(rule.projectFilter)),
  )
  if (matching.length === 0) return null

  return matching.sort((a, b) => specificity(b) - specificity(a))[0]
}

// How many of the two ends a rule pins down. Ties are left to the database's own order, which
// is stable enough: two rules of equal specificity that both match describe the same
// permission, and only their `requiresApproval` could differ — a genuine ambiguity the
// operator has to resolve, not one to invent a tiebreaker for.
function specificity(rule: TransferRule): number {
  return (
    (rule.sourceUpstreamId || rule.sourceRegistryId ? 1 : 0) + (rule.destRegistryId ? 1 : 0)
  )
}

// Reading and writing transfer rules.
//
// Kept apart from rules.ts, which only answers "does the policy allow this": that question is
// asked on every request and must stay cheap, while this module is the administration surface
// and is allowed to join in the names the UI needs.
import { prisma } from "@/lib/prisma"
import { parseAllowedRepos } from "@/lib/sources/repo"
import type { TransferRuleInput } from "./rule-schema"
import { parseSkopeoOverrides, type SkopeoOverrides } from "./skopeo-overrides"

export interface PublicTransferRule {
  id: string
  name: string
  description: string | null
  // Both ends are rendered by name, not by id: a rule reads as a sentence in the UI ("Docker
  // Hub → International"), and null on a side is the wildcard.
  sourceUpstreamId: string | null
  sourceUpstreamName: string | null
  sourceRegistryId: string | null
  sourceRegistryName: string | null
  destRegistryId: string | null
  destRegistryName: string | null
  projectFilter: string[]
  repoFilter: string[]
  transport: string
  skopeoOverrides: SkopeoOverrides
  requiresApproval: boolean
  enabled: boolean
  createdAt: string
  updatedAt: string
}

const withNames = {
  sourceUpstream: { select: { name: true } },
  sourceRegistry: { select: { name: true } },
  destRegistry: { select: { name: true } },
} as const

type RuleWithNames = Awaited<ReturnType<typeof loadRules>>[number]

function loadRules() {
  return prisma.transferRule.findMany({ include: withNames, orderBy: { name: "asc" } })
}

export function toPublicTransferRule(rule: RuleWithNames): PublicTransferRule {
  return {
    id: rule.id,
    name: rule.name,
    description: rule.description,
    sourceUpstreamId: rule.sourceUpstreamId,
    sourceUpstreamName: rule.sourceUpstream?.name ?? null,
    sourceRegistryId: rule.sourceRegistryId,
    sourceRegistryName: rule.sourceRegistry?.name ?? null,
    destRegistryId: rule.destRegistryId,
    destRegistryName: rule.destRegistry?.name ?? null,
    projectFilter: parseAllowedRepos(rule.projectFilter),
    repoFilter: parseAllowedRepos(rule.repoFilter),
    transport: rule.transport,
    skopeoOverrides: parseSkopeoOverrides(rule.skopeoOverrides),
    requiresApproval: rule.requiresApproval,
    enabled: rule.enabled,
    createdAt: rule.createdAt.toISOString(),
    updatedAt: rule.updatedAt.toISOString(),
  }
}

export async function listTransferRules(): Promise<PublicTransferRule[]> {
  return (await loadRules()).map(toPublicTransferRule)
}

// The globs are arrays in the API and JSON text in the column — the same shape conversion
// UpstreamSource.allowedRepos goes through.
function toStorage(input: Partial<TransferRuleInput>) {
  const { projectFilter, repoFilter, skopeoOverrides, ...rest } = input
  return {
    ...rest,
    ...(projectFilter ? { projectFilter: JSON.stringify(projectFilter) } : {}),
    ...(repoFilter ? { repoFilter: JSON.stringify(repoFilter) } : {}),
    ...(skopeoOverrides ? { skopeoOverrides: JSON.stringify(skopeoOverrides) } : {}),
  }
}

export async function createTransferRule(input: TransferRuleInput): Promise<PublicTransferRule> {
  const rule = await prisma.transferRule.create({
    data: toStorage(input) as Parameters<typeof prisma.transferRule.create>[0]["data"],
    include: withNames,
  })
  return toPublicTransferRule(rule)
}

export async function updateTransferRule(
  id: string,
  input: Partial<TransferRuleInput>,
): Promise<PublicTransferRule | null> {
  const existing = await prisma.transferRule.findUnique({ where: { id }, select: { id: true } })
  if (!existing) return null

  const rule = await prisma.transferRule.update({
    where: { id },
    data: toStorage(input),
    include: withNames,
  })
  return toPublicTransferRule(rule)
}

export async function deleteTransferRule(id: string): Promise<boolean> {
  // Deleting a rule narrows what may move; it never touches a transfer that already ran, and
  // nothing references it after the fact — the decision it governed is recorded on the
  // request itself.
  const deleted = await prisma.transferRule.deleteMany({ where: { id } })
  return deleted.count > 0
}

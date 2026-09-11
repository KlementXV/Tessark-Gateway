import type { Session } from "next-auth"
import { prisma } from "@/lib/prisma"
import { decryptSecret } from "@/lib/crypto"
import { registryApiBase } from "@/lib/sources/check"
import { resolveConnection } from "@/lib/registries/resolve"
import type { RegistryConnection } from "@/lib/registries/types"
import type { TransferRequestCreateInput } from "./schema"
import { TransferValidationError, validateTransferRequest } from "./validate"
import { findArtifactTags, findHarborArtifactTags } from "./artifact-tags"

// Internal only: this digest is never accepted from the public request body.
export type ExpandedTransferInput = TransferRequestCreateInput & { pinnedDigest?: string }

/** Authorize the selected artifact and destinations, then include only its digest aliases.
 * Carry the trusted digest internally so moving tags cannot switch the copied artifact. */
export async function expandAllTags(
  input: TransferRequestCreateInput,
  session: Session,
): Promise<ExpandedTransferInput[]> {
  if (!input.allTags) return [input]
  const validated = await validateTransferRequest(input, session)
  let conn: RegistryConnection
  if (validated.sourceId) {
    const source = await prisma.upstreamSource.findUniqueOrThrow({ where: { id: validated.sourceId } })
    conn = {
      id: source.id, name: source.name, baseUrl: registryApiBase(source.host),
      authType: source.authType as RegistryConnection["authType"], username: source.username,
      secret: source.encryptedSecret ? decryptSecret(source.encryptedSecret) : null, insecureTLS: false,
    }
  } else {
    conn = resolveConnection(await prisma.registry.findUniqueOrThrow({ where: { id: validated.sourceRegistryId! } }))
  }
  const repo = validated.sourceProjectName ? `${validated.sourceProjectName}/${validated.repo}` : validated.repo
  try {
    const artifact = validated.sourceProjectName
      ? await findHarborArtifactTags(conn, validated.sourceProjectName, validated.repo, validated.sourceDigest!, input.tag)
      : await findArtifactTags(conn, repo, input.tag)
    return artifact.tags.map(tag => ({ ...input, repo: validated.repo, tag, allTags: false, pinnedDigest: artifact.digest }))
  } catch (error) {
    throw new TransferValidationError(`Could not list tags of artifact ${repo}:${input.tag}: ${error instanceof Error ? error.message : "registry unavailable"}`, 502)
  }
}

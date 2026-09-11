import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"

import { Role } from "@/generated/prisma/client"
import { hasRole } from "@/lib/auth/guard"
import { runTool, type ToolContext } from "@/lib/mcp/tool-runner"
import { prisma } from "@/lib/prisma"
import { getEnterpriseCa } from "@/lib/settings/enterprise-ca"
import { TransferLaunchError, launchTransferRequest } from "@/lib/transfers/launch"
import { expandAllTags, type ExpandedTransferInput } from "@/lib/transfers/all-tags"
import { TransferValidationError } from "@/lib/transfers/validate"
import { transferRequestCreateInputSchema, transferRequestCreateObject } from "@/lib/transfers/schema"
import { validateTransferRequest } from "@/lib/transfers/validate"

// Mirrors POST /api/transfers: validate against the source's allowlist and the caller's reach
// into each destination project, write the request, then launch it immediately for an
// ADMIN+ caller (same reviewer-exists rule as the REST route) or leave it PENDING for
// someone else to approve.
export function registerCreateTransferRequestTool(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "create_transfer",
    {
      title: "Create transfer",
      description:
        "Transfer an image or OCI Helm chart from an approved source into one or more destinations. " +
        "For charts, supply the repository without oci:// and an OCI version tag (replace + with _), including when allTags is enabled. " +
        "Set allTags=true to transfer the requested artifact and its tags sharing the same digest (up to 500), grouped with per-tag outcomes. " +
        "Launches immediately if the caller's Role is ADMIN+; otherwise it waits in the review queue.",
      inputSchema: transferRequestCreateObject.shape,
    },
    async (input) =>
      runTool(
        "create_transfer",
        ctx,
        async () => {
          const parsed = transferRequestCreateInputSchema.parse(input)
          const entries = await expandAllTags(parsed, ctx.session)
          const batchId = parsed.allTags && entries.length > 1 ? crypto.randomUUID() : null
          async function createOne(entry: ExpandedTransferInput) {
            const validated = await validateTransferRequest(entry, ctx.session, { pinnedDigest: entry.pinnedDigest })

            const transferRequest = await prisma.transferRequest.create({
              data: {
                sourceId: validated.sourceId,
                sourceRegistryId: validated.sourceRegistryId,
                sourceProjectName: validated.sourceProjectName,
                sourceRepo: validated.repo,
                sourceTag: validated.tag,
                sourceImage: validated.sourceImage,
                sourceDigest: validated.sourceDigest,
                useCustomCa: entry.useCustomCa ?? (await getEnterpriseCa()).jobDefault,
                batchId,
                requestedByUserId: ctx.session.user.id,
                targets: { create: validated.targets },
              },
              include: { targets: true },
            })

            if (validated.requiresApproval && !hasRole(ctx.session, Role.ADMIN)) return transferRequest

            try {
              return await launchTransferRequest(transferRequest.id, ctx.session.user.id)
            } catch (err) {
              if (err instanceof TransferLaunchError) {
                return { ...transferRequest, launchError: `${err.message} — saved as a pending request; approve it to retry.` }
              }
              throw err
            }
          }
          if (!parsed.allTags) return createOne(entries[0])
          const transfers = []
          const failed: { tag: string; error: string }[] = []
          for (const entry of entries) {
            try { transfers.push(await createOne(entry)) }
            catch (error) {
              if (!(error instanceof TransferValidationError)) throw error
              failed.push({ tag: entry.tag, error: error.message })
            }
          }
          return { batchId, transfers, failed }
        },
        (data) => (data as { id?: string } | null)?.id,
      ),
  )
}

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"

import { Role } from "@/generated/prisma/client"
import { hasRole } from "@/lib/auth/guard"
import { runTool, type ToolContext } from "@/lib/mcp/tool-runner"
import { prisma } from "@/lib/prisma"
import { getEnterpriseCa } from "@/lib/settings/enterprise-ca"
import { TransferLaunchError, launchTransferRequest } from "@/lib/transfers/launch"
import { transferRequestCreateObject } from "@/lib/transfers/schema"
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
        "Request an image be mirrored from an approved upstream source into one or more projects. " +
        "Launches immediately if the caller's Role is ADMIN+; otherwise it waits in the review queue.",
      inputSchema: transferRequestCreateObject.shape,
    },
    async (input) =>
      runTool(
        "create_transfer",
        ctx,
        async () => {
          const validated = await validateTransferRequest(input, ctx.session)

          const transferRequest = await prisma.transferRequest.create({
            data: {
              sourceId: validated.sourceId,
              sourceRegistryId: validated.sourceRegistryId,
              sourceProjectName: validated.sourceProjectName,
              sourceRepo: validated.repo,
              sourceTag: validated.tag,
              sourceImage: validated.sourceImage,
              sourceDigest: validated.sourceDigest,
              useCustomCa: input.useCustomCa ?? (await getEnterpriseCa()).jobDefault,
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
        },
        (data) => (data as { id?: string } | null)?.id,
      ),
  )
}

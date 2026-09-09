import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"

import { Role } from "@/generated/prisma/client"
import { AuthError, hasRole } from "@/lib/auth/guard"
import { prisma } from "@/lib/prisma"
import { runTool, type ToolContext } from "@/lib/mcp/tool-runner"

// A plain read of the current DB state — deliberately not POST /api/transfers/[id]/sync, which
// actively polls Kubernetes and Harbor and writes back what it finds. Visible to the request's
// own requester or to ADMIN+, the same pair of parties who can act on it (approve/reject/sync
// are already ADMIN-only; the requester is who has to know if it worked).
export function registerGetTransferStatusTool(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "get_transfer_status",
    {
      title: "Get transfer status",
      description: "Get the current status of one image transfer (mirroring) request, per destination.",
      inputSchema: { transferRequestId: z.string().min(1) },
    },
    async ({ transferRequestId }) =>
      runTool("get_transfer_status", ctx, async () => {
        const transferRequest = await prisma.transferRequest.findUnique({
          where: { id: transferRequestId },
          include: {
            source: { select: { name: true } },
            targets: {
              include: {
                project: { select: { id: true, name: true } },
                destRegistry: { select: { id: true, name: true } },
              },
            },
          },
        })
        if (!transferRequest) throw new AuthError("Not found", 404)
        const isOwner = transferRequest.requestedByUserId === ctx.session.user.id
        if (!isOwner && !hasRole(ctx.session, Role.ADMIN)) throw new AuthError("Not authorized", 403)
        return transferRequest
      }),
  )
}

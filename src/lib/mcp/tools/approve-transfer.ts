import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"

import { Role } from "@/generated/prisma/client"
import { AuthError, requireRole } from "@/lib/auth/guard"
import { runTool, type ToolContext } from "@/lib/mcp/tool-runner"
import { prisma } from "@/lib/prisma"
import { launchTransferRequest } from "@/lib/transfers/launch"

// Mirrors POST /api/transfers/[id]/approve: ADMIN+ only, and only while the request is still
// PENDING — the same launch path an admin's own direct pull takes.
export function registerApproveTransferRequestTool(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "approve_transfer",
    {
      title: "Approve pull request",
      description: "Approve a pending image pull (mirroring) request and launch its mirror jobs. Requires the ADMIN role.",
      inputSchema: { transferRequestId: z.string().min(1) },
    },
    async ({ transferRequestId }) =>
      runTool(
        "approve_transfer",
        ctx,
        async () => {
          requireRole(ctx.session, Role.ADMIN)

          const transferRequest = await prisma.transferRequest.findUnique({
            where: { id: transferRequestId },
            select: { status: true },
          })
          if (!transferRequest) throw new AuthError("Not found", 404)
          if (transferRequest.status !== "PENDING") throw new AuthError("Transfer request is not pending approval", 400)

          return launchTransferRequest(transferRequestId, ctx.session.user.id)
        },
        () => transferRequestId,
      ),
  )
}

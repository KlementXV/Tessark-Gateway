import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"

import { Role } from "@/generated/prisma/client"
import { requireRole } from "@/lib/auth/guard"
import { listRegistriesWithHealth } from "@/lib/registries/service"
import { runTool, type ToolContext } from "@/lib/mcp/tool-runner"

// Same gate as GET /api/registries: ADMIN+ only — the registry-wide catalog isn't a project
// member's business, only an operator's.
export function registerListRegistriesTool(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "list_registries",
    {
      title: "List registries",
      description: "List every Harbor registry across all clusters, with live health. Requires the ADMIN role.",
    },
    async () =>
      runTool("list_registries", ctx, async () => {
        requireRole(ctx.session, Role.ADMIN)
        return listRegistriesWithHealth()
      }),
  )
}

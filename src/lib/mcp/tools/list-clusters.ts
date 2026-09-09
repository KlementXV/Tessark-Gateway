import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"

import { Role } from "@/generated/prisma/client"
import { requireRole } from "@/lib/auth/guard"
import { listClustersWithHealth } from "@/lib/clusters/service"
import { runTool, type ToolContext } from "@/lib/mcp/tool-runner"

// Mirrors GET /api/clusters: ADMIN+. Authentication itself already happened in the route
// handler (see src/app/api/mcp/route.ts), but authorization has to be repeated here — a tool
// calls the service layer directly and so never passes the route's own gate. The payload is
// the registry inventory, which is an operator's business only, exactly as for
// list_registries.
export function registerListClustersTool(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "list_clusters",
    {
      title: "List clusters",
      description:
        "List every Harbor cluster with its members' live health and pending replication work. Requires the ADMIN role.",
    },
    async () =>
      runTool("list_clusters", ctx, async () => {
        requireRole(ctx.session, Role.ADMIN)
        return listClustersWithHealth()
      }),
  )
}

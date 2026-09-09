import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"

import { loadProjectForAccess } from "@/lib/projects/access"
import { runTool, type ToolContext } from "@/lib/mcp/tool-runner"

// Mirrors GET /api/projects/[id]: loadProjectForAccess throws AuthError (404/403) for a
// missing or unreadable project, which runTool turns into a tool error result.
export function registerGetProjectTool(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "get_project",
    {
      title: "Get project",
      description: "Get full detail for one project (Harbor members, placements, robot accounts, retention policy) by id.",
      inputSchema: { projectId: z.string().min(1) },
    },
    async ({ projectId }) =>
      runTool("get_project", ctx, async () => {
        const { project, isManager } = await loadProjectForAccess(projectId, ctx.session)
        return { ...project, isManager }
      }),
  )
}

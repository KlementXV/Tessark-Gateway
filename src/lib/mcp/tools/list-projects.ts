import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"

import { listProjectsForSession } from "@/lib/projects/service"
import { runTool, type ToolContext } from "@/lib/mcp/tool-runner"

// Same visibility rule as GET /api/projects: the caller's own projects plus every public one,
// or everything if their token's Role is ADMIN+ — listProjectsForSession is the single
// implementation both surfaces share.
export function registerListProjectsTool(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "list_projects",
    {
      title: "List projects",
      description: "List the Harbor projects visible to the caller: their own, public ones, and — for ADMIN+ — every project on the instance.",
    },
    async () => runTool("list_projects", ctx, () => listProjectsForSession(ctx.session)),
  )
}

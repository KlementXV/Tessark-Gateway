import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"

import { listRequestsForUser } from "@/lib/requests/service"
import { runTool, type ToolContext } from "@/lib/mcp/tool-runner"

// Self-scoped, like the "My requests" tab: the pull requests the caller raised themselves,
// whatever their state. There is no REST route with a broader (e.g. admin-wide) scope to
// mirror yet — Admin > Requests is a Server Component, not an API route — so this stays
// narrow rather than inventing new RBAC surface.
export function registerListTransfersTool(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "list_transfers",
    {
      title: "List transfers",
      description: "List the image transfer (mirroring) requests the caller has raised themselves, in any state.",
    },
    async () =>
      runTool("list_transfers", ctx, async () => {
        const items = await listRequestsForUser(ctx.session.user.id)
        return items.filter((item) => item.kind === "TRANSFER")
      }),
  )
}

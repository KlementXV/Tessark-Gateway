import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"

import type { ToolContext } from "@/lib/mcp/tool-runner"
import { registerApproveTransferRequestTool } from "@/lib/mcp/tools/approve-transfer"
import { registerCreateProjectTool } from "@/lib/mcp/tools/create-project"
import { registerCreateTransferRequestTool } from "@/lib/mcp/tools/create-transfer"
import { registerGetProjectTool } from "@/lib/mcp/tools/get-project"
import { registerGetTransferStatusTool } from "@/lib/mcp/tools/get-transfer-status"
import { registerListClustersTool } from "@/lib/mcp/tools/list-clusters"
import { registerListProjectsTool } from "@/lib/mcp/tools/list-projects"
import { registerListTransfersTool } from "@/lib/mcp/tools/list-transfers"
import { registerListRegistriesTool } from "@/lib/mcp/tools/list-registries"
import { registerSearchImagesTool } from "@/lib/mcp/tools/search-images"

export function registerReadOnlyTools(server: McpServer, ctx: ToolContext) {
  registerListProjectsTool(server, ctx)
  registerGetProjectTool(server, ctx)
  registerListRegistriesTool(server, ctx)
  registerListClustersTool(server, ctx)
  registerListTransfersTool(server, ctx)
  registerGetTransferStatusTool(server, ctx)
  registerSearchImagesTool(server, ctx)
}

// Kept deliberately narrow — see docs/plan-api-mcp.md Lot 7. create_robot_account was in the
// original plan but is excluded here: it cannot avoid calling encryptSecret, and for a
// cluster whose members don't unify robot secrets it hands a plaintext Harbor credential
// straight back into the calling LLM's context. That is a separate decision the plan's own
// exclusion rule already flags as needing human sign-off, not something to fold in here.
export function registerWriteTools(server: McpServer, ctx: ToolContext) {
  registerCreateTransferRequestTool(server, ctx)
  registerApproveTransferRequestTool(server, ctx)
  registerCreateProjectTool(server, ctx)
}

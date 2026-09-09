// One McpServer per request, not a long-lived singleton: the tools closured into it below
// carry the caller's own Session, and building it fresh means there is nothing to accidentally
// share between two different tokens' requests — consistent with the in-memory rate limiter's
// own no-shared-state-across-replicas caveat (src/lib/api-tokens/rate-limit.ts).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"

import { getConfig } from "@/lib/config"
import { registerReadOnlyTools, registerWriteTools } from "@/lib/mcp/tools"
import type { ToolContext } from "@/lib/mcp/tool-runner"

export function buildMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: "tessark-gateway", version: "1.0.0" })
  registerReadOnlyTools(server, ctx)
  if (getConfig().mcpWriteToolsEnabled) registerWriteTools(server, ctx)
  return server
}

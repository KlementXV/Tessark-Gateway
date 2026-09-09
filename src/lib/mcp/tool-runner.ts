// Every registered tool goes through here: one place to apply the audit log (Lot 6/7 of
// docs/plan-api-mcp.md — log the call, never its raw arguments, since a project/registry id
// can be sensitive in a multi-tenant sense even if not a secret) and to turn a thrown domain
// error into a tool-level error result instead of letting it reach the SDK as an unhandled
// rejection.
import { logger } from "@/lib/logger"
import { errorResult, jsonResult } from "@/lib/mcp/result"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"

export interface ToolContext {
  session: import("next-auth").Session
  tokenId: string
}

// The codebase's own convention for a domain error that carries an HTTP-equivalent status —
// AuthError, TransferValidationError, TransferLaunchError, ProjectActivationError all follow this
// same `message` + `status: number` shape rather than a shared base class, so this is a
// structural check rather than an instanceof chain that would have to name each one.
function statusOf(err: unknown): number {
  if (err && typeof err === "object" && "status" in err && typeof err.status === "number") {
    return err.status
  }
  return 500
}

// Write tools (Lot 7) pass `auditId` to extract the created row's id for the audit log —
// read tools leave it out and only ok/status are recorded.
export async function runTool(
  tool: string,
  ctx: ToolContext,
  fn: () => Promise<unknown>,
  auditId?: (data: unknown) => string | undefined,
): Promise<CallToolResult> {
  try {
    const data = await fn()
    logger.info("MCP tool call", { tokenId: ctx.tokenId, tool, ok: true, id: auditId?.(data) })
    return jsonResult(data)
  } catch (err) {
    logger.info("MCP tool call", {
      tokenId: ctx.tokenId,
      tool,
      ok: false,
      status: statusOf(err),
      error: err instanceof Error ? err.message : undefined,
    })
    return errorResult(err instanceof Error ? err.message : "Unexpected error")
  }
}

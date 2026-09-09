// Shared shaping for MCP tool results — every tool returns one of these two shapes, never a
// raw thrown error: the MCP transport reports transport-level failures on its own, but a tool
// failure (not found, not authorized, bad Harbor response) is business data the calling LLM
// should see and can react to, not a broken connection.
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"

export function jsonResult(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] }
}

export function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true }
}

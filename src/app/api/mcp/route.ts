// Streamable HTTP MCP server — see docs/plan-api-mcp.md Lot 6. Bearer API token only, never
// the session cookie: an LLM client has no browser to hold one. Off unless MCP_ENABLED=true,
// and even then only reachable at all when API_EXTERNAL_ENABLED is also on (resolveApiToken
// is meaningless without it — see src/lib/auth/guard.ts's own gate on the same flag — so this
// route enforces both rather than relying on the other route family's check).
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { NextResponse } from "next/server"

import { resolveApiToken } from "@/lib/auth/api-token"
import { getConfig } from "@/lib/config"
import { buildMcpServer } from "@/lib/mcp/server"

async function handle(request: Request): Promise<Response> {
  if (!getConfig().mcpEnabled || !getConfig().apiExternalEnabled) {
    return NextResponse.json({ error: "Not found" }, { status: 404 })
  }

  const result = await resolveApiToken(request)
  if (result.rateLimited) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(result.retryAfterSeconds) } },
    )
  }
  if (!result.session) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 })
  }

  const server = buildMcpServer({ session: result.session, tokenId: result.tokenId })
  // enableJsonResponse: this route only ever answers the request that opened it (no
  // server-initiated notifications a tool would need to push later), so a single JSON
  // response is simpler and cheaper than holding an SSE stream open per request.
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true })
  await server.connect(transport)
  return transport.handleRequest(request)
}

export async function POST(request: Request) {
  return handle(request)
}

export async function GET(request: Request) {
  return handle(request)
}

export async function DELETE(request: Request) {
  return handle(request)
}

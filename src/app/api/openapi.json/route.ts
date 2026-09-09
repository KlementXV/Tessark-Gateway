import { NextResponse } from "next/server"

import { buildOpenApiDocument } from "@/lib/openapi/document"

// Public by design — same reasoning as GET /api/settings/branding: this describes the API,
// it doesn't expose any of its data. Restricting it to a private network, if desired, is an
// Ingress-level decision (see docs/plan-api-mcp.md, Lot 8), not an application-level one.
export async function GET(request: Request) {
  const origin = new URL(request.url).origin
  return NextResponse.json(buildOpenApiDocument(origin))
}

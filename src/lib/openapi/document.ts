// Assembles the OpenAPI 3.1 document from the declarative registry — computed fresh on every
// request to /api/openapi.json (see that route), never committed, so it always reflects the
// code that is actually running rather than a snapshot that can drift.
import { z } from "zod"

import { ROUTES, type RouteSpec } from "@/lib/openapi/registry"

const API_VERSION = "1.0.0"

const ROLE_DESCRIPTION: Record<Exclude<RouteSpec["minRole"], "public">, string> = {
  user: "Requires an authenticated account.",
  admin: "Requires the ADMIN role or higher.",
  superadmin: "Requires the SUPERADMIN role.",
}

// io: "input" describes the shape a caller must *send*, not what a `.transform()` turns it
// into server-side (irrelevant to a requestBody schema, and z.toJSONSchema's default "output"
// mode throws outright on schemas with a transform — several of these have one, e.g.
// profileUpdateInputSchema). $schema is stripped: redundant once embedded as a `content`
// schema inside an OpenAPI document.
function jsonSchemaFor(schema: z.ZodType): Record<string, unknown> {
  /* eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to exclude it */
  const { $schema: _$schema, ...rest } = z.toJSONSchema(schema, { io: "input" })
  return rest
}

function pathParameters(path: string) {
  return [...path.matchAll(/\{([^}]+)\}/g)].map((match) => ({
    name: match[1],
    in: "path",
    required: true,
    schema: { type: "string" },
  }))
}

// e.g. GET /projects/{id}/members/{userId} -> "getProjectsByIdMembersByUserId" — mechanical,
// but stable and unique per (method, path), which is all a client generator needs from it.
function operationId(route: RouteSpec): string {
  const segments = route.path
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      const param = segment.match(/^\{(.+)\}$/)?.[1]
      const word = param ? `By${param}` : segment
      return word.charAt(0).toUpperCase() + word.slice(1)
    })
  return `${route.method.toLowerCase()}${segments.join("")}`
}

function operationFor(route: RouteSpec): Record<string, unknown> {
  const authenticated = route.minRole !== "public"

  const responses: Record<string, unknown> = { "200": { description: "OK" } }
  if (authenticated) {
    responses["401"] = { description: "Not authenticated" }
    responses["403"] = { description: "Not authorized" }
  }

  const operation: Record<string, unknown> = {
    operationId: operationId(route),
    summary: route.summary,
    tags: route.tags,
    parameters: pathParameters(route.path),
    responses,
    // Always explicit, never omitted: an operation with no `security` key at all is
    // ambiguous (falls back to the document's own top-level default, which this document
    // doesn't set) — an empty array is what actually says "no auth required" for a public
    // route.
    security: authenticated ? [{ bearerAuth: [] }] : [],
  }

  if (authenticated) {
    operation.description = ROLE_DESCRIPTION[route.minRole as Exclude<RouteSpec["minRole"], "public">]
  }

  if (route.requestSchema) {
    operation.requestBody = {
      required: true,
      content: { "application/json": { schema: jsonSchemaFor(route.requestSchema) } },
    }
  }

  return operation
}

export function buildOpenApiDocument(origin: string): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {}
  for (const route of ROUTES) {
    paths[route.path] ??= {}
    paths[route.path][route.method.toLowerCase()] = operationFor(route)
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "Tessark Gateway API",
      version: API_VERSION,
      description:
        "REST API for managing Harbor clusters, registries, projects, robots, retention " +
        "policies and upstream image mirroring. Authenticate with a Bearer API token created " +
        "from Settings → API Tokens — the frontend's own session cookie also works, but only " +
        "a Bearer token can be used from outside the browser, and only when this instance has " +
        "API_EXTERNAL_ENABLED turned on.",
    },
    servers: [{ url: `${origin}/api` }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description: "An API token created from Settings → API Tokens, sent as `Authorization: Bearer <token>`.",
        },
      },
    },
    paths,
  }
}

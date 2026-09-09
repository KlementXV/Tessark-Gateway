// Protects every dashboard route. Public: /login, /icon.svg, /api/auth/*, reading the
// branding logo and the bundled fallback brand artwork (the login page renders those
// assets anonymously, and a redirect to /login turns them into broken images), the two probes — the
// kubelet's liveness/readiness checks carry no session, so without this exception the pod
// would never pass its own readiness probe and would never start receiving traffic — and the
// API documentation (/api/openapi.json, /api/docs and its static assets): it describes the
// API, it doesn't expose any of its data, so gating it behind a session defeats the point of
// handing it to an external client that has no cookie.
//
// A Bearer Authorization header on an /api/* request is also let through unauthenticated at
// this layer: this middleware only ever checks the session cookie, and has no business
// validating an ApiToken (that means a DB lookup — see resolveApiToken — which the route
// handler's own authenticateRequest already does as the sole authority, honoring
// API_EXTERNAL_ENABLED and returning 401/403 itself). This file must not know how to accept
// a token as valid, only how to avoid blocking one that might be.
import { auth } from "@/auth"

const PUBLIC_ARTWORK = new Set(["/ocify_black.svg", "/ocify_white.svg"])

// `auth()` here builds a NextAuth handler around the check below. It is awaited rather than
// exported directly: src/auth.ts passes NextAuth a *factory* (so `next build` never needs a
// full environment), and in that form `auth(handler)` resolves the configuration first and
// therefore returns a promise of the handler, not the handler itself. Next requires this file
// to export a function, so the await happens here.
//
// This runs in the Node.js runtime, not the edge one — which is what lets the session check
// reach the database at all (src/auth.ts re-reads the role periodically). The refreshed JWT
// rides back out on the Set-Cookie that NextAuth appends to this response, so the re-read
// happens once per refresh window, not once per request.
const withAuth = auth((req) => {
  const isLoggedIn = Boolean(req.auth)
  const { pathname } = req.nextUrl
  const isPublicPage = pathname === "/login"
  const isAuthApi = pathname.startsWith("/api/auth/")
  const isPublicIcon = pathname === "/icon.svg"
  // Read-only: POST/DELETE on this path still require SUPERADMIN in the route handler.
  const isPublicLogo = pathname === "/api/settings/branding/logo" && req.method === "GET"
  // Shipped in public/: the theme-aware mark BrandMark falls back to when no instance
  // logo is configured — which is exactly the state a fresh install logs in from.
  const isPublicArtwork = PUBLIC_ARTWORK.has(pathname)
  const isProbe = pathname === "/api/health" || pathname === "/api/ready"
  const isApiDocs =
    pathname === "/api/openapi.json" || pathname.startsWith("/api/docs") || pathname.startsWith("/swagger-ui/")
  const isApi = pathname.startsWith("/api/")
  const hasBearerCandidate = isApi && Boolean(req.headers.get("authorization")?.startsWith("Bearer "))

  if (
    isAuthApi ||
    isPublicIcon ||
    isPublicLogo ||
    isPublicArtwork ||
    isProbe ||
    isApiDocs ||
    hasBearerCandidate
  ) {
    return
  }

  if (!isLoggedIn && !isPublicPage) {
    if (isApi) {
      return Response.json({ error: "Not authenticated" }, { status: 401 })
    }
    const loginUrl = new URL("/login", req.nextUrl.origin)
    const callbackUrl = pathname + (req.nextUrl.search ?? "")
    if (callbackUrl !== "/login") {
      loginUrl.searchParams.set("callbackUrl", callbackUrl)
    }
    return Response.redirect(loginUrl)
  }

  if (isLoggedIn && isPublicPage) {
    return Response.redirect(new URL("/", req.nextUrl.origin))
  }
})

// Exported by name, which is what Next looks for first in a file called proxy.ts.
export async function proxy(...args: Parameters<Awaited<typeof withAuth>>) {
  return (await withAuth)(...args)
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
}

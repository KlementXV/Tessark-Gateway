import { NextResponse } from "next/server"

// Swagger UI, self-hosted: assets are static files under public/swagger-ui/ (vendored from
// swagger-ui-dist by scripts/copy-swagger-ui.mjs — see CLAUDE.md §7 D9), never a CDN, so this
// page renders even fully offline. Public for the same reason as /api/openapi.json itself.
const HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Tessark Gateway API</title>
    <link rel="icon" href="/swagger-ui/favicon-32x32.png" />
    <link rel="stylesheet" href="/swagger-ui/swagger-ui.css" />
    <style>body { margin: 0; }</style>
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="/swagger-ui/swagger-ui-bundle.js"></script>
    <script src="/swagger-ui/swagger-ui-standalone-preset.js"></script>
    <script>
      window.ui = SwaggerUIBundle({
        url: "/api/openapi.json",
        dom_id: "#swagger-ui",
        presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
        layout: "StandaloneLayout",
      })
    </script>
  </body>
</html>
`

export async function GET() {
  return new NextResponse(HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } })
}

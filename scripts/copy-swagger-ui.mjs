// Vendors the handful of static assets Swagger UI needs into public/swagger-ui/, so
// /api/docs (see src/app/api/docs/route.ts) can serve them from this app's own origin —
// no CDN, so the docs page still works fully offline/air-gapped (CLAUDE.md §7 D9).
//
// Runs via "predev"/"prebuild" (package.json) rather than "postinstall": public/ is
// gitignored and each Docker build stage has its own isolated filesystem, so a copy made once
// at `npm ci` time in one stage wouldn't survive into the stage that actually ships — running
// it as part of `next build`/`next dev` themselves means it always lands wherever those
// commands are actually run, deps-stage propagation aside.
import { copyFileSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const src = join(here, "..", "node_modules", "swagger-ui-dist")
const dest = join(here, "..", "public", "swagger-ui")

const ASSETS = ["swagger-ui.css", "swagger-ui-bundle.js", "swagger-ui-standalone-preset.js", "favicon-32x32.png"]

mkdirSync(dest, { recursive: true })
for (const asset of ASSETS) {
  copyFileSync(join(src, asset), join(dest, asset))
}

console.log(`Copied ${ASSETS.length} Swagger UI assets to public/swagger-ui/`)

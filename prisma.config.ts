// prisma.config.ts — Prisma 6 configuration
// Loads .env.local (Next.js convention) instead of .env
import { config } from "dotenv"
import { defineConfig } from "prisma/config"

// quiet: true — in the migration Job container there is no .env.local (DATABASE_URL comes
// straight from the Secret's env), and dotenv logging that as a notice on every run is noise.
config({ path: ".env.local", quiet: true })

// No `datasource.url` override here on purpose: `prisma/config`'s `env()` helper throws
// eagerly the moment the CLI loads this file, for *every* command — including `prisma
// generate`, which needs no database at all. That broke `docker build` (no .env.local in the
// build context, and no DATABASE_URL either — CLAUDE.md §1: config is read at runtime, never
// baked into the image). schema.prisma already declares `url = env("DATABASE_URL")` on the
// datasource block, which Prisma only evaluates lazily when a command actually needs to
// connect (`migrate deploy`, `db seed`) — that alone is enough, and doesn't require
// DATABASE_URL to be set just to generate the client.
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
})

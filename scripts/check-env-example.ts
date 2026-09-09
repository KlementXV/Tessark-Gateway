// Fails if .env.example drifts from the zod schema in src/lib/config.ts — the whole point of
// .env.example is to be the exact reference for what the schema (and eventually the Helm
// chart) expects. Run with: npx tsx scripts/check-env-example.ts
import { readFileSync } from "node:fs"
import { CONFIG_ENV_KEYS } from "../src/lib/config"

const envExample = readFileSync(new URL("../.env.example", import.meta.url), "utf8")

// Matches both live ("KEY=...") and commented-out-but-documented ("# KEY=...") lines, since
// most ConfigMap variables are shown commented out with their default value as a hint.
const found = new Set<string>()
for (const line of envExample.split("\n")) {
  const match = line.match(/^#?\s*([A-Z][A-Z0-9_]*)=/)
  if (match) found.add(match[1])
}

const schemaKeys = new Set(CONFIG_ENV_KEYS)
const missingFromExample = CONFIG_ENV_KEYS.filter((key) => !found.has(key))
const extraInExample = [...found].filter((key) => !schemaKeys.has(key))

if (missingFromExample.length > 0 || extraInExample.length > 0) {
  if (missingFromExample.length > 0) {
    console.error("In the config schema but missing from .env.example:")
    for (const key of missingFromExample) console.error(`  - ${key}`)
  }
  if (extraInExample.length > 0) {
    console.error("In .env.example but not in the config schema:")
    for (const key of extraInExample) console.error(`  - ${key}`)
  }
  process.exit(1)
}

console.log(`.env.example matches the config schema (${CONFIG_ENV_KEYS.length} variables).`)

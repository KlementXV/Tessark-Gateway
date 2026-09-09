// Fails when messages/fr.json and messages/en.json don't carry exactly the same keys — a key
// present in one language only shows up at runtime as the raw key (or an English fallback)
// in the other. Run with: npx tsx scripts/check-messages.ts
import { readdirSync, readFileSync } from "node:fs"

const dir = new URL("../messages/", import.meta.url)
const files = readdirSync(dir).filter((f) => f.endsWith(".json"))

function flatten(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) return [prefix]
  return Object.entries(value).flatMap(([key, child]) => flatten(child, prefix ? `${prefix}.${key}` : key))
}

const keysByFile = new Map(
  files.map((file) => [file, new Set(flatten(JSON.parse(readFileSync(new URL(file, dir), "utf8"))))]),
)
const reference = keysByFile.get("en.json")
if (!reference) throw new Error("messages/en.json is missing")

let failed = false
for (const [file, keys] of keysByFile) {
  if (file === "en.json") continue
  const missing = [...reference].filter((key) => !keys.has(key))
  const extra = [...keys].filter((key) => !reference.has(key))
  if (missing.length > 0 || extra.length > 0) {
    failed = true
    if (missing.length > 0) console.error(`${file} is missing ${missing.length} key(s):\n  ${missing.join("\n  ")}`)
    if (extra.length > 0) console.error(`${file} has ${extra.length} key(s) not in en.json:\n  ${extra.join("\n  ")}`)
  }
}
if (failed) process.exit(1)
console.log(`messages: ${files.join(", ")} carry the same ${reference.size} keys.`)

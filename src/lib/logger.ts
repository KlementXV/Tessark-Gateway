// Single logging entry point — see CLAUDE.md §6. One line per call: JSON when
// NODE_ENV=production (what Loki/ELK expect), readable text otherwise. Server-only (reads
// config, which reads process.env/fs) — never import this from a "use client" component.
import { getConfig } from "@/lib/config"

export type LogLevel = "debug" | "info" | "warn" | "error"

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

// Case-insensitive substring match on the field *key*, not its value — deliberately broad
// so a caller doesn't have to know every sensitive field name in advance. Anything that
// looks like it could hold GATEWAY_SECRET_KEY, a robot secret, or decryptSecret() output
// gets masked rather than risk it leaking into a log line (CLAUDE.md §6). `token(?!id)`
// excludes `tokenId`/`token_id`: an ApiToken's own row id, not the bearer secret — the MCP
// and ApiToken audit trails (src/lib/mcp/tool-runner.ts, src/lib/auth/api-token.ts) need it
// to correlate calls back to a token without printing anything that could authenticate.
const SENSITIVE_KEY_PATTERN = /secret|password|token(?!id)|credential|authorization|apikey|api[-_]?key/i

export type LogFields = Record<string, unknown>

export interface Logger {
  debug(message: string, fields?: LogFields): void
  info(message: string, fields?: LogFields): void
  warn(message: string, fields?: LogFields): void
  error(message: string, fields?: LogFields): void
  child(fields: LogFields): Logger
}

// JSON.stringify drops Error's useful properties (name, message and stack), and throws on
// bigint. Convert every field into a JSON-safe value before handing it to the console so a
// failed logging call can never hide the original application failure.
function redact(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value
  }
  if (typeof value === "bigint") return value.toString()
  if (typeof value === "undefined") return undefined
  if (typeof value === "symbol" || typeof value === "function") return String(value)

  if (value instanceof Date) return Number.isNaN(value.valueOf()) ? "Invalid Date" : value.toISOString()
  if (value instanceof Error) {
    if (seen.has(value)) return "[circular]"
    seen.add(value)
    const error: LogFields = { name: value.name, message: value.message }
    if (value.stack) error.stack = value.stack
    if ("cause" in value && value.cause !== undefined) error.cause = redact(value.cause, seen)
    return error
  }

  if (seen.has(value)) return "[circular]"
  seen.add(value)

  if (Array.isArray(value)) {
    try {
      return value.map((item) => redact(item, seen))
    } catch {
      return "[unserializable array]"
    }
  }

  const out: LogFields = {}
  try {
    for (const [key, val] of Object.entries(value as LogFields)) {
      out[key] = SENSITIVE_KEY_PATTERN.test(key) ? "[redacted]" : redact(val, seen)
    }
  } catch {
    return "[unserializable object]"
  }
  return out
}

function currentLevel(): LogLevel {
  try {
    return getConfig().logLevel
  } catch {
    // A logging call is never the right place to surface a config error — fall back to the
    // schema's own default rather than throwing out from inside a log statement.
    return "info"
  }
}

const CONSOLE_METHOD: Record<LogLevel, "log" | "warn" | "error"> = {
  debug: "log",
  info: "log",
  warn: "warn",
  error: "error",
}

function emit(level: LogLevel, message: string, fields?: LogFields): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel()]) return

  const safeFields = fields ? (redact(fields, new WeakSet()) as LogFields) : undefined
  const method = CONSOLE_METHOD[level]

  if (process.env.NODE_ENV === "production") {
    // Put the fixed envelope last: a caller's `level`, `msg` or `time` field must never
    // overwrite metadata that log collectors use for filtering and ordering.
    console[method](JSON.stringify({ ...safeFields, level, msg: message, time: new Date().toISOString() }))
    return
  }

  console[method](`[${level}] ${message}`, safeFields ?? "")
}

function createLogger(bindings: LogFields = {}): Logger {
  const withBindings = (fields?: LogFields): LogFields => ({ ...bindings, ...fields })

  return {
    debug: (message, fields) => emit("debug", message, withBindings(fields)),
    info: (message, fields) => emit("info", message, withBindings(fields)),
    warn: (message, fields) => emit("warn", message, withBindings(fields)),
    error: (message, fields) => emit("error", message, withBindings(fields)),
    // A child carries durable context such as a job or registry id. It is deliberately
    // re-redacted at emit time, including when a child is composed from another child.
    child: (fields) => createLogger(withBindings(fields)),
  }
}

export const logger = createLogger()

// One schedule, two schedulers.
//
// A mirror's schedule is stored as a standard 5-field crontab in UTC ("0 3 * * *") because
// that is the only form Kubernetes accepts, and a CronJob is handed the string verbatim.
// Harbor's scheduler is robfig/cron, which reads a *6*-field expression with seconds first,
// so the harbor transport prefixes a zero second. Storing Harbor's dialect instead would mean
// the Kubernetes transport had to strip a field and hope the operator wrote a zero there.
//
// Cluster.replicationCron is the 6-field form for exactly the same reason in reverse: it only
// ever reaches Harbor. The two are not interchangeable, which is why neither is reused here.

const FIELD = String.raw`[0-9*/,\-]+`
const CRON_5 = new RegExp(`^${FIELD}(?:\\s+${FIELD}){4}$`)

export function isValidSchedule(value: string): boolean {
  if (!CRON_5.test(value.trim())) return false
  const fields = value.trim().split(/\s+/)
  const bounds = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]]
  return fields.every((field, i) => parseField(field, bounds[i][0], bounds[i][1]) !== null)
}

/** "0 3 * * *" → "0 0 3 * * *" — Harbor's seconds-first cron. */
export function toHarborCron(schedule: string): string {
  return `0 ${schedule.trim()}`
}

/** A few schedules worth offering in the form; anything else is typed by hand. */
export const SCHEDULE_PRESETS = ["0 * * * *", "0 3 * * *", "0 3 * * 1", "0 3 1 * *"] as const

// --- Next occurrence -------------------------------------------------------------------
//
// Answering "when does this run next" needs a cron evaluator, and the project has no cron
// dependency — the same reason src/lib/k8s/client.ts is hand-written rather than pulling in
// @kubernetes/client-node. The grammar accepted here is exactly the one isValidSchedule()
// admits (digits, *, /, ,, -), no more: no @daily, no names, no step on a range's tail.
//
// Everything is UTC, like the stored schedule. Neither Kubernetes nor Harbor is told a time
// zone, so computing in local time would drift by an hour twice a year and be wrong in a way
// nobody would notice until the wrong hour.

interface Field {
  values: Set<number>
  /** A bare "*" — needed because cron's day-of-month / day-of-week rule depends on it. */
  wildcard: boolean
}

function parseField(spec: string, min: number, max: number): Field | null {
  if (!/^(?:\*|\d+(?:-\d+)?)(?:\/\d+)?(?:,(?:\*|\d+(?:-\d+)?)(?:\/\d+)?)*$/.test(spec)) return null
  const values = new Set<number>()

  for (const part of spec.split(",")) {
    const [range, stepText] = part.split("/")
    const step = stepText === undefined ? 1 : Number(stepText)
    if (!Number.isInteger(step) || step < 1) return null

    let start: number
    let end: number
    if (range === "*") {
      start = min
      end = max
    } else if (range.includes("-")) {
      const [a, b] = range.split("-").map(Number)
      if (!Number.isInteger(a) || !Number.isInteger(b)) return null
      start = a
      end = b
    } else {
      const value = Number(range)
      if (!Number.isInteger(value)) return null
      start = value
      // "5/15" means "from 5 to the end of the field, every 15" — not "5 alone".
      end = stepText === undefined ? value : max
    }

    if (start < min || end > max || start > end) return null
    for (let v = start; v <= end; v += step) values.add(v)
  }

  return values.size > 0 ? { values, wildcard: spec === "*" } : null
}

/**
 * The next UTC instant this schedule fires strictly after `from`, or null if the expression is
 * unparseable or matches nothing within a year (a real cron case: "0 0 30 2 *" — 30 February).
 *
 * Searched day by day rather than minute by minute: a year of minutes is half a million
 * candidates, a year of days is 366, and within a matching day the hour and minute are read
 * straight off the parsed sets.
 */
export function nextRunAt(schedule: string, from: Date = new Date()): Date | null {
  const parts = schedule.trim().split(/\s+/)
  if (parts.length !== 5) return null

  const minutes = parseField(parts[0], 0, 59)
  const hours = parseField(parts[1], 0, 23)
  const daysOfMonth = parseField(parts[2], 1, 31)
  const months = parseField(parts[3], 1, 12)
  // 7 is Sunday in most crons, including robfig/cron and Kubernetes; normalised to 0 below.
  const daysOfWeek = parseField(parts[4], 0, 7)
  if (!minutes || !hours || !daysOfMonth || !months || !daysOfWeek) return null
  if (daysOfWeek.values.has(7)) daysOfWeek.values.add(0)

  const sorted = (field: Field) => [...field.values].sort((a, b) => a - b)
  const minuteList = sorted(minutes)
  const hourList = sorted(hours)

  // Start at the next whole minute: a schedule matching the current minute has already fired.
  const cursor = new Date(from)
  cursor.setUTCSeconds(0, 0)
  cursor.setUTCMinutes(cursor.getUTCMinutes() + 1)

  for (let day = 0; day < 366; day += 1) {
    const dayStart = new Date(cursor)
    if (day > 0) {
      dayStart.setUTCDate(dayStart.getUTCDate() + day)
      dayStart.setUTCHours(0, 0, 0, 0)
    }

    if (!months.values.has(dayStart.getUTCMonth() + 1)) continue

    // Cron's oddest rule: when day-of-month and day-of-week are both restricted, a day matches
    // if *either* does — the fields are a union, not an intersection. When one is "*", only the
    // other decides.
    const domMatch = daysOfMonth.values.has(dayStart.getUTCDate())
    const dowMatch = daysOfWeek.values.has(dayStart.getUTCDay())
    const dayMatches =
      daysOfMonth.wildcard && daysOfWeek.wildcard
        ? true
        : daysOfMonth.wildcard
          ? dowMatch
          : daysOfWeek.wildcard
            ? domMatch
            : domMatch || dowMatch
    if (!dayMatches) continue

    // On the first day the search starts mid-day; on every later one it starts at midnight.
    const fromHour = day === 0 ? dayStart.getUTCHours() : 0
    const fromMinute = day === 0 ? dayStart.getUTCMinutes() : 0

    for (const hour of hourList) {
      if (hour < fromHour) continue
      for (const minute of minuteList) {
        if (hour === fromHour && minute < fromMinute) continue
        const at = new Date(dayStart)
        at.setUTCHours(hour, minute, 0, 0)
        return at
      }
    }
  }

  return null
}

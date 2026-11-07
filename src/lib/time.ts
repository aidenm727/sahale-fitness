/** Relative labels ("Today", "3d ago") count from the day the page loaded. */
export const NOW = new Date()
export const TODAY = startOfDay(NOW)

const DAY = 86_400_000
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/

/**
 * Parse a Date, ISO timestamp, or calendar date key. A key like "2026-10-05"
 * means that day in local time (plain `new Date(key)` would read it as UTC
 * midnight — the evening before, west of Greenwich).
 */
export function toDate(d: Date | string): Date {
  if (typeof d === 'string' && DATE_KEY.test(d)) {
    const [y, m, day] = d.split('-').map(Number)
    return new Date(y, m - 1, day)
  }
  return new Date(d)
}

export function startOfDay(d: Date): Date {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}

/** Local calendar date key, e.g. "2026-10-03". */
export function dayKey(d: Date | string): string {
  const x = toDate(d)
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`
}

export function dayDiff(from: Date | string, to: Date | string = TODAY): number {
  const a = startOfDay(toDate(from)).getTime()
  const b = startOfDay(toDate(to)).getTime()
  return Math.round((b - a) / DAY)
}

/** Days from today until `d` (negative = past). */
export function daysUntil(d: Date | string): number {
  return -dayDiff(d)
}

const WEEKDAY = new Intl.DateTimeFormat('en-US', { weekday: 'short' })
const MONTH_DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' })
const FULL = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
const LONG = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
const TIME = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' })

export const fmt = {
  weekday: (d: Date | string) => WEEKDAY.format(toDate(d)),
  monthDay: (d: Date | string) => MONTH_DAY.format(toDate(d)),
  date: (d: Date | string) => FULL.format(toDate(d)),
  long: (d: Date | string) => LONG.format(toDate(d)),
  time: (d: Date | string) => TIME.format(toDate(d)).replace(/[\s\u202f]+/, '\u00a0'),
  /** "Today", "Yesterday", "Tomorrow", "Thu", or "Sep 28". */
  day(d: Date | string): string {
    const n = daysUntil(d)
    if (n === 0) return 'Today'
    if (n === -1) return 'Yesterday'
    if (n === 1) return 'Tomorrow'
    if (n > 1 && n < 7) return WEEKDAY.format(toDate(d))
    if (n < -1 && n > -7) return WEEKDAY.format(toDate(d))
    return MONTH_DAY.format(toDate(d))
  },
  /** "Today", "Yesterday", "Tomorrow", else the weekday — pairs with monthDay underneath. */
  dayName(d: Date | string): string {
    const n = daysUntil(d)
    if (n === 0) return 'Today'
    if (n === -1) return 'Yesterday'
    if (n === 1) return 'Tomorrow'
    return WEEKDAY.format(toDate(d))
  },
  /** "2d ago", "in 3d", "today" */
  rel(d: Date | string): string {
    const n = daysUntil(d)
    if (n === 0) return 'today'
    if (n === -1) return 'yesterday'
    if (n === 1) return 'tomorrow'
    if (n < 0) return `${-n}d ago`
    return `in ${n}d`
  },
  }

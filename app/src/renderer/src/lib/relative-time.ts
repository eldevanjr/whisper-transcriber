const SECOND = 1_000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const MONTH = 30 * DAY
const YEAR = 365 * DAY

/** "usado há 3 min." / "used 3 min. ago" no idioma da interface (spec §10.2). */
export function formatRelative(iso: string, now: number, locale: string): string {
  const diff = new Date(iso).getTime() - now
  const abs = Math.abs(diff)
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'short' })
  if (abs < MINUTE) return format.format(Math.round(diff / SECOND), 'second')
  if (abs < HOUR) return format.format(Math.round(diff / MINUTE), 'minute')
  if (abs < DAY) return format.format(Math.round(diff / HOUR), 'hour')
  if (abs < MONTH) return format.format(Math.round(diff / DAY), 'day')
  if (abs < YEAR) return format.format(Math.round(diff / MONTH), 'month')
  return format.format(Math.round(diff / YEAR), 'year')
}

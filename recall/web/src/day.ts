/**
 * Local days. The API has no time zone (../../docs/design.md §8.1): the UI names a day of the browser's zone as
 * `YYYY-MM-DD` (a day key, in the URL and the search's date operators) and turns it into the instants of its local
 * midnights. Built on the Date constructor, so a day of a daylight-saving change has its 23 or 25 hours.
 */

const pad = (n: number) => String(n).padStart(2, '0')

/** The local day of an instant, `2026-10-09`. */
export function dayKey(ms: number): string {
  const date = new Date(ms)
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** A typed date (`2026-10-09` or `2026/10/09`, months and days with or without a leading zero) as a day key; null when it is no date. */
export function parseDay(text: string): string | null {
  const match = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(text.trim())
  if (match === null) return null
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const date = new Date(year, month - 1, day)
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null
  return dayKey(date.getTime())
}

function parts(key: string): [number, number, number] {
  const [year, month, day] = key.split('-').map(Number)
  return [year ?? 1970, (month ?? 1) - 1, day ?? 1]
}

/** The local midnight starting a day. */
export function dayStart(key: string): number {
  const [year, month, day] = parts(key)
  return new Date(year, month, day).getTime()
}

/** The day `n` days after (before, when negative) `key`. */
export function addDays(key: string, n: number): string {
  const [year, month, day] = parts(key)
  return dayKey(new Date(year, month, day + n).getTime())
}

/** The local hour starting `hour` of a day (0-23). */
export function hourStart(key: string, hour: number): number {
  const [year, month, day] = parts(key)
  return new Date(year, month, day, hour).getTime()
}

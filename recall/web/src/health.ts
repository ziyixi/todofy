/**
 * The service status in the header's words (../../docs/design.md §8.3): the latest upload, or the device that stopped
 * uploading; each archive's sync, or how far it fell behind; storage near its budget. Problems in the warning color.
 * A device or an archive counts while it was heard from in the last 30 days (ops-v1's rule, §9), so a retired one
 * stops warning.
 */
import type { ServiceStatus } from '@ziyixi/proto/recall/ui/v1/status_pb'
import { el } from './dom.ts'
import { ago, ms, span } from './format.ts'

const WATCHED_MS = 30 * 86_400_000
const DAY_MS = 86_400_000
/** The database size past which the status warns (the Worker's STORAGE_HIGH_MIB, below its 900 MiB budget). */
export const STORAGE_HIGH_MIB = 850

/** The changes behind an archive are counted up to this (the Worker's BEHIND_COUNT_MAX). */
const BEHIND_COUNTED = 500

/** Changes behind an archive in words: `12 条`, `500+ 条` past the count. */
export function behindText(count: number): string {
  return count >= BEHIND_COUNTED ? `${String(BEHIND_COUNTED)}+ 条` : `${String(count)} 条`
}

/** A short consumer name (`nas`) reads as the acronym it is (`NAS`). */
export function consumerName(name: string): string {
  return /^[a-z0-9]{1,4}$/.test(name) ? name.toUpperCase() : name
}

/** An unarchived change older than this makes an archive late. */
export function late(oldestUnsynced: number | null, now: number): boolean {
  return oldestUnsynced !== null && now - oldestUnsynced > DAY_MS
}

/** The status line's parts. */
export function statusParts(status: ServiceStatus, now: number): HTMLElement[] {
  const quiet = (text: string) => el('span', {}, text)
  const problem = (text: string) => el('span', { class: 'problem' }, text)
  const watched = (at: number | null) => at !== null && now - at <= WATCHED_MS
  const parts: HTMLElement[] = []
  const stale = status.devices.filter((device) => device.stale && watched(ms(device.lastHeartbeatTime)))
  const latest = Math.max(...status.devices.map((device) => ms(device.lastHeartbeatTime) ?? 0))
  if (stale.length > 0) parts.push(...stale.map((device) => problem(`${device.label} ${span(now - (ms(device.lastHeartbeatTime) ?? now))}没有上传`)))
  else if (status.devices.length > 0) parts.push(quiet(`上传 ${ago(latest, now)}`))
  else parts.push(quiet('还没有上传'))
  for (const consumer of status.archiveConsumers.filter((item) => watched(ms(item.lastPullTime)))) {
    const name = consumerName(consumer.consumer)
    if (consumer.stale) parts.push(problem(`${name} ${span(now - (ms(consumer.lastPullTime) ?? now))}没有同步`))
    else if (late(ms(consumer.oldestUnsyncedTime), now)) parts.push(problem(`${name} 落后 ${behindText(consumer.behindCount)}`))
    else parts.push(quiet(consumer.behindCount === 0 ? `${name} 已同步` : `${name} 待同步 ${behindText(consumer.behindCount)}`))
  }
  if (status.storageUsedMib >= STORAGE_HIGH_MIB) parts.push(problem('存储接近上限'))
  return parts
}

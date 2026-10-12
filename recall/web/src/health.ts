/**
 * The service status in the header's words (../../docs/design.md §8.3): the latest connection, or the device that stopped
 * connecting; the Dropbox backup, not connected or how far it fell behind; storage near its budget. Problems in the
 * warning color, as ops-v1 raises them (§9): a device counts while it was heard from in the last 30 days, so a retired
 * one stops warning. Phones do not warn merely for being closed. The backup is late once a change has waited a day,
 * counted from the connection at the earliest.
 * The feed's own consumers are shown in 设置 only.
 */
import type { Timestamp } from '@ziyixi/proto/protobuf/wkt'
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

/** A change has waited for Dropbox more than a day, counted from the connection at the earliest (ops-v1's rule). */
export function backupLate(oldestPending: Timestamp | undefined, connected: Timestamp | undefined, now: number): boolean {
  const oldest = ms(oldestPending)
  return oldest !== null && late(Math.max(oldest, ms(connected) ?? oldest), now)
}

/** The status line's parts. */
export function statusParts(status: ServiceStatus, now: number): HTMLElement[] {
  const quiet = (text: string) => el('span', {}, text)
  const problem = (text: string) => el('span', { class: 'problem' }, text)
  const watched = (at: number | null) => at !== null && now - at <= WATCHED_MS
  const parts: HTMLElement[] = []
  const stale = status.devices.filter((device) => device.stale && !device.mobile && watched(ms(device.lastHeartbeatTime)))
  const latest = Math.max(...status.devices.map((device) => ms(device.lastHeartbeatTime) ?? 0))
  if (stale.length > 0) parts.push(...stale.map((device) => problem(`${device.label} ${span(now - (ms(device.lastHeartbeatTime) ?? now))}没有连接`)))
  else if (status.devices.length > 0) parts.push(quiet(`最近连接 ${ago(latest, now)}`))
  else parts.push(quiet('还没有设备连接'))
  const backup = status.dropboxBackup
  if (backup === undefined || !backup.connected) parts.push(problem('Dropbox 备份未连接'))
  else if (backupLate(backup.oldestPendingTime, backup.connectTime, now)) parts.push(problem(`Dropbox 落后 ${behindText(backup.pendingCount)}`))
  else parts.push(quiet(backup.pendingCount === 0 ? 'Dropbox 已备份' : `Dropbox 待备份 ${behindText(backup.pendingCount)}`))
  if (status.storageUsedMib >= STORAGE_HIGH_MIB) parts.push(problem('存储接近上限'))
  return parts
}

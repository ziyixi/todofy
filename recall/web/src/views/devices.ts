/** Connection display only: same-name installs fold together, while every historical identity stays separate. */
import type { DeviceStatus, ServiceStatus } from '@ziyixi/proto/recall/ui/v1/status_pb'
import type { ViewContext } from '../app.ts'
import { api } from '../api.ts'
import { card, disclosure } from '../components.ts'
import { button, el } from '../dom.ts'
import { ago, count, ms, span } from '../format.ts'
import { act } from './common.ts'

const DEVICE_ERRORS: Readonly<Record<string, readonly [string, boolean]>> = {
  outbox_full: ['扩展存储已满，新页面的内容没有保存：打开扩展的选项检查', true],
  capture_failed: ['有页面的正文没读到（页面不让扩展读取时会这样）', false],
  screenshot_failed: ['有页面的截图没保存，已读取的正文仍会保存', false],
  upload_failed: ['上传失败过，扩展会自动重试', false],
  page_probe_invalid_result: ['有页面的状态探测失败，部分采集可能跳过', false],
}
const REFUSALS: Readonly<Record<string, string>> = { invalid_item: '格式不对', id_conflict: '编号冲突' }

export function devicesCard(ctx: ViewContext, status: ServiceStatus, now: number): HTMLElement {
  const groups = new Map<string, DeviceStatus[]>()
  for (const device of [...status.devices].sort((a, b) => (ms(b.lastHeartbeatTime) ?? 0) - (ms(a.lastHeartbeatTime) ?? 0))) {
    const label = device.label || '未命名连接'
    const group = groups.get(label) ?? []
    group.push(device)
    groups.set(label, group)
  }
  const box = card('设备', groups.size === 0 ? '' : `${String(groups.size)} 组 · ${String(status.devices.length)} 条连接`)
  const remove = (id: string) => {
    box.replaceWith(devicesCard(ctx, { ...status, devices: status.devices.filter((device) => device.deviceId !== id) }, now))
  }
  if (groups.size === 0) {
    box.append(el('p', {}, '还没有设备连接。连上一台：'), el('ol', { class: 'steps' },
      el('li', {}, '在下面的 插件口令 填写名称，点 添加口令 并复制'),
      el('li', {}, '在浏览器中加载 Recall 扩展，打开扩展的设置'),
      el('li', {}, '粘贴口令，填写设备名并保存'),
    ))
  } else {
    box.append(el('ul', { class: 'rows device-groups' }, ...[...groups.values()].map(([latest, ...previous]) => {
      const row = deviceRow(ctx, latest!, now, remove)
      if (previous.length > 0) row.append(disclosure(`同名旧连接（${String(previous.length)}）`,
        el('ul', { class: 'rows device-history' }, ...previous.map((device) => deviceRow(ctx, device, now, remove))),
      ))
      return row
    })))
    box.append(el('p', { class: 'hint' }, '同名连接只折叠显示，不合并设备。旧电脑的访问记录仍可查看；仅可移除无记录且没有待上传内容的连接。'))
  }
  box.append(el('p', { class: 'hint' }, '连接成功可能只是心跳；实际记录见时间线。'))
  for (const item of status.rejectedItems) {
    box.append(item.reason === 'unsupported_item'
      ? el('p', { class: 'hint', role: 'note' }, `7 天内有 ${String(item.count)} 条记录来自比 recall 新的扩展，正在扩展里等 recall 更新后再上传`)
      : el('p', { class: 'hint warn', role: 'note', title: item.reason }, `7 天内有 ${String(item.count)} 条上传被拒（${REFUSALS[item.reason] ?? '其他原因'}），已丢失：扩展可能有问题`))
  }
  return box
}

function deviceRow(ctx: ViewContext, device: DeviceStatus, now: number, removed: (id: string) => void): HTMLLIElement {
  const heard = ms(device.lastHeartbeatTime)
  const stale = device.stale && !device.mobile
  const [error, urgent] = device.lastErrorCode === '' ? ['', false] : (DEVICE_ERRORS[device.lastErrorCode] ?? ['扩展报告了一个错误', false])
  const href = `/?device=${encodeURIComponent(device.deviceId)}`
  const visits = el('a', { href, class: 'small' }, '访问记录')
  visits.addEventListener('click', (event) => { event.preventDefault(); void ctx.go(href) })
  const actions = el('div', { class: 'device-actions' }, visits)
  if (device.hasRecords === false && device.queuedCount === 0) {
    const clear = button('移除空连接', () => {
      if (!ctx.host.confirm('移除这个没有记录的连接？口令不变；扩展再次连接时会重新出现。')) return
      clear.disabled = true
      void act((requestId) => api.deleteDevice({ name: `devices/${device.deviceId}`, requestId }), '已移除空连接', () => removed(device.deviceId))
        .finally(() => { clear.disabled = false })
    }, { class: 'quiet small', 'aria-label': `移除空连接 ${device.label} ${device.extensionVersion}` })
    actions.append(clear)
  }
  return el('li', {},
    el('div', { class: 'row-head' }, el('span', { class: 'row-title' }, device.label || '未命名连接'),
      el('span', { class: stale ? 'meta warn' : 'meta' }, `最近连接 ${heard === null ? '—' : ago(heard, now)}`)),
    stale ? el('p', { class: 'hint warn' }, '检查 Chrome 是否开着、扩展是否启用（开发者模式）') : null,
    device.mobile ? el('p', { class: 'hint' }, '手机仅在浏览器前台运行，打开后继续采集和上传。') : null,
    error === '' ? null : el('p', { class: urgent ? 'hint warn' : 'hint', title: device.lastErrorCode }, error),
    el('p', { class: 'facts' }, el('span', {}, `版本 ${device.extensionVersion}`), el('span', {}, `待上传 ${count(device.queuedCount)}`),
      device.clockSkewSeconds === 0 ? null : el('span', { class: 'warn' }, `时钟差 ${span(device.clockSkewSeconds * 1000)}`)),
    actions,
  )
}

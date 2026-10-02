// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { create } from '@ziyixi/proto/protobuf'
import { Code } from '@ziyixi/proto/rpc-status'
import { SummarizeDeliveryAttemptsRequest_Granularity, SummarizeDeliveryAttemptsResponseSchema, type SummarizeDeliveryAttemptsResponse } from '@ziyixi/proto/mailhero/ui/v2/mail_hero_ui_service_pb'
import { timeOf, timestamp } from '../api/client'
import { installFakeServer, rpcError, type FakeServer } from '../test/fakeServer'
import { overview, renderAt } from '../test/fixtures'
import DashboardPage from './DashboardPage'

// The browser zone drives the windows and labels: pin it and the clock.
beforeAll(() => { vi.stubEnv('TZ', 'America/Los_Angeles') })
afterAll(() => { vi.unstubAllEnvs() })
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); vi.stubEnv('TZ', 'America/Los_Angeles') })

const zone = 'America/Los_Angeles'
// 2026-11-03 12:00 PST: the last seven local days include the 25-hour 1 November.
const now = new Date('2026-11-03T20:00:00.000Z')

/** A summary as the test writes it: ISO instants and the four counts. */
interface Counts { succeeded: number; retried: number; failed: number; unknown: number }
interface Stats { from: string; to: string; bucket: 'hour' | 'day'; time_zone: string; totals: Counts; buckets: Array<Counts & { start: string; end: string }> }
const sample: Stats = {
  from: '2026-10-31T07:00:00.000Z', to: '2026-11-03T08:00:00.000Z', bucket: 'day', time_zone: zone,
  totals: { succeeded: 3, retried: 1, failed: 1, unknown: 1 },
  buckets: [
    { start: '2026-10-31T07:00:00.000Z', end: '2026-11-01T07:00:00.000Z', succeeded: 1, retried: 0, failed: 0, unknown: 0 },
    { start: '2026-11-01T07:00:00.000Z', end: '2026-11-02T08:00:00.000Z', succeeded: 2, retried: 1, failed: 1, unknown: 1 },
    { start: '2026-11-02T08:00:00.000Z', end: '2026-11-03T08:00:00.000Z', succeeded: 0, retried: 0, failed: 0, unknown: 0 },
  ],
}
const countsOf = (value: Counts) => ({ succeededCount: value.succeeded, retriedCount: value.retried, failedCount: value.failed, unknownCount: value.unknown })
/** `stats` as the Worker answers it. */
function answerOf(stats: Stats): SummarizeDeliveryAttemptsResponse {
  return create(SummarizeDeliveryAttemptsResponseSchema, { startTime: timestamp(stats.from), endTime: timestamp(stats.to), timeZone: stats.time_zone,
    granularity: stats.bucket === 'hour' ? SummarizeDeliveryAttemptsRequest_Granularity.HOUR : SummarizeDeliveryAttemptsRequest_Granularity.DAY,
    totals: countsOf(stats.totals), buckets: stats.buckets.map(item => ({ startTime: timestamp(item.start), endTime: timestamp(item.end), counts: countsOf(item) })) })
}
/** A SummarizeDeliveryAttempts request as the window it asks for. */
interface Window { from: string; to: string; bucket: string; tz: string }
function windowOf(request: Record<string, unknown>): Window {
  return { from: timeOf(request['startTime'] as never) ?? '', to: timeOf(request['endTime'] as never) ?? '',
    bucket: request['granularity'] === SummarizeDeliveryAttemptsRequest_Granularity.HOUR ? 'hour' : 'day', tz: request['timeZone'] as string }
}

let fake: FakeServer
function open(stats: Stats | ((window: Window) => Promise<Stats>) = sample) {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(now)
  fake = installFakeServer({ overview: overview({ failedDeliveryCount: 2 }) })
  fake.answer.summarizeDeliveryAttempts = async request => answerOf(typeof stats === 'function' ? await stats(windowOf(request as never)) : stats)
  return renderAt(<DashboardPage/>, '/dashboard')
}
const linkRange = (name: RegExp) => {
  const search = new URLSearchParams(screen.getByRole('link', { name }).getAttribute('href')!.split('?')[1])
  return [search.get('from'), search.get('to')]
}
const windows = () => fake.callsOf('summarizeDeliveryAttempts').map(windowOf)
const lastWindow = () => windows().at(-1)

it('labels everything in the browser zone and drills down to each bucket end from the API', async () => {
  const { container } = open()
  expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(zone)
  const successful = await screen.findByRole('link', { name: '查看此区间成功的投递事件' })
  expect(successful.getAttribute('href')).toContain('attempt_outcome=succeeded')
  expect(successful.getAttribute('href')).toContain('from=2026-10-31T07%3A00%3A00.000Z')
  expect(screen.getByText(`时间按浏览器时区 ${zone}（PST）`)).toBeTruthy()
  expect(screen.getByText(/^当前区间：/).textContent).toBe('当前区间：2026/10/28 00:00 PDT 至 2026/11/03 12:00 PST（不含结束时刻）')
  expect(screen.getByText('最近 7 天')).toBeTruthy()
  expect(screen.getByRole('status').textContent).toContain('另有 1 次尝试结果不明')
  expect(screen.getByRole('img', { name: /每个时段的精确值见下方明细表/ })).toBeTruthy()
  expect(screen.getByRole('link', { name: /查看当前失败事件/ }).getAttribute('href')).toBe('/deliveries?status=failed')
  fireEvent.click(screen.getByText('查看每个时段的准确数量'))
  expect(screen.getByRole('table', { name: /按浏览器时区时段统计/ })).toBeTruthy()
  expect(screen.getByRole('rowheader', { name: '2026/11/1' })).toBeTruthy()
  // 1 November lasts 25 hours: the drill-down ends at the API's end, not start + 24 h.
  expect(linkRange(/^2026\/11\/1 成功 2 次/)).toEqual(['2026-11-01T07:00:00.000Z', '2026-11-02T08:00:00.000Z'])
  expect(linkRange(/^2026\/10\/31 成功 1 次/)).toEqual(['2026-10-31T07:00:00.000Z', '2026-11-01T07:00:00.000Z'])
  expect(container.innerHTML).not.toContain('UTC')
})

it('builds the preset windows from local midnights and sends the browser zone', async () => {
  open()
  await screen.findByText('投递趋势')
  expect(lastWindow()).toEqual({ from: '2026-10-28T07:00:00.000Z', to: '2026-11-03T20:00:00.000Z', bucket: 'day', tz: zone })
  fireEvent.click(screen.getByRole('button', { name: '最近 30 天' }))
  await waitFor(() => expect(lastWindow()).toEqual({ from: '2026-10-05T07:00:00.000Z', to: '2026-11-03T20:00:00.000Z', bucket: 'day', tz: zone }))
  fireEvent.click(screen.getByRole('button', { name: '最近 24 小时' }))
  await waitFor(() => expect(lastWindow()).toEqual({ from: '2026-11-02T20:00:00.000Z', to: '2026-11-03T20:00:00.000Z', bucket: 'hour', tz: zone }))
})

it('turns inclusive local dates into local midnights with an exact exclusive end, at most 90 days', async () => {
  const { container } = open()
  await screen.findByText('投递趋势')
  fireEvent.click(screen.getByRole('button', { name: '自选日期' }))
  expect((screen.getByLabelText('开始日期') as HTMLInputElement).value).toBe('2026-10-28')
  expect((screen.getByLabelText('结束日期（含）') as HTMLInputElement).value).toBe('2026-11-03')
  const apply = async (from: string, last: string, expected: Record<string, string>) => {
    fireEvent.change(screen.getByLabelText('开始日期'), { target: { value: from } })
    fireEvent.change(screen.getByLabelText('结束日期（含）'), { target: { value: last } })
    fireEvent.click(screen.getByRole('button', { name: '应用日期' }))
    await waitFor(() => expect(lastWindow()).toEqual({ ...expected, bucket: 'day', tz: zone }))
  }
  await apply('2026-10-31', '2026-11-02', { from: '2026-10-31T07:00:00.000Z', to: '2026-11-03T08:00:00.000Z' })
  expect(screen.getByText(/^当前区间：/).textContent).toBe('当前区间：2026/10/31 00:00 PDT 至 2026/11/03 00:00 PST（不含结束时刻）')
  await apply('2026-03-07', '2026-03-08', { from: '2026-03-07T08:00:00.000Z', to: '2026-03-09T07:00:00.000Z' })
  await apply('2026-09-01', '2026-11-29', { from: '2026-09-01T07:00:00.000Z', to: '2026-11-30T08:00:00.000Z' })
  fireEvent.change(screen.getByLabelText('结束日期（含）'), { target: { value: '2026-11-30' } })
  expect(screen.getByRole('alert').textContent).toContain('一次最多查看 90 天')
  expect((screen.getByRole('button', { name: '应用日期' }) as HTMLButtonElement).disabled).toBe(true)
  expect(container.innerHTML).not.toContain('UTC')
})

it('labels the repeated fall-back 01:00 hour rows PDT and PST, each with its own drill-down', async () => {
  const counts = (succeeded: number, retried = 0) => ({ succeeded, retried, failed: 0, unknown: 0 })
  open({
    from: '2026-11-01T07:00:00.000Z', to: '2026-11-01T11:00:00.000Z', bucket: 'hour', time_zone: zone, totals: counts(3, 1),
    buckets: [
      { start: '2026-11-01T07:00:00.000Z', end: '2026-11-01T08:00:00.000Z', ...counts(0) },
      { start: '2026-11-01T08:00:00.000Z', end: '2026-11-01T09:00:00.000Z', ...counts(2) },
      { start: '2026-11-01T09:00:00.000Z', end: '2026-11-01T10:00:00.000Z', ...counts(1, 1) },
      { start: '2026-11-01T10:00:00.000Z', end: '2026-11-01T11:00:00.000Z', ...counts(0) },
    ],
  })
  await screen.findByText('投递趋势')
  fireEvent.click(screen.getByText('查看每个时段的准确数量'))
  expect(screen.getAllByRole('rowheader').map(row => row.textContent)).toEqual(['2026/11/1 00时 PDT', '2026/11/1 01时 PDT', '2026/11/1 01时 PST', '2026/11/1 02时 PST'])
  expect(screen.getByRole('columnheader', { name: `时段（${zone}）` })).toBeTruthy()
  const first = screen.getByRole('link', { name: /^2026\/11\/1 01时 PDT 成功 2 次/ }), second = screen.getByRole('link', { name: /^2026\/11\/1 01时 PST 成功 1 次/ })
  expect(first.getAttribute('href')).not.toBe(second.getAttribute('href'))
  expect(linkRange(/^2026\/11\/1 01时 PDT 成功 2 次/)).toEqual(['2026-11-01T08:00:00.000Z', '2026-11-01T09:00:00.000Z'])
  expect(linkRange(/^2026\/11\/1 01时 PST 成功 1 次/)).toEqual(['2026-11-01T09:00:00.000Z', '2026-11-01T10:00:00.000Z'])
})

it('reads the browser zone again for each window and labels rows in the zone the API bucketed in', async () => {
  const newYork: Stats = {
    ...sample, from: '2026-10-05T04:00:00.000Z', to: now.toISOString(), time_zone: 'America/New_York',
    buckets: [{ start: '2026-11-01T04:00:00.000Z', end: '2026-11-02T05:00:00.000Z', succeeded: 3, retried: 1, failed: 1, unknown: 1 }],
  }
  const view = open(async params => params.tz === 'America/New_York' ? newYork : sample)
  await screen.findByText('投递趋势')
  // The OS zone changes under an open tab (travel, automatic time zone).
  vi.stubEnv('TZ', 'America/New_York')
  fireEvent.click(screen.getByRole('button', { name: '最近 30 天' }))
  await waitFor(() => expect(lastWindow()).toEqual({ from: '2026-10-05T04:00:00.000Z', to: now.toISOString(), bucket: 'day', tz: 'America/New_York' }))
  await screen.findByRole('rowheader', { name: '2026/11/1' })
  expect(screen.getByText(/^时间按浏览器时区/).textContent).toBe('时间按浏览器时区 America/New_York（EST）')
  expect(screen.getByText(/^当前区间：/).textContent).toBe('当前区间：2026/10/05 00:00 EDT 至 2026/11/03 15:00 EST（不含结束时刻）')
  // Back in Los Angeles without a new window: labels still follow the response's zone.
  vi.stubEnv('TZ', 'America/Los_Angeles')
  view.renderAgain()
  expect(screen.getByRole('rowheader', { name: '2026/11/1' })).toBeTruthy()
  expect(screen.getByText(/^当前区间：/).textContent).toBe('当前区间：2026/10/05 00:00 EDT 至 2026/11/03 15:00 EST（不含结束时刻）')
})

it('uses UTC windows and says so when the browser reports a zone the Worker would refuse', async () => {
  const resolved = Intl.DateTimeFormat.prototype.resolvedOptions
  for (const reported of ['Etc/Unknown', '+03:00', '']) {
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(function (this: Intl.DateTimeFormat) { return { ...resolved.call(this), timeZone: reported } })
    const { container } = open(async params => ({ ...sample, from: params.from, to: params.to, time_zone: params.tz }))
    await screen.findByText('投递趋势')
    expect(lastWindow()).toEqual({ from: '2026-10-28T00:00:00.000Z', to: now.toISOString(), bucket: 'day', tz: 'UTC' })
    expect(screen.getByText(/^浏览器时区无法用于统计/).textContent).toBe('浏览器时区无法用于统计，时间按 UTC 显示')
    expect(screen.getByText(/^当前区间：/).textContent).toBe('当前区间：2026/10/28 00:00 UTC 至 2026/11/03 20:00 UTC（不含结束时刻）')
    expect(screen.getByRole('table', { name: /按 UTC 时段统计/ })).toBeTruthy()
    expect(container.innerHTML).not.toContain(reported || 'America/Los_Angeles')
    cleanup(); vi.restoreAllMocks()
  }
})

it('switches to UTC windows, without an error screen, when the Worker refuses the browser zone', async () => {
  let refusals = 0
  open(async params => {
    if (params.tz !== 'UTC') { refusals++; throw rpcError(Code.INVALID_ARGUMENT, 'INVALID_TIME_ZONE') }
    return { ...sample, from: params.from, to: params.to, time_zone: 'UTC' }
  })
  await screen.findByText('投递趋势')
  expect(refusals).toBe(1)
  expect(windows()).toEqual([
    { from: '2026-10-28T07:00:00.000Z', to: now.toISOString(), bucket: 'day', tz: zone },
    { from: '2026-10-28T00:00:00.000Z', to: now.toISOString(), bucket: 'day', tz: 'UTC' },
  ])
  expect(screen.queryByText('无法加载内容')).toBeNull()
  expect(screen.getByText(/^浏览器时区无法用于统计/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '最近 30 天' }))
  await waitFor(() => expect(lastWindow()).toEqual({ from: '2026-10-05T00:00:00.000Z', to: now.toISOString(), bucket: 'day', tz: 'UTC' }))
  expect(refusals).toBe(1)
})

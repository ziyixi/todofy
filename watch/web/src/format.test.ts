import { timestampFromMs } from '@ziyixi/proto/protobuf/wkt'
import { FailureReason, Watch_PauseReason, Watch_State } from '@ziyixi/proto/watch/ui/v1/watch_pb'
import { failureText, healthGroup, hostOf, relative, sharedUrl, values, watchState, when } from './format.ts'
import { watch } from './test/fakeServer.ts'

const NOW = Date.parse('2026-10-01T08:00:00Z')

describe('format', () => {
  it('reads the add-from-phone fragment, and nothing malformed', () => {
    expect(sharedUrl(`#u=${encodeURIComponent('https://a.example.com/x?y=1&z=2')}`)).toBe('https://a.example.com/x?y=1&z=2')
    expect(sharedUrl('#x=1&u=https%3A%2F%2Fb.example.com')).toBe('https://b.example.com')
    expect(sharedUrl('#u=%E0%A4%A')).toBe('')
    expect(sharedUrl('')).toBe('')
  })

  it('says times in the browser zone and relative to now', () => {
    expect(when(timestampFromMs(NOW))).toBe('10-01 16:00')
    expect(relative(timestampFromMs(NOW - 3 * 60_000), NOW)).toBe('3 分钟前')
    expect(relative(timestampFromMs(NOW + 5 * 3_600_000), NOW)).toBe('5 小时后')
    expect(relative(undefined, NOW)).toBe('—')
  })

  it('names failures as what failed, never as no change; groups the health view', () => {
    expect(failureText(FailureReason.HTTP_ERROR, 404)).toBe('网站返回错误（HTTP 404）')
    expect(failureText(FailureReason.JS_QUOTA_EXHAUSTED)).toBe('今日 JS 配额已用完')
    expect(watchState({ state: Watch_State.PAUSED, pauseReason: Watch_PauseReason.BROKEN_TOO_LONG }).label).toBe('失效太久，已暂停')
    expect(healthGroup(watch('a', { state: Watch_State.BROKEN }))).toBe('broken')
    expect(healthGroup(watch('a', { health: { lastFailure: FailureReason.ROBOTS_DISALLOWED } }))).toBe('robots')
    expect(healthGroup(watch('a'))).toBeNull()
    expect(values({ previousValue: '', currentValue: 'InStock' })).toBe('（无） → InStock')
    expect(hostOf('https://x.example.com:8443/a')).toBe('x.example.com:8443')
  })
})

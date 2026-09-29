import { describe, expect, it } from 'vitest'
import { eventDetail } from '../test/fixtures'
import { EVENT_POLL_MAX_MS, EVENT_POLL_MS, eventPollInterval } from './queries'

describe('eventPollInterval', () => {
  const now = Date.parse('2026-09-28T12:00:00Z')

  it('polls while a call is in flight or the next step is due within a minute', () => {
    expect(eventPollInterval(eventDetail({ state: 'todo_sending', next_attempt_at: null }), now)).toBe(EVENT_POLL_MS)
    expect(eventPollInterval(eventDetail({ state: 'todo_unknown', next_attempt_at: '2026-09-28T12:00:30Z' }), now)).toBe(
      EVENT_POLL_MS,
    )
  })

  it('stays quiet for settled events and distant retries', () => {
    expect(eventPollInterval(undefined, now)).toBe(false)
    expect(eventPollInterval(eventDetail({ state: 'complete', next_attempt_at: null }), now)).toBe(false)
    expect(eventPollInterval(eventDetail({ state: 'pending', next_attempt_at: '2026-09-28T13:00:00Z' }), now)).toBe(false)
  })

  it('keeps polling a row that just became due', () => {
    expect(eventPollInterval(eventDetail({ state: 'pending', next_attempt_at: '2026-09-28T11:59:55Z' }), now)).toBe(
      EVENT_POLL_MS,
    )
  })

  it('stops for a row that stays overdue (a pause, a Todoist block or a backlog)', () => {
    expect(eventPollInterval(eventDetail({ state: 'summarized', next_attempt_at: '2026-09-28T11:50:00Z' }), now)).toBe(
      false,
    )
    expect(eventPollInterval(eventDetail({ state: 'pending', next_attempt_at: '2026-09-27T12:00:00Z' }), now)).toBe(false)
  })

  it('stops once the shown version has not changed for a while, even mid-call', () => {
    const stuck = eventDetail({ state: 'summarizing', next_attempt_at: null })
    expect(eventPollInterval(stuck, now, now - EVENT_POLL_MAX_MS + 1000)).toBe(EVENT_POLL_MS)
    expect(eventPollInterval(stuck, now, now - EVENT_POLL_MAX_MS - 1000)).toBe(false)
  })
})

import { MailEventSchema } from '@ziyixi/proto/todofy/ui/v1/mail_event_pb'
import type { MailEvent } from '@ziyixi/proto/todofy/ui/v1/mail_event_wire'
import { describe, expect, it } from 'vitest'
import { eventDetail, message } from '../test/fixtures'
import { EVENT_POLL_MAX_MS, EVENT_POLL_MS, eventPollInterval } from './queries'

/** An event as the client hands it to the page. */
function event(patch: Partial<MailEvent>) {
  return message(MailEventSchema, eventDetail(patch))
}

describe('eventPollInterval', () => {
  const now = Date.parse('2026-09-28T12:00:00Z')

  it('polls while a call is in flight or the next step is due within a minute', () => {
    expect(eventPollInterval(event({ state: 'todo_sending' }), now)).toBe(EVENT_POLL_MS)
    expect(eventPollInterval(event({ state: 'todo_unknown', next_attempt_time: '2026-09-28T12:00:30Z' }), now)).toBe(EVENT_POLL_MS)
  })

  it('stays quiet for settled events and distant retries', () => {
    expect(eventPollInterval(undefined, now)).toBe(false)
    expect(eventPollInterval(event({ state: 'complete' }), now)).toBe(false)
    expect(eventPollInterval(event({ state: 'pending', next_attempt_time: '2026-09-28T13:00:00Z' }), now)).toBe(false)
  })

  it('keeps polling a row that just became due', () => {
    expect(eventPollInterval(event({ state: 'pending', next_attempt_time: '2026-09-28T11:59:55Z' }), now)).toBe(EVENT_POLL_MS)
  })

  it('stops for a row that stays overdue (a pause, a Todoist block or a backlog)', () => {
    expect(eventPollInterval(event({ state: 'summarized', next_attempt_time: '2026-09-28T11:50:00Z' }), now)).toBe(false)
    expect(eventPollInterval(event({ state: 'pending', next_attempt_time: '2026-09-27T12:00:00Z' }), now)).toBe(false)
  })

  it('stops once the shown etag has not changed for a while, even mid-call', () => {
    const stuck = event({ state: 'summarizing' })
    expect(eventPollInterval(stuck, now, now - EVENT_POLL_MAX_MS + 1000)).toBe(EVENT_POLL_MS)
    expect(eventPollInterval(stuck, now, now - EVENT_POLL_MAX_MS - 1000)).toBe(false)
  })
})

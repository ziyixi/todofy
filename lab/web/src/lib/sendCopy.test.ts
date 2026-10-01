import { sendStatus } from '../test/fixtures'
import { isDelivered, isLocked, sendCopy } from './sendCopy'

describe('send status copy (docs/ux.md §5)', () => {
  it.each([
    [sendStatus({ state: 'sending', next_poll_time: '2026-09-30T12:00:03Z' }), '正在发送…', []],
    [sendStatus({ state: 'pending', total_task_count: 6, created_task_count: 3 }), 'Todofy 正在创建：3 / 6', []],
    [sendStatus({ state: 'created', total_task_count: 6, created_task_count: 6 }), '已发送：Todoist 里新增了 6 个任务', ['done']],
    [sendStatus({ state: 'duplicate' }), '这组已经发送过，不会重复创建', ['done']],
    [
      sendStatus({ state: 'paused', recorded: false, frozen: false, error_code: 'todoist_paused' }),
      'Todofy 暂停中（Todoist 已暂停），这次没有发送',
      ['resend'],
    ],
    [sendStatus({ state: 'paused', recorded: true, error_code: 'maintenance' }), '已交给 Todofy，等它恢复后会自动创建（Todofy 维护中）', ['done']],
    [sendStatus({ state: 'failed', total_task_count: 6, created_task_count: 4 }), '部分失败：已创建 4 / 6', ['retry', 'later']],
    // Nothing created is not a "partial" failure.
    [
      sendStatus({ state: 'failed', total_task_count: 3, created_task_count: 0, error_code: 'todoist_rejected' }),
      '发送失败：没有创建任务（Todoist 拒绝了请求）',
      ['retry', 'later'],
    ],
    // A retry Todofy held because it is paused: nothing was retried, and the copy says so.
    [
      sendStatus({ state: 'failed', total_task_count: 3, created_task_count: 1, error_code: 'todoist_paused' }),
      'Todofy 暂停中（Todoist 已暂停），这次重试没有进行：已创建 1 / 3，恢复后再重试',
      ['retry', 'later'],
    ],
    [sendStatus({ state: 'rejected', recorded: false, frozen: false, error_code: 'daily_limit' }), '没有发送：今天发送次数已达上限', ['back']],
    [sendStatus({ state: 'unknown' }), '结果未知：重试不会重复创建', ['retry', 'later']],
    // A state a newer Worker sends and this build does not know reads as unset: neither success nor failure.
    [sendStatus({ state: undefined }), '状态未知，稍后刷新', ['later']],
  ] as const)('%#: %s', (status, text, actions) => {
    const copy = sendCopy(status)
    expect(copy.text).toBe(text)
    expect(copy.actions).toEqual(actions)
  })

  it('locks only an open frozen send', () => {
    expect(isLocked(null)).toBe(false)
    expect(isLocked(sendStatus({ state: 'failed' }))).toBe(true)
    expect(isLocked(sendStatus({ state: 'created' }))).toBe(false)
    expect(isLocked(sendStatus({ state: 'rejected', frozen: false, recorded: false }))).toBe(false)
    expect(isDelivered(sendStatus({ state: 'duplicate' }))).toBe(true)
  })
})

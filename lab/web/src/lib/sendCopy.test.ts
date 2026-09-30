import { sendStatus } from '../test/fixtures'
import { isDelivered, isLocked, sendCopy } from './sendCopy'

describe('send status copy (docs/ux.md §5)', () => {
  it.each([
    [sendStatus({ state: 'sending', poll_after: 'x' }), '正在发送…', []],
    [sendStatus({ state: 'pending', tasks_total: 6, tasks_created: 3 }), 'Todofy 正在创建：3 / 6', []],
    [sendStatus({ state: 'created', tasks_total: 6, tasks_created: 6 }), '已发送：Todoist 里新增了 6 个任务', ['done']],
    [sendStatus({ state: 'duplicate' }), '这组已经发送过，不会重复创建', ['done']],
    [
      sendStatus({ state: 'paused', recorded: false, frozen: false, error_code: 'todoist_paused' }),
      'Todofy 暂停中（Todoist 已暂停），这次没有发送',
      ['resend'],
    ],
    [sendStatus({ state: 'paused', recorded: true, error_code: 'maintenance' }), '已交给 Todofy，等它恢复后会自动创建（Todofy 维护中）', ['done']],
    [sendStatus({ state: 'failed', tasks_total: 6, tasks_created: 4 }), '部分失败：已创建 4 / 6', ['retry']],
    [sendStatus({ state: 'rejected', recorded: false, frozen: false, error_code: 'daily_limit' }), '没有发送：今天发送次数已达上限', ['back']],
    [sendStatus({ state: 'unknown' }), '结果未知：重试不会重复创建', ['retry']],
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

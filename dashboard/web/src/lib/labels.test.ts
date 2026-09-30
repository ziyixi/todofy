import { QUOTA_RESOURCES } from '../../../worker/src/api-types.ts'
import {
  QUOTA,
  canaryCodeLabel,
  counterInfo,
  counterShort,
  counterValue,
  deferredJobLabel,
  guardReasonLabel,
  modeInfo,
  signalLabel,
  usageErrorLabel,
} from './labels'
import mailHeroDegraded from '../../../../contracts/ops-v1/fixtures/OpsStatus/mail-hero-degraded.json'
import todofyDegraded from '../../../../contracts/ops-v1/fixtures/OpsStatus/todofy-degraded.json'
import mailHeroOk from '../../../../contracts/ops-v1/fixtures/OpsStatus/mail-hero-ok.json'
import todofyOk from '../../../../contracts/ops-v1/fixtures/OpsStatus/todofy-ok.json'
import labDegraded from '../../../../contracts/ops-v1/fixtures/OpsStatus/lab-degraded.json'
import labOk from '../../../../contracts/ops-v1/fixtures/OpsStatus/lab-ok.json'
import report from '../../../../contracts/ops-v1/fixtures/OpsReport/daily.json'

describe('labels', () => {
  it('names every quota resource', () => {
    for (const id of QUOTA_RESOURCES) expect(QUOTA[id]).toBeTruthy()
    expect(signalLabel('d1_rows_read_high')).toBe('D1 读取行数用量高')
    expect(signalLabel('ai_neurons_high')).toBe('Workers AI neurons 用量高')
    expect(guardReasonLabel('quota_r2_class_a')).toBe('配额：R2 A 类操作')
  })

  it('labels every code in the contract fixtures', () => {
    const signals = [...mailHeroDegraded.signals, ...todofyDegraded.signals, ...labDegraded.signals].map((signal) => signal.code)
    for (const code of [...signals, ...report.items.map((item) => item.code)]) expect(signalLabel(code)).not.toBe(code)
    const counters = [mailHeroOk, todofyOk, labOk].flatMap((status) => Object.keys(status.counters))
    for (const name of counters) expect(counterInfo(name).label).not.toBe(name)
    const modes = [mailHeroOk, todofyOk, labOk].flatMap((status) => Object.keys(status.modes))
    for (const name of modes) expect(modeInfo(name, false).label).not.toBe(name)
  })

  it('shows the GTD counters in their units', () => {
    expect(counterInfo('inbox_oldest_days')).toEqual({ label: '收件箱最老', kind: 'days' })
    expect(counterValue('review_age_days', 12)).toBe('12 天')
    expect(counterShort('inbox_open', 23)).toBe('收件箱开放 23')
    expect(signalLabel('review_overdue')).toBe('每周回顾已超过 10 天')
    expect(deferredJobLabel('gtd_snapshot')).toBe('GTD 每日快照')
  })

  it('labels the task-intent counters of Todofy and the deferred jobs of Lab', () => {
    expect(counterInfo('intents_pending').label).toBe('待创建的任务提议')
    expect(counterInfo('intents_failed_7d').label).toBe('近 7 天失败的任务提议')
    for (const job of labDegraded.guard.deferred) expect(deferredJobLabel(job)).not.toBe(job)
  })

  it('keeps unknown codes raw', () => {
    expect(signalLabel('brand_new')).toBe('brand_new')
    expect(signalLabel('toString')).toBe('toString')
    expect(guardReasonLabel('d1_reads_high')).toBe('d1_reads_high')
    expect(canaryCodeLabel('llm_new_code')).toBe('llm_new_code')
    expect(counterInfo('__proto__')).toEqual({ label: '__proto__', kind: 'count' })
  })

  it('marks unusual modes', () => {
    expect(modeInfo('forwarding', false).usual).toBe(false)
    expect(modeInfo('forwarding', true).usual).toBe(true)
    expect(modeInfo('maintenance', true).usual).toBe(false)
    expect(modeInfo('unknown_flag', true).usual).toBe(false)
  })

  it('explains usage and canary errors', () => {
    expect(usageErrorLabel('http_401')).toBe('HTTP 401：令牌无效或权限不足')
    expect(usageErrorLabel('http_500')).toBe('HTTP 500')
    expect(usageErrorLabel('graphql_error')).toBe('GraphQL 返回错误')
    expect(canaryCodeLabel('http_503')).toBe('HTTP 503')
    expect(canaryCodeLabel('canary_consumer_missing')).toBe('Todofy 未提供金丝雀功能')
    expect(canaryCodeLabel('canary_disabled')).toBe('金丝雀已关闭，未再尝试启动')
  })
})

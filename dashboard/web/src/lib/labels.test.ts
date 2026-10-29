import { QuotaResource, QuotaResourceSchema } from '@ziyixi/proto/dashboard/ui/v1/usage_pb'
import { wireEnum } from '@ziyixi/proto/wire-json'
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
import { alertGuidance } from './alert-guidance'
import mailHeroDegraded from '../../../../contracts/ops-v1/fixtures/OpsStatus/mail-hero-degraded.json'
import todofyDegraded from '../../../../contracts/ops-v1/fixtures/OpsStatus/todofy-degraded.json'
import mailHeroOk from '../../../../contracts/ops-v1/fixtures/OpsStatus/mail-hero-ok.json'
import todofyOk from '../../../../contracts/ops-v1/fixtures/OpsStatus/todofy-ok.json'
import watchDegraded from '../../../../contracts/ops-v1/fixtures/OpsStatus/watch-degraded.json'
import watchOk from '../../../../contracts/ops-v1/fixtures/OpsStatus/watch-ok.json'
import recallDegraded from '../../../../contracts/ops-v1/fixtures/OpsStatus/recall-degraded.json'
import recallOk from '../../../../contracts/ops-v1/fixtures/OpsStatus/recall-ok.json'
import tasksOk from '../../../../contracts/ops-v1/fixtures/OpsStatus/tasks-ok.json'
import shedWatch from '../../../../contracts/ops-v1/fixtures/GuardState/shed-watch.json'

/** Every quota of the IDL (Usage.rows), read from the descriptors. */
const QUOTA_RESOURCES = wireEnum(QuotaResourceSchema, QuotaResource).names

describe('labels', () => {
  it('names unconfirmed model execution and points to its request record', () => {
    expect(signalLabel('model_execution_unknown')).toBe('推理结果待核对')
    const guidance = alertGuidance('model_execution_unknown', 'model-router')
    expect(guidance.explanation).toContain('15 分钟')
    expect(guidance.next).toContain('Model Router')
    expect(guidance.next).toContain('对应请求')
  })
  it('names every quota resource', () => {
    for (const id of QUOTA_RESOURCES) expect(QUOTA[id]).toBeTruthy()
    expect(signalLabel('d1_rows_read_high')).toBe('D1 读取行数用量高')
    expect(signalLabel('ai_neurons_high')).toBe('Workers AI neurons 用量高')
    expect(guardReasonLabel('quota_r2_class_a')).toBe('配额：R2 A 类操作')
  })

  it('labels every code in the contract fixtures', () => {
    const signals = [...mailHeroDegraded.signals, ...todofyDegraded.signals, ...watchDegraded.signals, ...recallDegraded.signals].map((signal) => signal.code)
    for (const code of signals) expect(signalLabel(code)).not.toBe(code)
    const counters = [mailHeroOk, todofyOk, watchOk, watchDegraded, recallOk, tasksOk].flatMap((status) => Object.keys(status.counters))
    for (const name of counters) expect(counterInfo(name).label).not.toBe(name)
    const modes = [mailHeroOk, todofyOk, watchOk].flatMap((status) => Object.keys(status.modes))
    for (const name of modes) expect(modeInfo(name, false).label).not.toBe(name)
    // Every mode of an ok status is in its usual position (an unusual one is marked for attention).
    for (const status of [mailHeroOk, todofyOk, watchOk]) {
      for (const [name, value] of Object.entries(status.modes)) expect(modeInfo(name, value).usual, `${status.app} ${name}`).toBe(true)
    }
    for (const job of shedWatch.deferred) expect(deferredJobLabel(job)).not.toBe(job)
  })

  it('names the Newsletter outcome warnings', () => {
    expect(signalLabel('newsletter_side_effect_unknown')).toBe('Newsletter 有可能已产生结果的待核对记录')
    expect(signalLabel('newsletter_delivery_overdue')).toBe('Newsletter 每日投递逾期')
  })

  it('sends a run or delivery question to the Newsletter console, and the host and release to Fleet', () => {
    // The console reads Newsletter's own record (the failed node, its reason, the delivery); Fleet only counts.
    for (const code of ['newsletter_delivery_overdue', 'newsletter_delivery_rejected', 'newsletter_side_effect_unknown', 'newsletter_unknown']) {
      expect(alertGuidance(code, 'newsletter').next, code).toContain('Newsletter 控制台')
    }
    expect(alertGuidance('newsletter_delivery_overdue', 'newsletter').next).toContain('运行页')
    // A run shows its delivery's state only; the provider's error code is on that issue's delivery record.
    expect(alertGuidance('newsletter_delivery_rejected', 'newsletter').next).toContain('这一期的投递记录中查看错误码')
    for (const code of ['newsletter_unavailable', 'newsletter_paused']) {
      expect(alertGuidance(code, 'newsletter').next, code).toContain('Fleet')
    }
    // Notion is the backup copy: its unknown writes are named as backup writes.
    expect(alertGuidance('newsletter_side_effect_unknown', 'newsletter').explanation).toContain('Notion 备份写入')
    expect(counterInfo('unknown_notion_entities').label).toBe('Notion 备份创建待核对')
    expect(counterInfo('unknown_notion_versions').label).toBe('Notion 备份更新待核对')
  })

  it('names configuration states and gives warning actions without claiming a failed daily delivery', () => {
    for (const state of ['current', 'pending', 'failed', 'stale', 'pinned', 'unobserved']) {
      const code = `newsletter_config_${state}`
      expect(signalLabel(code)).not.toBe(code)
    }
    expect(signalLabel('newsletter_config_current')).toBe('与上次检查目标一致')
    for (const state of ['failed', 'stale']) {
      expect(alertGuidance(`newsletter_config_${state}`, 'newsletter').next).toContain('Fleet')
    }
  })

  it('shows the GTD counters in their units', () => {
    expect(counterInfo('inbox_oldest_days')).toEqual({ label: '收件箱最老', kind: 'days' })
    expect(counterValue('review_age_days', 12)).toBe('12 天')
    expect(counterShort('inbox_open', 23)).toBe('收件箱开放 23')
    expect(signalLabel('review_overdue')).toBe('每周回顾已超过 10 天')
    expect(signalLabel('gtd_stale')).toBe('GTD 统计超过 48 小时未更新')
  })

  it("labels the watch app's hand-over to Tasks and the digest's daily task", () => {
    expect(counterInfo('intents_sent_today').label).toBe('今日交给 Tasks')
    expect(signalLabel('notify_unsettled')).toBe('提醒交给 Tasks 未完成')
    expect(signalLabel('digest_task_failed')).toBe('今日运维摘要任务创建失败')
  })

  it('labels Mailsort Claude usage in dollars and tokens, with safe failure reasons', () => {
    expect(counterValue('claude_spent_usd', 3.514105)).toBe('US$ 3.51')
    expect(counterValue('claude_monthly_limit_usd', 20)).toBe('US$ 20.00')
    expect(counterInfo('claude_spent_usd').label).toBe('Claude 本月估算费用')
    expect(counterInfo('claude_output_tokens')).toEqual({ label: 'Claude 本月输出 token（含思考）', kind: 'tokens' })
    expect(counterInfo('claude_input_tokens')).toEqual({ label: 'Claude 本月输入总计 token（含缓存）', kind: 'tokens' })
    expect(counterInfo('claude_cache_read_tokens')).toEqual({ label: 'Claude 本月缓存读取 token', kind: 'tokens' })
    expect(counterInfo('claude_cache_write_tokens')).toEqual({ label: 'Claude 本月缓存写入 token', kind: 'tokens' })
    for (const name of ['claude_input_tokens', 'claude_thinking_tokens']) expect(counterInfo(name).label).not.toBe(name)
    for (const code of ['claude_not_configured', 'claude_auth', 'claude_spend_limit', 'claude_budget_exhausted', 'claude_unavailable', 'claude_bad_answer']) expect(signalLabel(code)).not.toBe(code)
    expect(signalLabel('claude_spend_limit')).toBe('Mailsort Claude 工作区已达到月度消费上限')
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

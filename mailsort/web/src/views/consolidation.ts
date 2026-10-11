/** One private label-consolidation plan, its durable progress and explicit resume. */
import { LabelConsolidation_Group_State, LabelConsolidation_Phase, LabelConsolidation_State, type LabelConsolidation, type LabelConsolidationGroup } from '@ziyixi/proto/mailsort/ui/v2/consolidation_pb'
import { Mode, ServiceStatus_AuthState, type ServiceStatus, type Settings } from '@ziyixi/proto/mailsort/ui/v2/status_pb'
import type { Label } from '@ziyixi/proto/mailsort/ui/v2/label_pb'
import { ApiError, api, errorMessage, newRequestId, withRetry } from '../api.ts'
import { disclosure } from '../components.ts'
import { button, el, fill } from '../dom.ts'
import { labelText, when } from '../format.ts'
import { allLabels } from './common.ts'
import { parseConsolidationPlan } from './consolidation-plan.ts'

const PHASES: Readonly<Partial<Record<LabelConsolidation_Phase, string>>> = {
  [LabelConsolidation_Phase.PREFLIGHT]: '核对标签',
  [LabelConsolidation_Phase.RENAME]: '改名',
  [LabelConsolidation_Phase.MOVE]: '移动标签关联',
  [LabelConsolidation_Phase.VERIFY]: '核对剩余关联',
  [LabelConsolidation_Phase.HIDE]: '隐藏空旧标签',
  [LabelConsolidation_Phase.COMPLETE]: '完成',
}

const ERRORS: Readonly<Record<string, string>> = {
  label_changed: 'Gmail 标签已改名或删除，请核对原计划中的标签后继续',
  label_name_taken: '目标名称被其他 Gmail 标签占用，请先解决同名冲突',
  rename_unverified: '尚未核实 Gmail 改名结果，继续会先重新检查',
  message_changed: '邮件的标签在整理期间发生变化，请先核对，再继续',
  other_labels_changed: '邮件的其他 Gmail 标签发生变化，请先核对，再继续',
  daily_write_limit: '今日 Gmail 写入额度已用完，等下一个 UTC 日后继续',
  writes_paused: 'Gmail 写入已暂停，请检查模式、授权和熔断状态后继续',
  swap_unverified: '尚未核实邮件的目标标签，继续会先重新检查',
  source_reapplied: '旧标签又被加到邮件上，请停止相关规则或手动操作后继续',
  source_not_empty: '旧标签下仍有邮件，尚未完成合并，请核对后继续',
  hidden_label_not_empty: '待隐藏的旧标签仍有邮件，请核对后继续',
  hide_unverified: '尚未核实空标签的隐藏结果，继续会先重新检查',
  plan_invalid: '保存的计划无法读取，需要检查服务，暂时不要重建计划',
}

function writeHold(status: ServiceStatus | null, settings: Settings | null): string | null {
  if (status === null || settings === null) return '运行状态读取失败，请刷新后再操作'
  if (status.effectiveMode === Mode.OFF) return '模式已关闭，整理暂停；切到影子或正式后继续'
  if (settings.breakerTripped) return 'Gmail 写入已熔断，请先在模式中核对原因并解除熔断'
  if (status.authState !== ServiceStatus_AuthState.OK || !status.writeScope) return '整理需要有效的 Gmail 可写授权，请先恢复授权'
  return null
}

export async function consolidationPanel(initialLabels: readonly Label[]): Promise<HTMLElement> {
  const progress = el('div', { class: 'consolidation-progress', role: 'status' })
  const feedback = el('p', { class: 'hint warn', role: 'status', hidden: true })
  const text = el('textarea', { rows: '5', maxlength: '32768', 'aria-label': '整理计划 JSON', placeholder: '[{"sources":["旧标签"],"display_name":"Travel","description":"行程与预订"}]', spellcheck: 'false' })
  const preview = el('div', { class: 'consolidation-preview' })
  const start = button('确认开始整理', () => void run('start'), { class: 'primary', hidden: true })
  const resume = button('继续整理', () => void run('resume'), { hidden: true })
  const refresh = button('刷新整理状态', () => void load())
  let labels = initialLabels
  let current: LabelConsolidation | null = null
  let status: ServiceStatus | null = null
  let settings: Settings | null = null
  let readable = false
  let busy = false
  let groups: LabelConsolidationGroup[] | null = null
  let pending: { kind: 'start' | 'resume'; requestId: string; etag: string; previousJob: string } | null = null

  const showError = (error: unknown) => {
    feedback.hidden = false
    feedback.textContent = error instanceof ApiError ? errorMessage(error) : error instanceof Error ? error.message : '整理失败，请刷新状态后重试'
  }
  const paint = () => {
    const hold = writeHold(status, settings)
    const active = current !== null && current.state !== LabelConsolidation_State.SUCCEEDED
    const stateName = current?.state === LabelConsolidation_State.SUCCEEDED ? '已完成' : current?.state === LabelConsolidation_State.BLOCKED ? '需要处理' : '进行中'
    const checkpoint = current === null || !readable
      ? el('p', { class: 'hint' }, readable ? '尚无整理任务' : '整理状态未读到')
      : el('p', { class: current.state === LabelConsolidation_State.BLOCKED ? 'hint warn' : 'hint' }, `${stateName} · ${PHASES[current.phase] ?? '未知阶段'} · 已处理 ${String(current.processedCount)} 次标签关联 · ${when(current.updateTime)}`)
    const problem = readable && current?.errorCode
      ? el('p', { class: 'hint warn' }, `${ERRORS[current.errorCode] ?? `整理遇到 ${current.errorCode}，请检查依赖状态`}。${current.nextAction === 'resume' ? '处理原因后点击继续整理；沿用原计划。' : '等待后台检查后刷新状态。'}`)
      : null
    const groupProgress = readable && current !== null && current.groups.length > 0
      ? el('ul', {}, ...current.groups.map((group) => el('li', {}, `${group.displayName}：${group.state === LabelConsolidation_Group_State.SUCCEEDED ? '已完成' : group.state === LabelConsolidation_Group_State.RUNNING ? '处理中' : '待处理'}，${String(group.processedCount)} 次标签关联`)))
      : null
    fill(progress, checkpoint, groupProgress, problem, hold === null ? null : el('p', { class: 'hint warn' }, hold))
    inputForm.hidden = active
    text.disabled = busy || pending !== null
    check.disabled = busy || !readable || pending !== null
    start.hidden = groups === null || active
    start.disabled = busy || !readable || hold !== null
    start.textContent = pending?.kind === 'start' ? '重试本次整理请求' : '确认开始整理'
    resume.hidden = current?.state !== LabelConsolidation_State.BLOCKED || current.nextAction !== 'resume'
    resume.disabled = busy || !readable || hold !== null
    refresh.disabled = busy
  }
  const check = button('预览计划', () => void prepare())
  const inputForm = el('div', {}, el('p', { class: 'hint' }, '粘贴私有 JSON 计划：sources 填现有标签的完整名称，第一个保留为目标；display_name 为英文名称，description 为说明。预览后再确认。计划只发给本应用，不保存到浏览器。'), text, el('div', { class: 'actions' }, check), preview, start)
  const panel = disclosure('整理标签', el('p', { class: 'hint' }, '合并已有标签的邮件关联，保留收件箱及已读状态；核对完成后隐藏空旧标签，不删除 Gmail 标签。整理期间暂停分拣和回放。'), progress, inputForm, feedback, el('div', { class: 'actions' }, resume, refresh))

  const load = async () => {
    if (busy) return
    busy = true
    feedback.hidden = true
    paint()
    const statusPromise = api.getServiceStatus({ name: 'serviceStatus' }).catch(() => null)
    const settingsPromise = api.getSettings({ name: 'settings' }).catch(() => null)
    try {
      current = await api.getLabelConsolidation({ name: 'labelConsolidation' }).catch((error: unknown) => {
        if (error instanceof ApiError && error.reason === 'NOT_FOUND') return null
        throw error
      })
      readable = true
      if (pending !== null && current !== null && (pending.kind === 'start'
        ? current.jobId !== pending.previousJob
        : current.jobId === pending.previousJob && current.etag !== pending.etag)) pending = null
    } catch (error) { readable = false; showError(error) }
    status = await statusPromise
    settings = await settingsPromise
    busy = false
    paint()
  }
  const prepare = async () => {
    if (busy || check.disabled) return
    busy = true
    feedback.hidden = true
    paint()
    try {
      labels = await allLabels()
      groups = parseConsolidationPlan(text.value, labels)
      fill(preview, el('ul', {}, ...groups.map((group) => el('li', {}, `${group.sources.map((source) => labelText(source.label, labels)).join(' + ')} → ${group.displayName}`))))
    } catch (error) { groups = null; fill(preview); showError(error) }
    busy = false
    paint()
  }
  const run = async (kind: 'start' | 'resume') => {
    if (busy || !readable || (kind === 'start' ? start.hidden || start.disabled || groups === null : resume.hidden || resume.disabled)) return
    pending ??= { kind, requestId: newRequestId(), etag: current?.etag ?? '', previousJob: current?.jobId ?? '' }
    const request = pending
    busy = true
    feedback.hidden = true
    paint()
    try {
      current = await withRetry(() => request.kind === 'start'
        ? api.startLabelConsolidation({ name: 'labelConsolidation', groups: groups ?? [], requestId: request.requestId })
        : api.resumeLabelConsolidation({ name: 'labelConsolidation', etag: request.etag, requestId: request.requestId }))
      pending = null
      groups = null
      text.value = ''
      fill(preview)
    } catch (error) {
      showError(error)
      if (!(error instanceof ApiError) || !error.transient) pending = null
    }
    busy = false
    paint()
  }
  text.addEventListener('input', () => { groups = null; fill(preview); paint() })
  await load()
  if (current !== null) panel.open = true
  return panel
}

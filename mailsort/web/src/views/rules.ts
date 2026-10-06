/**
 * 规则 (`/rules`): rules from the owner and proposals from corrections (the same sender or list corrected to the same
 * label twice). Approve, disable, delete; a new rule; and the active rules as a Gmail filter file to import by hand.
 */
import { create } from '@ziyixi/proto/protobuf'
import { Rule_State, RuleSchema, type Rule, type Rule_Kind } from '@ziyixi/proto/mailsort/ui/v1/rule_pb'
import type { Label } from '@ziyixi/proto/mailsort/ui/v1/label_pb'
import { api, listAll } from '../api.ts'
import { button, el, fill } from '../dom.ts'
import { labelText, RULE_KINDS, RULE_STATES } from '../format.ts'
import type { ViewContext } from '../app.ts'
import { act, allLabels, frame, labelSelect } from './common.ts'

function row(rule: Rule, labels: readonly Label[], reload: () => Promise<void>): HTMLElement {
  const kind = RULE_KINDS.find(([value]) => value === rule.kind)?.[1] ?? ''
  return el(
    'article',
    { class: `card rule state-${String(rule.state)}` },
    el('div', { class: 'card-head' }, el('span', { class: 'chip' }, RULE_STATES[rule.state] ?? ''), el('span', { class: 'muted' }, kind)),
    el('p', { class: 'mono' }, rule.value),
    el('p', {}, `→ ${labelText(rule.label, labels)}${rule.dmarcRequired ? '（需 DMARC 通过）' : ''}`),
    el('p', { class: 'hint' }, `来自 ${String(rule.correctionCount)} 次纠正 · 已命中 ${String(rule.matchCount)} 封`),
    el(
      'div',
      { class: 'actions' },
      rule.state === Rule_State.ACTIVE ? button('停用', () => void act((requestId) => api.disableRule({ name: rule.name, requestId }), '已停用', reload)) : button('批准', () => void act((requestId) => api.approveRule({ name: rule.name, requestId }), '已生效', reload), { class: 'primary' }),
      button('删除', () => void act((requestId) => api.deleteRule({ name: rule.name, requestId }), '已删除', reload), { class: 'small danger' }),
    ),
  )
}

export async function renderRules(ctx: ViewContext): Promise<void> {
  const reload: () => Promise<void> = await frame(ctx.main, '规则', async (body) => {
    const [rules, labels] = await Promise.all([
      listAll(async (pageToken) => {
        const page = await api.listRules({ pageSize: 100, pageToken })
        return { items: page.rules, next: page.nextPageToken }
      }, 5),
      allLabels(),
    ])
    const kind = el('select', { 'aria-label': '类型' }, ...RULE_KINDS.map(([value, name]) => el('option', { value: String(value) }, name)))
    const value = el('input', { placeholder: '地址、域名或列表 ID', 'aria-label': '值' })
    const label = labelSelect(labels, labels[0]?.name ?? '', false, { 'aria-label': '标签' })
    const output = el('textarea', { rows: '6', readonly: true, hidden: true, 'aria-label': 'Gmail 过滤器文件' })
    const add = () => void act((requestId) => api.createRule({ rule: create(RuleSchema, { kind: Number(kind.value) as Rule_Kind, value: value.value, label: label.value }), requestId }), '已创建', () => reload())
    const exportFilters = async () => {
      const answer = await act(() => api.exportGmailFilters({}), '已导出', () => Promise.resolve())
      if (answer === null) return
      output.value = answer.xml
      output.hidden = false
    }
    const proposed = rules.filter((rule) => rule.state === Rule_State.PROPOSED)
    const others = rules.filter((rule) => rule.state !== Rule_State.PROPOSED)
    fill(
      body,
      el('section', { class: 'card' }, el('h2', {}, '新建规则'), kind, value, label, el('div', { class: 'actions' }, button('创建', add, { class: 'primary' }), button('导出为 Gmail 过滤器', () => void exportFilters()))),
      output,
      proposed.length === 0 ? null : el('h2', {}, `待批准（${String(proposed.length)}）`),
      ...proposed.map((rule) => row(rule, labels, () => reload())),
      el('h2', {}, `规则（${String(others.length)}）`),
      others.length === 0 ? el('p', { class: 'empty' }, '还没有规则。') : el('div', { class: 'list' }, ...others.map((rule) => row(rule, labels, () => reload()))),
    )
  })
}

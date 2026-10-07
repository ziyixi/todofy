/**
 * 规则 (`/rules`, reached from 标签 until that page holds the rules itself): rules from the owner (by hand, or
 * imported) and proposals from corrections (the same sender or list corrected to the same label twice). Each shows its
 * subject conditions (a carve-out is tried before the sender's plain rule), whether it keeps its mail in the inbox,
 * whether it needs DMARC, and the owner's evidence and notes. Approve, disable, delete; a new rule. (The Gmail filter
 * export is in 设置.)
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
    el('p', {}, `→ ${labelText(rule.label, labels)}${rule.dmarcRequired ? '（需 DMARC 通过）' : ''}${rule.keepInInbox ? ' · 留在收件箱' : ''}`),
    rule.subjectIncludes.length === 0 ? null : el('p', { class: 'hint' }, `主题包含：${rule.subjectIncludes.join('、')}`),
    rule.subjectExcludes.length === 0 ? null : el('p', { class: 'hint' }, `主题不含：${rule.subjectExcludes.join('、')}`),
    rule.evidence === '' ? null : el('p', { class: 'hint' }, `依据：${rule.evidence}`),
    rule.notes === '' ? null : el('p', { class: 'hint' }, `备注：${rule.notes}`),
    el('p', { class: 'hint' }, `${rule.importId === '' ? `来自 ${String(rule.correctionCount)} 次纠正` : `导入 ID ${rule.importId}`} · 已命中 ${String(rule.matchCount)} 封`),
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
    const label = labelSelect(labels, labels[0]?.name ?? '', null, { 'aria-label': '标签' })
    const includes = el('input', { placeholder: '主题包含（可选，用逗号分隔，如 登录, login）', 'aria-label': '主题包含' })
    const excludes = el('input', { placeholder: '主题不含（可选，用逗号分隔）', 'aria-label': '主题不含' })
    const keepBox = el('input', { type: 'checkbox', class: 'switch', 'aria-label': '留在收件箱' })
    const dmarcBox = el('input', { type: 'checkbox', class: 'switch', 'aria-label': '需要 DMARC' })
    const words = (input: HTMLInputElement) => input.value.split(/[,，、]/).map((word) => word.trim()).filter((word) => word !== '')
    const add = () =>
      void act(
        (requestId) =>
          api.createRule({
            rule: create(RuleSchema, { kind: Number(kind.value) as Rule_Kind, value: value.value, label: label.value, subjectIncludes: words(includes), subjectExcludes: words(excludes), keepInInbox: keepBox.checked, requireDmarc: dmarcBox.checked }),
            requestId,
          }),
        '已创建',
        () => reload(),
      )
    const proposed = rules.filter((rule) => rule.state === Rule_State.PROPOSED)
    const others = rules.filter((rule) => rule.state !== Rule_State.PROPOSED)
    fill(
      body,
      el(
        'section',
        { class: 'card' },
        el('h2', {}, '新建规则'),
        kind,
        value,
        label,
        includes,
        excludes,
        el('label', { class: 'check' }, keepBox, el('span', {}, '留在收件箱', el('span', { class: 'hint' }, '只加标签，不移出收件箱（如取件码）'))),
        el('label', { class: 'check' }, dmarcBox, el('span', {}, '需要 DMARC', el('span', { class: 'hint' }, '列表或收件地址规则也要求发件域名通过 DMARC；按发件人的规则总是要求'))),
        el('div', { class: 'actions' }, button('创建', add, { class: 'primary' })),
      ),
      proposed.length === 0 ? null : el('h2', {}, `待批准（${String(proposed.length)}）`),
      ...proposed.map((rule) => row(rule, labels, () => reload())),
      el('h2', {}, `规则（${String(others.length)}）`),
      others.length === 0 ? el('p', { class: 'empty' }, '还没有规则。') : el('div', { class: 'list' }, ...others.map((rule) => row(rule, labels, () => reload()))),
    )
  })
}

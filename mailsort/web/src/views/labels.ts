/**
 * 标签 (`/labels`): every label with its description (the model's criteria), switches and threshold, as a tree of its
 * path (`金融/投资` under 金融: Gmail's nested labels, named by the path; only leaves are labels); a new label; the sync
 * with Gmail (renames and deletions there, and the owner's Gmail label of a label's path, which is adopted); and the
 * recommended template (导入导出 previews it before anything changes). Deleting a label here leaves the Gmail label
 * and its mails as they are.
 */
import { create } from '@ziyixi/proto/protobuf'
import { Label_GmailState, LabelSchema, type Label } from '@ziyixi/proto/mailsort/ui/v1/label_pb'
import { api } from '../api.ts'
import { button, el, fill } from '../dom.ts'
import type { ViewContext } from '../app.ts'
import { act, allLabels, frame } from './common.ts'

/** What SyncLabels did, in the owner's words. */
function syncMessage(answer: { linkedCount: number; renamedCount: number; missingCount: number }): string {
  return `已同步：关联 ${String(answer.linkedCount)}，改名 ${String(answer.renamedCount)}，Gmail 中缺失 ${String(answer.missingCount)}`
}

const GMAIL_STATES: Readonly<Record<number, string>> = {
  [Label_GmailState.PENDING]: '尚未在 Gmail 创建',
  [Label_GmailState.LINKED]: '已关联 Gmail',
  [Label_GmailState.ADOPTED]: '已沿用 Gmail 原有标签',
  [Label_GmailState.MISSING]: 'Gmail 中已不存在',
}

function check(label: string, checked: boolean, hint: string): [HTMLLabelElement, HTMLInputElement] {
  const input = el('input', { type: 'checkbox', ...(checked ? { checked: true } : {}) })
  return [el('label', { class: 'check' }, input, el('span', {}, label, el('span', { class: 'hint' }, hint))), input]
}

function editor(label: Label, reload: () => Promise<void>, confirm: (message: string) => boolean): HTMLElement {
  const name = el('input', { value: label.displayName, 'aria-label': '路径', maxlength: '100' })
  const description = el('textarea', { rows: '3', maxlength: '300', 'aria-label': '说明' }, label.description)
  const threshold = el('input', { type: 'number', min: '0.5', max: '0.99', step: '0.01', value: label.threshold === 0 ? '' : String(label.threshold), placeholder: '默认', 'aria-label': '阈值' })
  const [enabledBox, enabled] = check('启用', label.enabled, '可以被建议或打上')
  const [liveBox, live] = check('正式打', label.live, '正式模式下有把握时直接打标签（按“归档”开关决定是否移出收件箱）')
  const [trustBox, trust] = check('可信类', label.trustImplying, '银行、账户安全等：只允许规则（且 DMARC 通过）打')
  // 归档 is the inverse of keep_in_inbox: on (the default) removes INBOX with the label.
  const [archiveBox, archive] = check('归档', !label.keepInInbox, '打标签时移出收件箱；关掉则只加标签、留在收件箱')
  const [sensitiveBox, sensitive] = check('敏感', label.sensitive, '不保留这类邮件的例子（摘要）；打开时已有的例子会被删除')
  const save = () =>
    void act(
      (requestId) =>
        api.updateLabel({
          label: create(LabelSchema, {
            name: label.name,
            displayName: name.value,
            description: description.value,
            enabled: enabled.checked,
            live: live.checked,
            trustImplying: trust.checked,
            keepInInbox: !archive.checked,
            sensitive: sensitive.checked,
            threshold: threshold.value === '' ? 0 : Number(threshold.value),
            etag: label.etag,
          }),
          updateMask: { paths: ['display_name', 'description', 'enabled', 'live', 'trust_implying', 'keep_in_inbox', 'sensitive', 'threshold', 'etag'] },
          requestId,
        }),
      '已保存',
      reload,
    )
  const remove = () => {
    if (!confirm(`从本应用删除“${label.displayName}”及其规则和例子？Gmail 里的标签和邮件不会变，它的操作记录也不能再从这里撤销（要撤销请先撤销再删除）。`)) return
    void act((requestId) => api.deleteLabel({ name: label.name, etag: label.etag, requestId }), '已删除', reload)
  }
  return el(
    'article',
    { class: 'card label-card' },
    el('div', { class: 'card-head' }, el('strong', {}, label.displayName), el('span', { class: 'chip' }, GMAIL_STATES[label.gmailState] ?? '')),
    el('p', { class: 'hint' }, `ID ${label.name.replace('labels/', '')} · 说明版本 ${String(label.descriptionVersion)} · 例子 ${String(label.exampleCount)}`),
    el('label', { class: 'field' }, el('span', { class: 'label' }, '路径（最多三级，如 金融/投资）'), name),
    el('label', { class: 'field' }, el('span', { class: 'label' }, '说明（模型看到“名称: 说明”；建议一种语言、60–120 字）'), description),
    label.description === '' ? el('p', { class: 'hint warn' }, '还没有说明：模型不会选这个标签，只有规则和例子能打它。') : null,
    el('label', { class: 'field' }, el('span', { class: 'label' }, '阈值（0.5–0.99，空为默认）'), threshold),
    enabledBox,
    liveBox,
    archiveBox,
    trustBox,
    sensitiveBox,
    el('div', { class: 'actions' }, button('保存', save, { class: 'primary' }), button('删除', remove, { class: 'small danger' })),
  )
}

/**
 * The labels as Gmail's tree of nested labels, in the labels' order: a section per path prefix that has labels under
 * it, recursively (a path has up to three segments: 生活/汽车/保养 sits under 生活/汽车, under 生活), and a
 * label's card where its path ends. Only leaves are labels, so a prefix is never a label of its own.
 */
function tree(labels: readonly Label[], card: (label: Label) => HTMLElement): HTMLElement {
  const branch = (members: readonly Label[], depth: number): HTMLElement[] => {
    const groups = new Map<string, Label[]>()
    for (const label of members) {
      const segment = label.displayName.split('/')[depth] ?? label.displayName
      groups.set(segment, [...(groups.get(segment) ?? []), label])
    }
    return [...groups].map(([segment, group]) => {
      const prefix = [...(group[0]?.displayName.split('/').slice(0, depth) ?? []), segment].join('/')
      const only = group[0]
      // A label that ends here, alone under its prefix: its card, without a heading of its own.
      if (group.length === 1 && only !== undefined && only.displayName === prefix) {
        return depth === 0 ? el('section', { class: 'label-group', 'aria-label': prefix }, el('div', { class: 'list' }, card(only))) : card(only)
      }
      const heading = el(depth === 0 ? 'h2' : 'h3', { class: 'group-name' }, prefix, el('span', { class: 'muted' }, ` · ${String(group.length)} 个标签`))
      return el('section', { class: depth === 0 ? 'label-group' : 'label-subgroup', 'aria-label': prefix }, heading, el('div', { class: 'list nested' }, ...branch(group, depth + 1)))
    })
  }
  return el('div', { class: 'label-tree' }, ...branch(labels, 0))
}

export async function renderLabels(ctx: ViewContext): Promise<void> {
  const reload: () => Promise<void> = await frame(ctx.main, '标签', async (body) => {
    const labels = await allLabels()
    const name = el('input', { placeholder: '路径，例如 订阅 或 金融/投资', maxlength: '100', 'aria-label': '新标签路径' })
    const description = el('input', { placeholder: '说明，例如 newsletter 周报 订阅', maxlength: '300', 'aria-label': '新标签说明' })
    const add = () =>
      void act((requestId) => api.createLabel({ label: create(LabelSchema, { displayName: name.value, description: description.value, enabled: true }), requestId }), '已创建', () => reload())
    fill(
      body,
      el('p', { class: 'hint' }, '可以分级（金融/投资）：上级只用来分组，邮件只打末级的一个标签。Gmail 里已有同名标签时直接沿用。'),
      el(
        'section',
        { class: 'card' },
        el('h2', {}, '新建标签'),
        name,
        description,
        el(
          'div',
          { class: 'actions' },
          button('创建', add, { class: 'primary' }),
          button('从 Gmail 同步', () => void act((requestId) => api.syncLabels({ requestId }), syncMessage, () => reload())),
          button('套用推荐模板', () => {
            ctx.go('/import?template=1')
          }),
        ),
      ),
      labels.length === 0 ? el('p', { class: 'empty' }, '还没有标签。可以先套用推荐模板（15 个常用分类，先预览再确认）。') : tree(labels, (label) => editor(label, () => reload(), ctx.host.confirm)),
    )
  })
}

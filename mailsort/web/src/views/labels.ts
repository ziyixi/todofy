/**
 * 标签 (`/labels`): every label with its description (the model's criteria), switches and threshold; a new label; and
 * the sync with Gmail's "分拣/" labels. Deleting a label here leaves the Gmail label and its mails as they are.
 */
import { create } from '@ziyixi/proto/protobuf'
import { Label_GmailState, LabelSchema, type Label } from '@ziyixi/proto/mailsort/ui/v1/label_pb'
import { api } from '../api.ts'
import { button, el, fill } from '../dom.ts'
import type { ViewContext } from '../app.ts'
import { act, allLabels, frame } from './common.ts'

/** What SyncLabels did, in the owner's words: imported labels arrive disabled and without a description. */
function syncMessage(answer: { linkedCount: number; importedCount: number; missingCount: number }): string {
  return `已同步：关联 ${String(answer.linkedCount)}，导入 ${String(answer.importedCount)}${answer.importedCount > 0 ? '（未启用，请补说明）' : ''}，Gmail 中缺失 ${String(answer.missingCount)}`
}

const GMAIL_STATES: Readonly<Record<number, string>> = {
  [Label_GmailState.PENDING]: '尚未在 Gmail 创建',
  [Label_GmailState.LINKED]: '已关联 Gmail',
  [Label_GmailState.MISSING]: 'Gmail 中已不存在',
}

function check(label: string, checked: boolean, hint: string): [HTMLLabelElement, HTMLInputElement] {
  const input = el('input', { type: 'checkbox', ...(checked ? { checked: true } : {}) })
  return [el('label', { class: 'check' }, input, el('span', {}, label, el('span', { class: 'hint' }, hint))), input]
}

function editor(label: Label, reload: () => Promise<void>, confirm: (message: string) => boolean): HTMLElement {
  const name = el('input', { value: label.displayName, 'aria-label': '名称', maxlength: '40' })
  const description = el('textarea', { rows: '3', maxlength: '300', 'aria-label': '说明' }, label.description)
  const threshold = el('input', { type: 'number', min: '0.5', max: '0.99', step: '0.01', value: label.threshold === 0 ? '' : String(label.threshold), placeholder: '默认', 'aria-label': '阈值' })
  const [enabledBox, enabled] = check('启用', label.enabled, '可以被建议或打上')
  const [liveBox, live] = check('正式打', label.live, '正式模式下有把握时直接打标签并归档')
  const [trustBox, trust] = check('可信类', label.trustImplying, '银行、账户安全等：只允许规则（且 DMARC 通过）打')
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
            threshold: threshold.value === '' ? 0 : Number(threshold.value),
            etag: label.etag,
          }),
          updateMask: { paths: ['display_name', 'description', 'enabled', 'live', 'trust_implying', 'threshold', 'etag'] },
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
    el('div', { class: 'card-head' }, el('strong', {}, `分拣/${label.displayName}`), el('span', { class: 'chip' }, GMAIL_STATES[label.gmailState] ?? '')),
    el('p', { class: 'hint' }, `ID ${label.name.replace('labels/', '')} · 说明版本 ${String(label.descriptionVersion)} · 例子 ${String(label.exampleCount)}`),
    el('label', { class: 'field' }, el('span', { class: 'label' }, '名称'), name),
    el('label', { class: 'field' }, el('span', { class: 'label' }, '说明（模型看到“名称: 说明”；建议一种语言、60–120 字）'), description),
    label.description === '' ? el('p', { class: 'hint warn' }, '还没有说明：模型只能凭名称判断。') : null,
    el('label', { class: 'field' }, el('span', { class: 'label' }, '阈值（0.5–0.99，空为默认）'), threshold),
    enabledBox,
    liveBox,
    trustBox,
    el('div', { class: 'actions' }, button('保存', save, { class: 'primary' }), button('删除', remove, { class: 'small danger' })),
  )
}

export async function renderLabels(ctx: ViewContext): Promise<void> {
  const reload: () => Promise<void> = await frame(ctx.main, '标签', async (body) => {
    const labels = await allLabels()
    const name = el('input', { placeholder: '名称，例如 订阅', maxlength: '40', 'aria-label': '新标签名称' })
    const description = el('input', { placeholder: '说明，例如 newsletter 周报 订阅', maxlength: '300', 'aria-label': '新标签说明' })
    const add = () =>
      void act((requestId) => api.createLabel({ label: create(LabelSchema, { displayName: name.value, description: description.value, enabled: true }), requestId }), '已创建', () => reload())
    fill(
      body,
      el('p', { class: 'hint' }, '标签在 Gmail 中位于“分拣/”下。每封邮件只打一个标签。'),
      el('section', { class: 'card' }, el('h2', {}, '新建标签'), name, description, el('div', { class: 'actions' }, button('创建', add, { class: 'primary' }), button('从 Gmail 同步', () => void act((requestId) => api.syncLabels({ requestId }), syncMessage, () => reload())))),
      labels.length === 0 ? el('p', { class: 'empty' }, '还没有标签。') : el('div', { class: 'list' }, ...labels.map((label) => editor(label, () => reload(), ctx.host.confirm))),
    )
  })
}

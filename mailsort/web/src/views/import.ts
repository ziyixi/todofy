/**
 * 导入导出 (`/import`): labels and rules in, previewed first, applied only on 确认导入; and every label and rule out as the
 * JSON the import reads back.
 *
 * What comes in: the built-in template of 15 recommended labels (标签's 套用推荐模板 opens this page with it), or pasted
 * or uploaded JSON: the owner's rule file (a list of rules) or this app's export (`{"labels": [...], "rules": [...]}`).
 * The page reads each entry strictly with the shared wire codec first, so a typo in a field name is reported with its
 * entry's number before anything is sent; the server then checks the values and answers the preview (ImportRules with
 * validate_only): per entry create, update (which fields), skip or invalid (why), and warnings. 确认导入 sends the same
 * entries again; the server plans once more and applies all or nothing. Nothing is written to Gmail.
 */
import { fromWire } from '@ziyixi/proto/wire-json'
import { ImportChange_Action, ImportChange_Kind, LabelImportSchema, RuleImportSchema, type ImportChange, type ImportRulesResponse, type LabelImport, type RuleImport } from '@ziyixi/proto/mailsort/ui/v1/mailsort_ui_service_pb'
import { api, errorMessage } from '../api.ts'
import { button, el, fill, toast } from '../dom.ts'
import type { ViewContext } from '../app.ts'
import { act, frame } from './common.ts'

const ACTIONS: Readonly<Record<number, string>> = {
  [ImportChange_Action.CREATE]: '新建',
  [ImportChange_Action.UPDATE]: '更新',
  [ImportChange_Action.SKIP]: '不变',
  [ImportChange_Action.INVALID]: '有误',
}

/** ImportChange.problem in the owner's words. */
export const PROBLEMS: Readonly<Record<string, string>> = {
  label_path: '标签路径不对（最多三级，每级 1–40 字）',
  label_tree: '标签不能和另一个标签互为上下级（只有末级是标签）',
  description: '说明太长（最多 300 字）或含换行以外的控制字符',
  threshold: '阈值须为 0 或 0.5–0.99',
  match: 'match 里要有且只有一个：from_address、from_domain、list_id 或 to_address',
  value: '地址、域名或列表 ID 的格式不对',
  rule_id: 'id 只能用字母、数字和 ._-（最多 64 个）',
  subject: '主题条件每边最多 8 个，每个 1–40 字',
  text: 'evidence 或 notes 太长（最多 300 字）或含换行以外的控制字符',
  duplicate: '和前面的条目重复',
  labels_full: '标签数量会超过上限 24',
  rules_full: '规则数量会超过上限 500',
}

export const WARNINGS: Readonly<Record<string, string>> = {
  trust_mismatch: '规则标了 trust，但它的标签不是可信类',
  rule_disabled: '已有的这条规则是停用的，导入后仍停用',
  same_match: '前面有条件完全相同、标签不同的规则：会先用前面那条',
  examples_deleted: '改为敏感后，这个标签已有的例子会被删除',
}

const FIELDS: Readonly<Record<string, string>> = {
  description: '说明',
  enabled: '启用',
  trust: '可信类',
  keep_in_inbox: '留在收件箱',
  sensitive: '敏感',
  threshold: '阈值',
  match: '匹配',
  label: '标签',
  subject_includes: '主题包含',
  subject_excludes: '主题不含',
  require_dmarc: '需 DMARC',
  evidence: '依据',
  notes: '备注',
  import_id: '导入 ID',
  state: '状态（待批准→生效）',
}

export interface ParsedImport {
  readonly labels: LabelImport[]
  readonly rules: RuleImport[]
}

/**
 * The entries of pasted JSON: a list of rules (the owner's rule file), or `{"labels": [...], "rules": [...]}` (the
 * export). Each entry is read strictly (unknown fields, wrong types and missing required fields are errors), so the
 * error names the entry. Throws an Error with the owner's message.
 */
export function parseImport(text: string): ParsedImport {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error('不是有效的 JSON')
  }
  const document = Array.isArray(value) ? { rules: value } : value
  if (typeof document !== 'object' || document === null) throw new Error('应为规则列表，或含 labels / rules 的对象')
  const { labels = [], rules = [], ...rest } = document as { labels?: unknown; rules?: unknown }
  if (Object.keys(rest).length > 0 || !Array.isArray(labels) || !Array.isArray(rules)) throw new Error('应为规则列表，或只含 labels 和 rules 两个列表的对象')
  const read = <T>(items: unknown[], what: string, schema: Parameters<typeof fromWire>[0]): T[] =>
    items.map((item, index) => {
      try {
        return fromWire(schema, item, { strict: true }).message as T
      } catch (error) {
        throw new Error(`第 ${String(index + 1)} 个${what}：${error instanceof Error ? error.message : '格式不对'}`, { cause: error })
      }
    })
  const parsed = { labels: read<LabelImport>(labels as unknown[], '标签', LabelImportSchema), rules: read<RuleImport>(rules as unknown[], '规则', RuleImportSchema) }
  if (parsed.labels.length === 0 && parsed.rules.length === 0) throw new Error('没有任何标签或规则')
  return parsed
}

function changeRow(change: ImportChange): HTMLElement {
  const kind = change.kind === ImportChange_Kind.LABEL ? '标签' : '规则'
  const notes = [
    change.changedFields.length > 0 ? `改动：${change.changedFields.map((field) => FIELDS[field] ?? field).join('、')}` : '',
    change.problem === '' ? '' : (PROBLEMS[change.problem] ?? change.problem),
    change.warning === '' ? '' : `注意：${WARNINGS[change.warning] ?? change.warning}`,
    change.kind === ImportChange_Kind.LABEL && change.index < 0 && change.action === ImportChange_Action.CREATE ? '规则用到、尚不存在：会新建（启用、不正式打、无说明）' : '',
  ].filter((note) => note !== '')
  return el(
    'tr',
    { class: `action-${String(change.action)}` },
    el('td', {}, kind),
    el('td', { class: 'mono' }, change.key),
    el('td', {}, el('span', { class: `chip action-${String(change.action)}` }, ACTIONS[change.action] ?? '')),
    el('td', {}, notes.join('；')),
  )
}

/** The preview: counts, the template's labels when it is one, and every entry. */
function previewOf(answer: ImportRulesResponse, template: boolean): HTMLElement {
  const summary = `标签：新建 ${String(answer.createdLabelCount)}、更新 ${String(answer.updatedLabelCount)}；规则：新建 ${String(answer.createdRuleCount)}、更新 ${String(answer.updatedRuleCount)}；不变 ${String(answer.skippedCount)}${answer.invalidCount > 0 ? `；有误 ${String(answer.invalidCount)}（请修正后再预览）` : ''}`
  return el(
    'div',
    { class: 'import-preview' },
    el('p', { class: answer.invalidCount > 0 ? 'hint warn' : 'hint' }, summary),
    template
      ? el(
          'div',
          { class: 'list' },
          ...answer.labels.map((label) =>
            el(
              'article',
              { class: 'card' },
              el('strong', {}, label.path),
              el('p', { class: 'hint' }, [label.trust ? '可信类' : '', label.keepInInbox ? '留在收件箱' : '', label.sensitive ? '敏感' : ''].filter((flag) => flag !== '').join(' · ') || '普通'),
              el('p', {}, label.description),
            ),
          ),
        )
      : null,
    el('div', { class: 'table-scroll' }, el('table', { class: 'import-table' }, el('thead', {}, el('tr', {}, ...['类型', '条目', '结果', '说明'].map((name) => el('th', { scope: 'col' }, name)))), el('tbody', {}, ...answer.changes.map(changeRow)))),
  )
}

export async function renderImport(ctx: ViewContext): Promise<void> {
  const wantsTemplate = new URLSearchParams(window.location.search).get('template') === '1'
  await frame(ctx.main, '导入导出', async (body) => {
    const preview = el('section', { class: 'card', 'aria-live': 'polite' })
    preview.hidden = true
    const text = el('textarea', { rows: '8', 'aria-label': '要导入的 JSON', placeholder: '[{"id": "...", "match": {"from_address": "..."}, "label": "金融/投资", ...}]' })
    const file = el('input', { type: 'file', accept: '.json,application/json', 'aria-label': '选择 JSON 文件' })
    file.addEventListener('change', () => {
      const chosen = file.files?.[0]
      if (chosen === undefined) return
      void chosen.text().then(
        (content) => {
          text.value = content
        },
        () => {
          toast('读不了这个文件')
        },
      )
    })

    /** Shows the server's preview of `entries`, with 确认导入 when nothing is invalid. */
    const showPreview = async (entries: ParsedImport | 'template') => {
      const template = entries === 'template'
      const request = template ? { useTemplate: true } : { labels: entries.labels, rules: entries.rules }
      let answer: ImportRulesResponse
      try {
        answer = await api.importRules({ ...request, validateOnly: true })
      } catch (error) {
        toast(errorMessage(error))
        return
      }
      const confirm = button(
        '确认导入',
        () =>
          void act(
            (requestId) => api.importRules({ ...request, requestId }),
            (done) => `已导入：标签新建 ${String(done.createdLabelCount)}、更新 ${String(done.updatedLabelCount)}；规则新建 ${String(done.createdRuleCount)}、更新 ${String(done.updatedRuleCount)}`,
            () => {
              preview.hidden = true
              return Promise.resolve()
            },
          ),
        { class: 'primary', ...(answer.invalidCount > 0 ? { disabled: true } : {}) },
      )
      fill(preview, el('h2', {}, template ? '预览：推荐模板' : '预览'), previewOf(answer, template), el('div', { class: 'actions' }, confirm, button('取消', () => { preview.hidden = true })))
      preview.hidden = false
    }

    const previewText = () => {
      let parsed: ParsedImport
      try {
        parsed = parseImport(text.value)
      } catch (error) {
        toast(error instanceof Error ? error.message : '格式不对')
        return
      }
      void showPreview(parsed)
    }

    const output = el('textarea', { rows: '8', readonly: true, hidden: true, 'aria-label': '导出的 JSON' })
    const download = el('a', { download: 'mailsort-rules.json', hidden: true }, '下载 JSON 文件')
    const exportAll = async () => {
      try {
        const answer = await api.exportRules({})
        output.value = answer.json
        output.hidden = false
        // A file to save, made here: nothing leaves the page.
        if (typeof URL.createObjectURL === 'function') {
          download.setAttribute('href', URL.createObjectURL(new Blob([answer.json], { type: 'application/json' })))
          download.hidden = false
        }
        toast(`已导出 ${String(answer.labelCount)} 个标签、${String(answer.ruleCount)} 条规则`)
      } catch (error) {
        toast(errorMessage(error))
      }
    }

    // The preview comes first: it is what the owner just asked for (the template's link from 标签 lands on it).
    fill(
      body,
      preview,
      el(
        'section',
        { class: 'card' },
        el('h2', {}, '推荐模板'),
        el('p', { class: 'hint' }, '15 个常用分类（开发、金融、账号安全、购物、生活等），带写给模型的说明；可信类只由通过 DMARC 的规则打，账号安全和政府法律留在收件箱。已有同名标签会更新说明、可信类、归档和敏感开关（改为敏感会删除它已有的例子），自己调过的阈值保持不变。'),
        el('div', { class: 'actions' }, button('预览模板', () => void showPreview('template'))),
      ),
      el(
        'section',
        { class: 'card' },
        el('h2', {}, '导入 JSON'),
        el('p', { class: 'hint' }, '粘贴或选择规则文件（规则列表），或本页导出的文件。先预览，确认后才会更改；导入不会改 Gmail。'),
        text,
        file,
        el('div', { class: 'actions' }, button('预览', previewText, { class: 'primary' })),
      ),
      el('section', { class: 'card' }, el('h2', {}, '导出'), el('p', { class: 'hint' }, '所有标签和规则（待批准的提议除外），可以原样导入回来。'), el('div', { class: 'actions' }, button('导出', () => void exportAll())), output, download),
    )
    if (wantsTemplate) await showPreview('template')
  })
}

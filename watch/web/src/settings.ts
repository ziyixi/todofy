/**
 * A watch's settings as a form (adding and editing): a plain Draft the inputs edit, read from a Watch and written back
 * as one. The form offers what v1 supports: the source kinds, the include and exclude selectors (filled by the block
 * picker of views/add.ts), the triggers, the confirmation, the interval, the notify policy, shadow mode, and the two
 * fetch rules the owner may relax (http with a warning, robots.txt).
 */
import type { MessageInitShape } from '@ziyixi/proto/protobuf'
import { EmbeddedSource_Kind, Watch_NotifyPolicy, type Watch, type WatchSchema } from '@ziyixi/proto/watch/ui/v1/watch_pb'
import { el, fill, type Child } from './dom.ts'
import { INTERVALS } from './format.ts'

export type SourceKind = 'html' | 'feed' | 'json' | 'embedded'
export type TriggerKind = 'any_change' | 'text_appears' | 'text_disappears' | 'new_item' | 'number' | 'availability'

export interface Draft {
  name: string
  etag: string
  displayName: string
  uri: string
  source: SourceKind
  include: string[]
  exclude: string[]
  keepLinks: boolean
  jsonPath: string
  embedded: 'json_ld' | 'next_data'
  trigger: TriggerKind
  minLines: number
  text: string
  minItems: number
  upper: string
  lower: string
  changePercent: number
  label: string
  onlyWhenAvailable: boolean
  skipConfirmation: boolean
  interval: number
  urgent: boolean
  shadow: boolean
  allowHttp: boolean
  ignoreRobots: boolean
  ignoredLines: string[]
  locale: string
}

export function emptyDraft(uri = ''): Draft {
  return {
    name: '',
    etag: '',
    displayName: '',
    uri,
    source: 'html',
    include: [],
    exclude: [],
    keepLinks: false,
    jsonPath: '',
    embedded: 'json_ld',
    trigger: 'any_change',
    minLines: 1,
    text: '',
    minItems: 1,
    upper: '',
    lower: '',
    changePercent: 0,
    label: '',
    onlyWhenAvailable: true,
    skipConfirmation: false,
    interval: 360,
    urgent: false,
    shadow: false,
    allowHttp: false,
    ignoreRobots: false,
    ignoredLines: [],
    locale: '',
  }
}

/** The Draft of a stored watch. */
export function draftOf(watch: Watch): Draft {
  const draft = emptyDraft(watch.uri)
  const source = watch.source
  const trigger = watch.trigger
  return {
    ...draft,
    name: watch.name,
    etag: watch.etag,
    displayName: watch.displayName,
    source: source?.feed !== undefined ? 'feed' : source?.json !== undefined ? 'json' : source?.embedded !== undefined ? 'embedded' : 'html',
    include: [...(source?.html?.includeSelectors ?? [])],
    exclude: [...(source?.html?.excludeSelectors ?? [])],
    keepLinks: source?.html?.keepLinks ?? false,
    jsonPath: source?.json?.path ?? source?.embedded?.path ?? '',
    embedded: source?.embedded?.kind === EmbeddedSource_Kind.NEXT_DATA ? 'next_data' : 'json_ld',
    trigger:
      trigger?.textAppears !== undefined
        ? 'text_appears'
        : trigger?.textDisappears !== undefined
          ? 'text_disappears'
          : trigger?.newItem !== undefined
            ? 'new_item'
            : trigger?.number !== undefined
              ? 'number'
              : trigger?.availability !== undefined
                ? 'availability'
                : 'any_change',
    minLines: Math.max(1, trigger?.anyChange?.minChangedLines ?? 1),
    text: trigger?.textAppears?.text ?? trigger?.textDisappears?.text ?? '',
    minItems: Math.max(1, trigger?.newItem?.minNewItems ?? 1),
    upper: trigger?.number?.upperThreshold === undefined ? '' : String(trigger.number.upperThreshold),
    lower: trigger?.number?.lowerThreshold === undefined ? '' : String(trigger.number.lowerThreshold),
    changePercent: trigger?.number?.changePercent ?? 0,
    label: trigger?.number?.label ?? '',
    onlyWhenAvailable: trigger?.availability?.onlyWhenAvailable ?? true,
    skipConfirmation: watch.stability?.skipConfirmation ?? false,
    interval: watch.checkIntervalMinutes === 0 ? 360 : watch.checkIntervalMinutes,
    urgent: watch.notifyPolicy === Watch_NotifyPolicy.URGENT,
    shadow: watch.shadowMode,
    allowHttp: watch.fetchPolicy?.allowHttp ?? false,
    ignoreRobots: watch.fetchPolicy?.ignoreRobots ?? false,
    ignoredLines: [...(watch.normalize?.ignoredLines ?? [])],
    locale: watch.requestLocale,
  }
}

const number = (text: string): number | undefined => (text.trim() === '' || !Number.isFinite(Number(text)) ? undefined : Number(text))

/** The Watch a Draft writes (every field the owner sets). */
export function watchOf(draft: Draft): MessageInitShape<typeof WatchSchema> {
  const source =
    draft.source === 'feed'
      ? { feed: {} }
      : draft.source === 'json'
        ? { json: { path: draft.jsonPath.trim() } }
        : draft.source === 'embedded'
          ? { embedded: { kind: draft.embedded === 'next_data' ? EmbeddedSource_Kind.NEXT_DATA : EmbeddedSource_Kind.JSON_LD, path: draft.jsonPath.trim() } }
          : { html: { includeSelectors: draft.include, excludeSelectors: draft.exclude, keepLinks: draft.keepLinks } }
  const trigger =
    draft.trigger === 'text_appears'
      ? { textAppears: { text: draft.text.trim() } }
      : draft.trigger === 'text_disappears'
        ? { textDisappears: { text: draft.text.trim() } }
        : draft.trigger === 'new_item'
          ? { newItem: { minNewItems: draft.minItems } }
          : draft.trigger === 'number'
            ? { number: { upperThreshold: number(draft.upper), lowerThreshold: number(draft.lower), changePercent: draft.changePercent, label: draft.label.trim() } }
            : draft.trigger === 'availability'
              ? { availability: { onlyWhenAvailable: draft.onlyWhenAvailable } }
              : { anyChange: { minChangedLines: draft.minLines } }
  return {
    name: draft.name,
    etag: draft.etag,
    displayName: draft.displayName.trim(),
    uri: draft.uri.trim(),
    source,
    trigger,
    normalize: { ignoredLines: draft.ignoredLines },
    stability: { skipConfirmation: draft.skipConfirmation },
    checkIntervalMinutes: draft.interval,
    notifyPolicy: draft.urgent ? Watch_NotifyPolicy.URGENT : Watch_NotifyPolicy.DIGEST,
    requestLocale: draft.locale.trim(),
    fetchPolicy: { allowHttp: draft.allowHttp, ignoreRobots: draft.ignoreRobots },
    shadowMode: draft.shadow,
  }
}

type Field = keyof Draft

/** A labelled control bound to `draft[field]`; `onInput` runs after every edit. */
function bind(draft: Draft, field: Field, control: HTMLInputElement | HTMLSelectElement, onInput: () => void): HTMLInputElement | HTMLSelectElement {
  const record = draft as unknown as Record<Field, unknown>
  const current = record[field]
  if (control instanceof HTMLInputElement && control.type === 'checkbox') control.checked = current === true
  else control.value = String(current)
  control.addEventListener(control instanceof HTMLSelectElement || (control instanceof HTMLInputElement && control.type === 'checkbox') ? 'change' : 'input', () => {
    if (control instanceof HTMLInputElement && control.type === 'checkbox') record[field] = control.checked
    else if (typeof current === 'number') record[field] = Number(control.value)
    else record[field] = control.value
    onInput()
  })
  return control
}

function select(options: readonly (readonly [string | number, string])[]): HTMLSelectElement {
  return el('select', {}, ...options.map(([value, label]) => el('option', { value: String(value) }, label)))
}

function labelled(text: string, control: Child, hint?: string): HTMLElement {
  return el('label', { class: 'field' }, el('span', { class: 'label' }, text), control, hint === undefined ? null : el('span', { class: 'hint' }, hint))
}

function check(text: string, control: HTMLInputElement | HTMLSelectElement, hint?: string): HTMLElement {
  return el('label', { class: 'check' }, control, el('span', {}, text), hint === undefined ? null : el('span', { class: 'hint' }, hint))
}

/** A settings form: its element, and `sync` to show the draft again after code changed it. */
export interface SettingsForm {
  readonly element: HTMLElement
  readonly sync: () => void
}

/** The settings form (without the URL, which the views place themselves). `onInput` runs after every edit. */
export function settingsForm(draft: Draft, onInput: () => void): SettingsForm {
  const form = el('div', { class: 'settings' })
  const render = () => {
    const changed = () => {
      onInput()
      render()
    }
    const input = (field: Field, attributes: Record<string, string> = {}) => bind(draft, field, el('input', attributes), onInput)
    const box = (field: Field) => bind(draft, field, el('input', { type: 'checkbox' }), changed)
    const sourceSelect = bind(draft, 'source', select([['html', '网页文字'], ['feed', '订阅源（RSS / Atom / JSON Feed）'], ['json', 'JSON 接口'], ['embedded', '网页内嵌数据（JSON-LD / Next.js）']]), changed)
    const triggerSelect = bind(
      draft,
      'trigger',
      select([['any_change', '任何变化'], ['text_appears', '出现某段文字'], ['text_disappears', '某段文字消失'], ['new_item', '出现新条目'], ['number', '数值越过阈值或变动'], ['availability', '供货状态变化']]),
      changed,
    )
    const triggerFields: HTMLElement[] = []
    if (draft.trigger === 'any_change') triggerFields.push(labelled('至少变化几行', input('minLines', { type: 'number', min: '1', max: '1000', inputmode: 'numeric' })))
    if (draft.trigger === 'text_appears' || draft.trigger === 'text_disappears') triggerFields.push(labelled('文字', input('text', { maxlength: '200' }), '不区分大小写'))
    if (draft.trigger === 'new_item') triggerFields.push(labelled('至少几个新条目', input('minItems', { type: 'number', min: '1', max: '100', inputmode: 'numeric' })))
    if (draft.trigger === 'number') {
      triggerFields.push(
        labelled('数值前的文字', input('label', { maxlength: '100', placeholder: '例如 价格：' }), '留空：页面上的第一个数'),
        labelled('高于或等于', input('upper', { inputmode: 'decimal' })),
        labelled('低于或等于', input('lower', { inputmode: 'decimal' })),
        labelled('变动超过（%）', input('changePercent', { type: 'number', min: '0', max: '10000', inputmode: 'numeric' }), '相对上次通知时的数值；0 表示不用'),
      )
    }
    if (draft.trigger === 'availability') triggerFields.push(check('只在变为可购买时提醒', box('onlyWhenAvailable')))
    const sourceFields: HTMLElement[] = []
    if (draft.source === 'json' || draft.source === 'embedded') sourceFields.push(labelled('JSONPath', input('jsonPath', { placeholder: '$.items[*].name', spellcheck: 'false', autocapitalize: 'none' }), '只支持 $、.名称、[序号]、[*]'))
    if (draft.source === 'embedded') sourceFields.push(labelled('内嵌数据', bind(draft, 'embedded', select([['json_ld', 'JSON-LD（schema.org）'], ['next_data', 'Next.js 页面数据']]), changed)))
    if (draft.source === 'html') sourceFields.push(check('链接地址变化也算变化', box('keepLinks')))
    fill(
      form,
      labelled('名称', input('displayName', { maxlength: '80', placeholder: '例如 水壶价格' })),
      labelled('数据来源', sourceSelect),
      ...sourceFields,
      labelled('提醒条件', triggerSelect),
      ...triggerFields,
      labelled('检查频率', bind(draft, 'interval', select(INTERVALS), onInput)),
      draft.source === 'html' ? check('不等待二次确认', box('skipConfirmation'), '默认约 15 分钟后再抓一次，确认变化不是一闪而过') : null,
      check('紧急提醒（不进每日摘要）', box('urgent')),
      check('影子模式（7 天）', box('shadow'), '把会被过滤的变化也显示出来，方便调整规则'),
      check('允许 http（不加密）', box('allowHttp'), draft.allowHttp ? '页面内容将以明文传输' : undefined),
      check('忽略 robots.txt', box('ignoreRobots'), draft.ignoreRobots ? '只用于你有权抓取的页面' : undefined),
      draft.ignoredLines.length > 0 ? el('p', { class: 'hint' }, `已忽略 ${String(draft.ignoredLines.length)} 行`) : null,
    )
  }
  render()
  return { element: form, sync: render }
}

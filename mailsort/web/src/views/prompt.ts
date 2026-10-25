/** The current base prompt and personal rules, edited without rebuilding the settings page. */
import { create } from '@ziyixi/proto/protobuf'
import { ClassificationPromptSchema, type ClassificationPrompt } from '@ziyixi/proto/mailsort/ui/v2/prompt_pb'
import { api, errorMessage, newRequestId, withRetry } from '../api.ts'
import { card } from '../components.ts'
import { button, el } from '../dom.ts'
import { when } from '../format.ts'

const MAX_PROMPT_BYTES = 12 * 1024
const encoder = new TextEncoder()

export function promptCard(): HTMLElement {
  let saved: ClassificationPrompt | null = null
  let busy = false
  let reloadAvailable = false
  const personal = el('textarea', { id: 'classification-personal-rules', rows: '8', spellcheck: 'false' })
  const base = el('textarea', { id: 'classification-base-text', rows: '14', spellcheck: 'false' })
  const state = el('p', { class: 'hint', role: 'status' })
  const size = el('p', { class: 'meta' })
  const validation = el('p', { class: 'hint warn', role: 'status', hidden: true })
  const feedback = el('p', { class: 'hint', role: 'status', hidden: true })
  const reloadHint = el('p', { class: 'hint', hidden: true }, '重新加载会替换当前未保存的内容。')
  const save = button('保存', () => void persist(), { class: 'primary' })
  const reload = button('重新加载', () => void load(), { hidden: true })

  const paint = () => {
    const dirty = saved !== null && (base.value !== saved.baseText || personal.value !== saved.personalRules)
    const bytes = encoder.encode(base.value).byteLength + encoder.encode(personal.value).byteLength
    let invalid = ''
    if (saved !== null) {
      if (base.value.trim() === '') invalid = '基础提示词不能为空。'
      else if (bytes > MAX_PROMPT_BYTES) invalid = '两段文本合计最多 12 KiB（UTF-8），请缩短后保存。'
    }
    personal.readOnly = busy || saved === null
    base.readOnly = busy || saved === null
    save.disabled = busy || saved === null || invalid !== '' || (!dirty && saved.updateTime !== undefined)
    save.textContent = busy && saved !== null ? '保存中…' : '保存'
    reload.hidden = !reloadAvailable
    reload.disabled = busy
    reloadHint.hidden = !reloadAvailable || !dirty
    size.textContent = `${String(bytes)} / ${String(MAX_PROMPT_BYTES)} 字节（UTF-8）`
    validation.textContent = invalid
    validation.hidden = invalid === ''
    if (saved === null) state.textContent = busy ? '正在读取提示词…' : ''
    else if (dirty) state.textContent = '有未保存的修改。'
    else if (saved.updateTime === undefined) state.textContent = '当前为默认内容，尚未保存。'
    else state.textContent = `上次保存 ${when(saved.updateTime)}`
  }

  const fail = (prefix: string, error: unknown) => {
    feedback.textContent = `${prefix}：${errorMessage(error)}`
    feedback.className = 'hint warn'
    feedback.hidden = false
    reloadAvailable = true
  }

  const load = async () => {
    if (busy) return
    busy = true
    feedback.hidden = true
    paint()
    try {
      saved = await api.getClassificationPrompt({ name: 'classificationPrompt' })
      base.value = saved.baseText
      personal.value = saved.personalRules
      reloadAvailable = false
    } catch (error) {
      fail('提示词读取失败', error)
    }
    busy = false
    paint()
  }

  const persist = async () => {
    if (save.disabled || saved === null) return
    const classificationPrompt = create(ClassificationPromptSchema, { name: 'classificationPrompt', baseText: base.value, personalRules: personal.value, etag: saved.etag })
    const requestId = newRequestId()
    busy = true
    feedback.hidden = true
    paint()
    try {
      saved = await withRetry(() => api.updateClassificationPrompt({ classificationPrompt, updateMask: { paths: ['base_text', 'personal_rules', 'etag'] }, requestId }))
      reloadAvailable = false
      feedback.textContent = '已保存，从下一批开始使用。'
      feedback.className = 'hint'
      feedback.hidden = false
    } catch (error) {
      fail('提示词未保存', error)
    }
    busy = false
    paint()
  }

  for (const field of [personal, base]) field.addEventListener('input', () => {
    feedback.hidden = true
    paint()
  })

  const box = card('分类提示词', '',
    el('p', { class: 'hint' }, '这两段文本会原样发送给 Claude。保存对下一批生效，不会自动重判已分类邮件。'),
    el('div', { class: 'prompt-editor' },
      el('label', { for: personal.id }, el('span', {}, '个人规则'), personal),
      el('details', { class: 'prompt-core' }, el('summary', {}, '基础提示词'), el('label', { for: base.id }, el('span', { class: 'visually-hidden' }, '基础提示词'), base)),
      size, validation, state, feedback, reloadHint,
      el('div', { class: 'actions' }, save, reload),
    ),
  )
  box.classList.add('prompt-card')
  void load()
  return box
}

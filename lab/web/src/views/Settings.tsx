/**
 * 设置 (docs/ux.md §6): categories, the 简介 model, the daily neuron cap (can only go below the Worker's
 * ceiling), the default send mode, the ingest pause and λ (advanced). Seeds are the cold-start entry and
 * are linked from here.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Sprout } from 'lucide-react'
import { useId, useState, type FormEvent } from 'react'
import { SendMode } from '@ziyixi/proto/lab/ui/v1/deck_pb'
import type { Settings } from '@ziyixi/proto/lab/ui/v1/home_pb'
import { CATEGORIES_MAX } from '../../../worker/src/limits.ts'
import { errorMessage, lab, withRetry } from '../api/client'
import { useFeedback } from '../components/Feedback'
import { Link } from '../components/Link'
import { newOpId } from '../lib/format'

const CATEGORY = /^[a-z-]+(?:\.[A-Za-z-]+)?$/

export function parseCategories(text: string): { readonly ok: readonly string[]; readonly bad: readonly string[] } {
  const parts = text
    .split(/[\s,，、]+/)
    .map((part) => part.trim())
    .filter((part) => part !== '')
  const ok: string[] = []
  const bad: string[] = []
  for (const part of parts) {
    if (!CATEGORY.test(part)) bad.push(part)
    else if (!ok.includes(part)) ok.push(part)
  }
  return { ok, bad }
}

/** The editable Settings fields (proto names) whose value differs between `before` and `after`, in field order. */
export function changedPaths(before: Settings, after: Settings): string[] {
  const same: Readonly<Record<string, (a: Settings, b: Settings) => boolean>> = {
    categories: (a, b) => a.categories.join('\n') === b.categories.join('\n'),
    dislike_weight: (a, b) => a.dislikeWeight === b.dislikeWeight,
    neuron_cap: (a, b) => a.neuronCap === b.neuronCap,
    summary_model: (a, b) => a.summaryModel === b.summaryModel,
    ingest_paused: (a, b) => a.ingestPaused === b.ingestPaused,
    send_mode: (a, b) => a.sendMode === b.sendMode,
  }
  return Object.entries(same)
    .filter(([, equal]) => !equal(before, after))
    .map(([path]) => path)
}

const MODEL_NAMES: Readonly<Record<string, string>> = {
  '@cf/ibm-granite/granite-4.0-h-micro': 'Granite 4.0 Micro（默认，最省额度）',
  '@cf/meta/llama-3.2-1b-instruct': 'Llama 3.2 1B',
  '@cf/qwen/qwen3-30b-a3b-fp8': 'Qwen3 30B（中文更好，额度约 1.5 倍）',
}

export function SettingsView() {
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => lab.getSettings({ name: 'settings' }) })
  return (
    <section className="panel" aria-labelledby="settings-title">
      <h1 id="settings-title">设置</h1>
      <div className="settings-seeds">
        <Sprout size={18} aria-hidden="true" />
        <p>
          推荐从种子和你的喜欢出发。<Link to={{ view: 'seeds' }}>管理种子论文</Link>
        </p>
      </div>
      {settings.isPending ? <p className="muted">正在加载…</p> : null}
      {settings.isError ? <p role="alert">没有加载出来：{errorMessage(settings.error)}</p> : null}
      {/* The form keeps its own state after the first load (a save answers with what was sent). */}
      {settings.data ? <SettingsForm initial={settings.data} /> : null}
    </section>
  )
}

function SettingsForm({ initial }: { initial: Settings }) {
  const client = useQueryClient()
  const { announce } = useFeedback()
  const ids = { categories: useId(), model: useId(), cap: useId(), lambda: useId(), pause: useId() }
  const [categories, setCategories] = useState(initial.categories.join(', '))
  const [model, setModel] = useState(initial.summaryModel)
  const [cap, setCap] = useState(String(initial.neuronCap))
  const [mode, setMode] = useState<SendMode>(initial.sendMode)
  const [paused, setPaused] = useState(initial.ingestPaused)
  const [lambda, setLambda] = useState(initial.dislikeWeight)
  const [message, setMessage] = useState<string | null>(null)

  const parsed = parseCategories(categories)
  const capValue = Number(cap)
  const capOk = Number.isInteger(capValue) && capValue >= 0 && capValue <= initial.neuronCeiling
  const categoriesOk = parsed.bad.length === 0 && parsed.ok.length > 0 && parsed.ok.length <= CATEGORIES_MAX
  const valid = capOk && categoriesOk

  const save = useMutation({
    mutationFn: ({ next, paths }: { next: Settings; paths: readonly string[] }) => {
      // AIP-134: the fields that changed, by update_mask; nothing changed saves the whole form (no mask).
      const request = { settings: next, requestId: newOpId(), ...(paths.length > 0 ? { updateMask: { paths: [...paths] } } : {}) }
      return withRetry(() => lab.updateSettings(request))
    },
    onSuccess: (next) => {
      client.setQueryData(['settings'], next)
      setMessage('已保存，下一次排序生效')
      announce('设置已保存')
    },
    onError: (error) => setMessage(`没有保存：${errorMessage(error)}`),
  })

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (!valid) return
    const next = { ...initial, categories: [...parsed.ok], summaryModel: model, neuronCap: capValue, sendMode: mode, ingestPaused: paused, dislikeWeight: lambda }
    save.mutate({ next, paths: changedPaths(initial, next) })
  }

  return (
    <form className="settings-form" onSubmit={onSubmit} noValidate>
      <div className="field">
        <label htmlFor={ids.categories}>arXiv 分类</label>
        <input id={ids.categories} value={categories} onChange={(event) => setCategories(event.target.value)} aria-invalid={!categoriesOk} lang="en" />
        <p className="muted small">用逗号或空格分隔，最多 {CATEGORIES_MAX} 个，例如 cs.IR, cs.CL, cs.LG。</p>
        {parsed.bad.length > 0 ? <p className="field-error">无法识别：{parsed.bad.join('、')}</p> : null}
        {parsed.ok.length > CATEGORIES_MAX ? <p className="field-error">最多 {CATEGORIES_MAX} 个分类</p> : null}
      </div>

      <div className="field">
        <label htmlFor={ids.model}>简介模型</label>
        <select id={ids.model} value={model} onChange={(event) => setModel(event.target.value)}>
          {initial.summaryModels.map((id) => (
            <option key={id} value={id}>
              {MODEL_NAMES[id] ?? id}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label htmlFor={ids.cap}>每日 AI 额度上限（neurons）</label>
        <input id={ids.cap} type="number" inputMode="numeric" min={0} max={initial.neuronCeiling} step={100} value={cap} onChange={(event) => setCap(event.target.value)} aria-invalid={!capOk} />
        <p className="muted small">只能调低，不能超过 {initial.neuronCeiling}。平时一天约用 340。</p>
        {!capOk ? <p className="field-error">请输入 0 到 {initial.neuronCeiling} 之间的整数</p> : null}
      </div>

      <fieldset className="field">
        <legend>发送到 Todofy 的默认方式</legend>
        <label className="radio">
          <input type="radio" name="send-mode" checked={mode === SendMode.SUBTASKS} onChange={() => setMode(SendMode.SUBTASKS)} /> 一个父任务 + 子任务
        </label>
        <label className="radio">
          <input type="radio" name="send-mode" checked={mode === SendMode.SEPARATE} onChange={() => setMode(SendMode.SEPARATE)} /> 每篇单独一条
        </label>
      </fieldset>

      <div className="field">
        <label className="checkbox" htmlFor={ids.pause}>
          <input id={ids.pause} type="checkbox" checked={paused} onChange={(event) => setPaused(event.target.checked)} /> 暂停抓取新论文
        </label>
      </div>

      <details className="field advanced">
        <summary>高级</summary>
        <label htmlFor={ids.lambda}>不喜欢的权重 λ：{lambda.toFixed(2)}</label>
        <input id={ids.lambda} type="range" min={0} max={1} step={0.05} value={lambda} onChange={(event) => setLambda(Number(event.target.value))} />
        <p className="muted small">越大，越远离你不喜欢的论文。</p>
      </details>

      <div className="button-row">
        <button type="submit" className="btn btn-primary" disabled={!valid || save.isPending}>
          {save.isPending ? '正在保存…' : '保存'}
        </button>
      </div>
      <p className="muted" aria-live="polite">
        {message}
      </p>
    </form>
  )
}

import { Play, Plus, Trash2 } from 'lucide-react'
import { useMutation } from '@tanstack/react-query'
import { useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import type {
  GenerateRequest,
  Instruction,
  Model,
} from '@ziyixi/proto/modelrouter/inference/v1/inference_wire'
import type { RouterApi } from './api'
import { Failure, GenerationOutput, Status, UsageDetails } from './components'
import { modelLabel, modelName, providerLabel, requestId } from './format'

export interface PlaygroundDraft {
  request?: GenerateRequest
  sourceRequest?: string
}
function validateSchema(text: string): string | null {
  if (!text.trim()) return null
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === 'boolean' ||
      (value !== null && typeof value === 'object' && !Array.isArray(value))
      ? null
      : 'JSON Schema 需为对象或布尔值。'
  } catch {
    return 'JSON Schema 格式无效，请检查 JSON。'
  }
}

export function Playground({
  models,
  api,
  initial = {},
  onGenerated,
}: {
  models: readonly Model[]
  api: RouterApi
  initial?: PlaygroundDraft
  onGenerated: () => void
}) {
  const form = useRef<HTMLFormElement>(null)
  const formId = useId()
  const original = initial.request
  const [selectedId, setSelectedId] = useState(original?.model ?? '')
  const [instructions, setInstructions] = useState<Instruction[]>(
    original?.instructions?.length ? [...original.instructions] : [{ text: '' }],
  )
  const [input, setInput] = useState(original?.input ?? '')
  const [effort, setEffort] = useState(original?.effort ?? '')
  const [maxOutput, setMaxOutput] = useState(original?.max_output_tokens?.toString() ?? '')
  const [allowFallback, setAllowFallback] = useState(original?.allow_fallback ?? false)
  const [schema, setSchema] = useState(original?.output_schema_json ?? '')
  const [validation, setValidation] = useState<string | null>(null)
  const textModels = models.filter((model) => model.kind === 'text')
  const selected =
    textModels.find((model) => model.id === selectedId) ?? (!selectedId ? textModels[0] : undefined)
  const generate = useMutation({
    mutationFn: (request: GenerateRequest) => api.generate(request),
    retry: false,
    onSuccess: onGenerated,
  })
  const resultProvider = models.find((model) => model.id === generate.variables?.model)?.provider
  function changeModel(id: string) {
    setSelectedId(id)
    setEffort('')
    setMaxOutput('')
    setAllowFallback(false)
    setValidation(null)
  }
  function updateInstruction(index: number, update: Partial<Instruction>) {
    setInstructions((current) =>
      current.map((block, position) => (position === index ? { ...block, ...update } : block)),
    )
  }
  function submit(event: FormEvent) {
    event.preventDefault()
    if (generate.isPending || !selected?.configured || !selected.id || !input.trim()) return
    const schemaError = validateSchema(schema)
    if (schemaError) {
      setValidation(schemaError)
      return
    }
    setValidation(null)
    generate.mutate({
      model: selected.id,
      input,
      instructions: instructions.filter((block) => block.text?.trim()),
      ...(selected.efforts?.includes(effort) ? { effort } : {}),
      ...(maxOutput ? { max_output_tokens: Number(maxOutput) } : {}),
      ...(schema.trim() ? { output_schema_json: schema.trim() } : {}),
      ...(allowFallback ? { allow_fallback: true } : {}),
      ...(original?.timeout_ms ? { timeout_ms: original.timeout_ms } : {}),
    })
  }
  function shortcut(event: KeyboardEvent<HTMLFormElement>) {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      form.current?.requestSubmit()
    }
  }
  return (
    <div className="playground-layout">
      <section className="panel playground-form">
        <div className="section-heading">
          <div>
            <h2>新推理</h2>
            <p className="small muted">请求来源由登录身份确定。</p>
          </div>
          <span className="tag">仅运行推理</span>
        </div>
        {initial.sourceRequest && (
          <p className="notice subtle small">
            已复制请求 {initial.sourceRequest}。运行后会创建新的单次推理
            {original?.conversation ? '，不会继承原会话上下文' : ''}。
          </p>
        )}
        <form ref={form} onSubmit={submit} onKeyDown={shortcut}>
          <p className="small muted">
            Claude 调用计入供应商处的共享消费上限。此处只运行推理，不执行应用业务操作。
          </p>
          <label>
            模型
            <select
              aria-label="模型"
              value={selectedId || selected?.id || ''}
              onChange={(event) => changeModel(event.target.value)}
              disabled={generate.isPending}
              required
            >
              {!textModels.length && <option value="">暂无文本模型</option>}
              {selectedId && !selected && (
                <option value={selectedId}>
                  {providerLabel(models.find((model) => model.id === selectedId)?.provider)} ·{' '}
                  {modelName(selectedId)}（此处不可运行）
                </option>
              )}
              {textModels.map((model) => (
                <option key={model.id} value={model.id}>
                  {modelLabel(model)}
                  {!model.configured ? '（未配置）' : ''}
                </option>
              ))}
            </select>
          </label>
          {selected && (
            <div className="model-hint small muted">
              <span>{providerLabel(selected.provider)}</span>
              <code>{selected.id}</code>
              {!selected.configured && <span className="danger-text">连接未配置，暂不可运行。</span>}
            </div>
          )}
          {Boolean(selected?.efforts?.length) && (
            <label>
              推理强度
              <select
                value={selected?.efforts?.includes(effort) ? effort : ''}
                onChange={(event) => setEffort(event.target.value)}
                disabled={generate.isPending}
              >
                <option value="">默认</option>
                {selected?.efforts?.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
          )}
          <fieldset className="instruction-fieldset" disabled={generate.isPending}>
            <legend>
              Instructions <span className="muted">可选</span>
            </legend>
            {instructions.map((block, index) => (
              <div className="instruction-block" key={index}>
                <label className="visually-hidden" htmlFor={`${formId}-instruction-${index}`}>
                  Instructions {index + 1}
                </label>
                <textarea
                  id={`${formId}-instruction-${index}`}
                  rows={3}
                  value={block.text ?? ''}
                  onChange={(event) => updateInstruction(index, { text: event.target.value })}
                  placeholder="说明模型应如何处理输入"
                />
                <div className="instruction-actions">
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={block.cache ?? false}
                      onChange={(event) => updateInstruction(index, { cache: event.target.checked })}
                    />
                    稳定内容，可用于提示缓存
                  </label>
                  {instructions.length > 1 && (
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`删除 Instructions ${index + 1}`}
                      onClick={() =>
                        setInstructions((current) => current.filter((_, position) => position !== index))
                      }
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              </div>
            ))}
            <button
              type="button"
              className="text-button"
              onClick={() => setInstructions((current) => [...current, { text: '' }])}
            >
              <Plus size={14} />
              添加指令块
            </button>
          </fieldset>
          <div className="field">
            <label htmlFor={`${formId}-input`}>输入</label>
            <textarea
              id={`${formId}-input`}
              rows={8}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              required
              disabled={generate.isPending}
              placeholder="输入文本，或序列化的 JSON"
            />
          </div>
          <details className="schema-editor" open={Boolean(original?.output_schema_json)}>
            <summary>
              JSON Schema <span className="muted small">可选，留空返回文本</span>
            </summary>
            <label className="visually-hidden" htmlFor={`${formId}-schema`}>
              JSON Schema
            </label>
            <textarea
              id={`${formId}-schema`}
              className="mono"
              rows={6}
              value={schema}
              disabled={generate.isPending}
              onChange={(event) => {
                setSchema(event.target.value)
                setValidation(null)
              }}
              placeholder={'{ "type": "object", "properties": { … } }'}
            />
          </details>
          <details
            className="advanced-options"
            open={Boolean(original?.max_output_tokens || original?.allow_fallback)}
          >
            <summary>其他选项</summary>
            <label>
              最大输出 token
              <input
                type="number"
                min="1"
                step="1"
                placeholder="默认"
                value={maxOutput}
                onChange={(event) => setMaxOutput(event.target.value)}
                disabled={generate.isPending}
              />
            </label>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={allowFallback}
                onChange={(event) => setAllowFallback(event.target.checked)}
                disabled={generate.isPending}
              />
              允许供应商原生回退
            </label>
          </details>
          {validation && (
            <p role="alert" className="danger-text small">
              {validation}
            </p>
          )}
          <div className="form-footer">
            <span className="small muted">⌘ / Ctrl + Enter 运行</span>
            <button
              type="submit"
              className="primary"
              disabled={generate.isPending || !selected?.configured || !input.trim()}
            >
              <Play size={15} aria-hidden="true" />
              {generate.isPending ? '推理中…' : '运行推理'}
            </button>
          </div>
        </form>
      </section>
      <section className="panel playground-result" aria-label="推理结果" aria-busy={generate.isPending}>
        <div className="section-heading">
          <h2>结果</h2>
          {generate.data && <Status state={generate.data.error ? 'failed' : 'succeeded'} />}
        </div>
        {generate.isPending && (
          <p className="notice subtle" role="status">
            正在等待完整结果。此请求只运行模型推理。
          </p>
        )}
        {generate.error && <Failure error={generate.error} />}
        {!generate.data && !generate.isPending && !generate.error && (
          <div className="empty-state">
            <Play size={25} aria-hidden="true" />
            <h3>运行后在这里查看结果</h3>
            <p>输入、输出保留 7 天，请求元数据保留 90 天。</p>
          </div>
        )}
        {generate.data && (
          <div className="result-content">
            <GenerationOutput generation={generate.data} />
            <dl className="facts compact">
              <dt>执行模型</dt>
              <dd>
                {providerLabel(resultProvider)} · {modelName(generate.data.model)}
              </dd>
              <dt>请求记录</dt>
              <dd>
                <a className="record-link" href={`#/${generate.data.name}`}>
                  {requestId(generate.data.name)}
                </a>
              </dd>
            </dl>
            <UsageDetails usage={generate.data.usage} />
          </div>
        )}
      </section>
    </div>
  )
}

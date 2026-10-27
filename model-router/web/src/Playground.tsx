import { Play, Plus, Trash2 } from 'lucide-react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import type {
  GenerateRequest,
  GenerationConfig,
  Instruction,
  Model,
  Parameters,
} from '@ziyixi/proto/modelrouter/inference/v1/inference_wire'
import type { RouterApi } from './api'
import { Failure, GenerationOutput, Status, UsageDetails } from './components'
import { duration, modelName } from './format'

export interface PlaygroundDraft {
  config?: GenerationConfig
  input?: string
  sourceRequest?: string
}

function validateSchema(text: string): string | null {
  if (!text.trim()) return null
  try {
    const value: unknown = JSON.parse(text)
    if (typeof value === 'boolean' || (value !== null && typeof value === 'object' && !Array.isArray(value)))
      return null
    return 'JSON Schema 需为对象或布尔值。'
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
  const [billingApp, setBillingApp] = useState('console')
  const [selectedName, setSelectedName] = useState(initial.config?.model ?? '')
  const [instructions, setInstructions] = useState<Instruction[]>([
    ...(initial.config?.instructions?.length ? initial.config.instructions : [{ text: '' }]),
  ])
  const [input, setInput] = useState(initial.input ?? '')
  const [effort, setEffort] = useState(initial.config?.parameters?.effort ?? '')
  const [temperature, setTemperature] = useState(initial.config?.parameters?.temperature?.toString() ?? '')
  const [maxOutput, setMaxOutput] = useState(initial.config?.parameters?.max_output_tokens?.toString() ?? '')
  const [schema, setSchema] = useState(initial.config?.output_schema_json ?? '')
  const [webResearch, setWebResearch] = useState(initial.config?.web_research ?? false)
  const [validation, setValidation] = useState<string | null>(null)
  const billingModels = useQuery({
    queryKey: ['router-models', billingApp],
    queryFn: () => api.listModels(billingApp),
    enabled: billingApp !== 'console',
  })
  const generationModels = (billingApp === 'console' ? models : (billingModels.data ?? [])).filter(
    (model) => model.generation,
  )
  const selected =
    generationModels.find((model) => model.name === selectedName) ?? (!selectedName ? generationModels[0] : undefined)
  const generate = useMutation({
    mutationFn: (request: GenerateRequest) => api.generate(request),
    retry: false,
    onSuccess: onGenerated,
  })

  function changeModel(name: string) {
    setSelectedName(name)
    setEffort('')
    setTemperature('')
    setMaxOutput('')
    setWebResearch(false)
    setValidation(null)
  }

  function updateInstruction(index: number, update: Partial<Instruction>) {
    setInstructions((current) =>
      current.map((block, position) => (position === index ? { ...block, ...update } : block)),
    )
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    if (generate.isPending || !selected?.configured || !selected.name || !input.trim()) return
    const schemaError = validateSchema(schema)
    if (schemaError) {
      setValidation(schemaError)
      return
    }
    const parameters: Parameters = {
      ...(selected.efforts?.includes(effort) ? { effort } : {}),
      ...(selected.temperature && temperature !== '' ? { temperature: Number(temperature) } : {}),
      ...(selected.max_output_tokens && maxOutput !== '' ? { max_output_tokens: Number(maxOutput) } : {}),
      ...(initial.config?.parameters?.allow_fallback ? { allow_fallback: true } : {}),
    }
    const config: GenerationConfig = {
      model: selected.name,
      instructions: instructions.filter((block) => block.text?.trim()),
      parameters,
      ...(schema.trim() ? { output_schema_json: schema.trim() } : {}),
      ...(selected.web_research && webResearch ? { web_research: true } : {}),
    }
    setValidation(null)
    generate.mutate({ request_id: crypto.randomUUID(), config, input, metadata: { billing_app: billingApp } })
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
          <p className="notice subtle small">已复制请求 {initial.sourceRequest} 的输入。运行后会产生新的推理请求。</p>
        )}
        <form ref={form} onSubmit={submit} onKeyDown={shortcut}>
          <label>
            计费配置
            <select
              value={billingApp}
              disabled={generate.isPending}
              onChange={(event) => {
                setBillingApp(event.target.value)
              }}
            >
              <option value="console">Console（本控制台）</option>
              <option value="mailsort">Mailsort</option>
              <option value="todofy">Todofy</option>
              <option value="brief">Brief</option>
              <option value="newsletter">Newsletter</option>
            </select>
          </label>
          <p className="small muted billing-note">
            使用所选应用的模型连接与预算。请求来源仍为本控制台，不执行该应用的业务操作。
          </p>
          {billingModels.isFetching && billingApp !== 'console' && (
            <p className="small muted" role="status">
              正在读取此计费配置的模型…
            </p>
          )}
          {billingModels.error && billingApp !== 'console' && <Failure error={billingModels.error} />}
          <label>
            模型
            <select
              value={selectedName || selected?.name || ''}
              onChange={(event) => changeModel(event.target.value)}
              disabled={generate.isPending}
              required
            >
              {!generationModels.length && <option value="">暂无生成模型</option>}
              {selectedName && !selected && (
                <option value={selectedName}>{modelName(selectedName)}（当前目录不可用）</option>
              )}
              {generationModels.map((model) => (
                <option key={model.name} value={model.name}>
                  {model.display_name || modelName(model.name)}
                  {!model.configured ? '（未配置）' : ''}
                </option>
              ))}
            </select>
          </label>
          {selected && (
            <div className="model-hint small muted">
              <span>{selected.provider}</span>
              <code>{selected.upstream_model}</code>
              {!selected.configured && <span className="danger-text">连接未配置，暂不可运行。</span>}
            </div>
          )}
          <fieldset className="parameters" disabled={generate.isPending}>
            <legend>
              参数 <span className="muted">留空使用模型默认值</span>
            </legend>
            <label>
              推理强度
              <select
                value={selected?.efforts?.includes(effort) ? effort : ''}
                disabled={!selected?.efforts?.length}
                onChange={(event) => setEffort(event.target.value)}
              >
                <option value="">{selected?.efforts?.length ? '默认' : '不支持'}</option>
                {selected?.efforts?.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Temperature
              <input
                type="number"
                step="any"
                value={selected?.temperature ? temperature : ''}
                placeholder={selected?.temperature ? '默认' : '不支持'}
                disabled={!selected?.temperature}
                onChange={(event) => setTemperature(event.target.value)}
              />
            </label>
            <label>
              最大输出 token
              <input
                type="number"
                min="1"
                max="2147483647"
                step="1"
                value={selected?.max_output_tokens ? maxOutput : ''}
                placeholder={selected?.max_output_tokens ? '默认' : '不支持'}
                disabled={!selected?.max_output_tokens}
                onChange={(event) => setMaxOutput(event.target.value)}
              />
            </label>
          </fieldset>
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
                      onClick={() => setInstructions((current) => current.filter((_, position) => position !== index))}
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
          <details className="schema-editor" open={Boolean(initial.config?.output_schema_json)}>
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
          {selected?.web_research && (
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={webResearch}
                disabled={generate.isPending}
                onChange={(event) => setWebResearch(event.target.checked)}
              />
              要求实际网页检索观测
            </label>
          )}
          {initial.config?.parameters?.allow_fallback && <p className="small muted">沿用原请求允许的模型回退策略。</p>}
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
          {generate.data && <Status state={generate.data.state} />}
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
            <p>输入、输出保留 7 天，请求记录保留 90 天。</p>
            <p>应用业务操作不会在此运行。</p>
          </div>
        )}
        {generate.data && (
          <div className="result-content">
            <GenerationOutput generation={generate.data} />
            <dl className="facts compact">
              <dt>请求模型</dt>
              <dd>{modelName(generate.data.model)}</dd>
              <dt>服务报告模型</dt>
              <dd>{generate.data.reported_model || '未提供'}</dd>
              <dt>耗时</dt>
              <dd>{duration(generate.data.duration_ms)}</dd>
            </dl>
            <UsageDetails usage={generate.data.usage} />
          </div>
        )}
      </section>
    </div>
  )
}

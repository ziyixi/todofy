import { AlertCircle, Check, Copy, LoaderCircle } from 'lucide-react'
import { useState } from 'react'
import type { Generation, Usage } from '@ziyixi/proto/modelrouter/inference/v1/inference_wire'
import { billingLabel, cost, count, prettyJson, stateLabel } from './format'

export function Status({ state }: { state: string | undefined }) {
  return (
    <span className={`status state-${state ?? 'unknown'}`}>
      <span aria-hidden="true" />
      {stateLabel(state)}
    </span>
  )
}

export function Loading({ children = '正在读取…' }: { children?: string }) {
  return (
    <p className="loading muted" role="status">
      <LoaderCircle size={16} aria-hidden="true" />
      {children}
    </p>
  )
}

export function Failure({ error, retry }: { error: unknown; retry?: () => void }) {
  return (
    <div className="notice danger" role="alert">
      <AlertCircle size={17} aria-hidden="true" />
      <div>
        <p>{error instanceof Error ? error.message : '读取失败，请重试。'}</p>
        {retry && (
          <button className="text-button" onClick={retry}>
            重新读取
          </button>
        )}
      </div>
    </div>
  )
}

export function CodeBlock({
  title,
  text,
  json = false,
}: {
  title: string
  text: string | undefined
  json?: boolean
}) {
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)
  const body = json && text ? prettyJson(text) : text
  async function copy() {
    try {
      await navigator.clipboard.writeText(body ?? '')
      setCopied(true)
      setCopyFailed(false)
    } catch {
      setCopyFailed(true)
    }
  }
  return (
    <section className="code-section">
      <div className="section-heading">
        <h3>{title}</h3>
        {body && (
          <button
            className="icon-button"
            aria-label={`复制${title}`}
            title={`复制${title}`}
            onClick={() => void copy()}
          >
            {copied ? <Check size={15} /> : <Copy size={15} />}
          </button>
        )}
      </div>
      <pre>{body || '未提供'}</pre>
      {copyFailed && (
        <p className="small danger-text" role="status">
          无法复制，请选择文本后复制。
        </p>
      )}
    </section>
  )
}

export function UsageDetails({ usage }: { usage: Usage | undefined }) {
  const available = usage?.available === true
  return (
    <div className="usage-details">
      {!available && <p className="small muted">服务未提供 token 用量，不能按零用量计算。</p>}
      <dl className="facts compact">
        <dt>输入 token</dt>
        <dd>{available ? count(usage.input_tokens ?? 0) : '未提供'}</dd>
        <dt>输出 token</dt>
        <dd>{available ? count(usage.output_tokens ?? 0) : '未提供'}</dd>
        <dt>缓存命中</dt>
        <dd>{available ? count(usage.cached_input_tokens ?? 0) : '未提供'}</dd>
        <dt>缓存写入</dt>
        <dd>{available ? count(usage.cache_write_tokens ?? 0) : '未提供'}</dd>
        {usage?.estimated_quota_units !== undefined && (
          <>
            <dt>平台配额估算</dt>
            <dd>{usage.estimated_quota_units.toLocaleString('zh-CN', { maximumFractionDigits: 6 })}</dd>
          </>
        )}
        <dt>计费</dt>
        <dd>{billingLabel(usage?.billing_kind)}</dd>
        <dt>费用</dt>
        <dd>{cost(usage)}</dd>
      </dl>
      <p className="small muted">
        缓存命中属于输入，推理 token 属于输出，不重复相加。订阅的 API 等价估算仅供比较，不代表账单。
      </p>
    </div>
  )
}

export function GenerationOutput({ generation }: { generation: Generation }) {
  return (
    <>
      {generation.error && (
        <div className="notice danger" role="alert">
          <AlertCircle size={17} aria-hidden="true" />
          <p>
            {generation.error.message || '推理失败'}
            {generation.error.code !== undefined && (
              <span className="small">（错误码 {generation.error.code}）</span>
            )}
          </p>
        </div>
      )}
      {generation.output && <CodeBlock title="输出" text={generation.output} json />}
      {!generation.output && !generation.error && <p className="muted">尚无输出。</p>}
    </>
  )
}

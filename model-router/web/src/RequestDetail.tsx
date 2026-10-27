import { ArrowUpRight, X } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import type { RequestRecord } from '@ziyixi/proto/modelrouter/inference/v1/console_wire'
import type { RouterApi } from './api'
import type { PlaygroundDraft } from './Playground'
import { CodeBlock, Failure, GenerationOutput, Loading, Status, UsageDetails } from './components'
import { duration, modelName, providerLabel, requestId, time } from './format'

export function RequestDetail({
  name,
  summary,
  api,
  onClose,
  onCopy,
}: {
  name: string
  summary?: RequestRecord
  api: RouterApi
  onClose: () => void
  onCopy: (draft: PlaygroundDraft) => void
}) {
  const query = useQuery({ queryKey: ['router-request', name], queryFn: () => api.getRequest(name) })
  const record = query.data
  const metadata = record ?? summary
  const generation = metadata?.generation
  const contentAvailable = record?.content_available === true
  const request = contentAvailable ? record?.request : undefined
  const provider = providerLabel(metadata?.provider)
  return (
    <aside className="panel request-detail" aria-label="请求详情" aria-busy={query.isFetching}>
      <div className="section-heading detail-heading">
        <div>
          <h2>请求详情</h2>
          <code className="small muted wrap">{requestId(name)}</code>
        </div>
        <button type="button" className="icon-button" aria-label="关闭请求详情" onClick={onClose}>
          <X size={18} />
        </button>
      </div>
      <div className="detail-status">
        {metadata && <Status state={metadata.state} />}
        <button
          className="text-button"
          disabled={!request}
          onClick={() => {
            if (request)
              onCopy({
                request: { ...request, model: request.model || generation?.model },
                sourceRequest: requestId(name),
              })
          }}
        >
          <ArrowUpRight size={14} aria-hidden="true" />
          复制到 Playground
        </button>
      </div>
      {query.isPending && (
        <div className="detail-loading">
          <Loading>正在读取此请求…</Loading>
        </div>
      )}
      {query.error && <Failure error={query.error} retry={() => void query.refetch()} />}
      {record && generation && (
        <div className="detail-content">
          <dl className="facts">
            <dt>调用应用</dt>
            <dd>
              {record.app || '未提供'} <span className="small muted">由身份认证确定</span>
            </dd>
            <dt>供应商</dt>
            <dd>{provider}</dd>
            <dt>执行模型</dt>
            <dd>
              {provider} · {modelName(generation.model)}
            </dd>
            <dt>原请求模型</dt>
            <dd>{request?.model ? `${provider} · ${request.model}` : '未提供'}</dd>
            <dt>服务报告模型</dt>
            <dd>{record.reported_model ? `${provider} · ${record.reported_model}` : '未提供'}</dd>
            <dt>开始</dt>
            <dd>{time(record.started_at)}</dd>
            <dt>完成</dt>
            <dd>{time(record.completed_at)}</dd>
            <dt>耗时</dt>
            <dd>{duration(record.duration_ms)}</dd>
            <dt>内容到期</dt>
            <dd>{time(record.content_expire_time)}</dd>
          </dl>
          {!contentAvailable && (
            <div className="notice subtle" role="status">
              <p>内容已到期或暂不可用。输入、指令和输出保留 7 天，请求元数据保留 90 天。</p>
            </div>
          )}
          {request && (
            <>
              <section className="detail-section">
                <h3>原请求选项</h3>
                <CodeBlock
                  title="选项"
                  json
                  text={JSON.stringify({
                    effort: request.effort,
                    max_output_tokens: request.max_output_tokens,
                    allow_fallback: request.allow_fallback,
                    conversation: request.conversation,
                    timeout_ms: request.timeout_ms,
                  })}
                />
              </section>
              {request.instructions?.length ? (
                request.instructions.map((block, index) => (
                  <CodeBlock
                    key={index}
                    title={`Instructions ${index + 1}${block.cache ? ' · 稳定缓存块' : ''}`}
                    text={block.text}
                  />
                ))
              ) : (
                <CodeBlock title="Instructions" text={undefined} />
              )}
              <CodeBlock title="输入" text={request.input} />
              {request.output_schema_json && (
                <CodeBlock title="JSON Schema" text={request.output_schema_json} json />
              )}
            </>
          )}
          {contentAvailable && <GenerationOutput generation={generation} />}
          {!contentAvailable && generation.error && (
            <GenerationOutput generation={{ error: generation.error }} />
          )}
          <section className="detail-section">
            <h3>用量</h3>
            <UsageDetails usage={generation.usage} />
          </section>
          {generation.contributing_models?.length ? (
            <CodeBlock
              title="参与输出的模型"
              text={generation.contributing_models.map((model) => `${provider} · ${model}`).join('\n')}
            />
          ) : null}
          {contentAvailable && generation.observations && (
            <CodeBlock title="实际观测" text={JSON.stringify(generation.observations)} json />
          )}
        </div>
      )}
    </aside>
  )
}

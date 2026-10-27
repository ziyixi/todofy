import { ArrowUpRight, X } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import type { Generation } from '@ziyixi/proto/modelrouter/inference/v1/inference_wire'
import type { RouterApi } from './api'
import type { PlaygroundDraft } from './Playground'
import { CodeBlock, Failure, GenerationOutput, Loading, Status, UsageDetails } from './components'
import { duration, modelName, requestId, time } from './format'

export function RequestDetail({
  name,
  summary,
  api,
  onClose,
  onCopy,
}: {
  name: string
  summary?: Generation
  api: RouterApi
  onClose: () => void
  onCopy: (draft: PlaygroundDraft) => void
}) {
  const query = useQuery({ queryKey: ['router-request', name], queryFn: () => api.getRequest(name) })
  const record = query.data
  const generation = record?.generation ?? summary
  const contentAvailable = record?.content_available === true && !generation?.content_unavailable
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
        {generation && <Status state={generation.state} />}
        <button
          className="text-button"
          disabled={!contentAvailable || !record?.config}
          onClick={() => {
            if (record?.config && contentAvailable)
              onCopy({ config: record.config, input: record.input ?? '', sourceRequest: requestId(name) })
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
              {generation.app || '未提供'} <span className="small muted">由身份认证确定</span>
            </dd>
            <dt>请求模型</dt>
            <dd>{modelName(generation.model)}</dd>
            <dt>服务报告模型</dt>
            <dd>{generation.reported_model || '未提供'}</dd>
            <dt>开始</dt>
            <dd>{time(generation.started_at)}</dd>
            <dt>完成</dt>
            <dd>{time(generation.completed_at)}</dd>
            <dt>耗时</dt>
            <dd>{duration(generation.duration_ms)}</dd>
            <dt>内容到期</dt>
            <dd>{time(generation.content_expire_time)}</dd>
          </dl>
          {!contentAvailable && (
            <div className="notice subtle" role="status">
              <p>内容已到期或暂不可用。输入、指令和输出保留 7 天，请求元数据保留 90 天。</p>
            </div>
          )}
          <section className="detail-section">
            <h3>实际生效参数</h3>
            <CodeBlock
              title="参数"
              text={generation.parameters ? JSON.stringify(generation.parameters) : undefined}
              json
            />
          </section>
          {contentAvailable && (
            <>
              {record.config?.instructions?.length ? (
                record.config.instructions.map((block, index) => (
                  <CodeBlock
                    key={index}
                    title={`Instructions ${index + 1}${block.cache ? ' · 稳定缓存块' : ''}`}
                    text={block.text}
                  />
                ))
              ) : (
                <CodeBlock title="Instructions" text={undefined} />
              )}
              <CodeBlock title="输入" text={record.input} />
              {record.config?.output_schema_json && (
                <CodeBlock title="JSON Schema" text={record.config.output_schema_json} json />
              )}
              <GenerationOutput generation={generation} />
            </>
          )}
          {!contentAvailable && generation.error && <GenerationOutput generation={{ error: generation.error }} />}
          <section className="detail-section">
            <h3>用量</h3>
            <UsageDetails usage={generation.usage} />
          </section>
          {generation.observations && (
            <CodeBlock title="实际观测" text={JSON.stringify(generation.observations)} json />
          )}
          {generation.metadata && Object.keys(generation.metadata).length > 0 && (
            <CodeBlock title="关联标签" text={JSON.stringify(generation.metadata)} json />
          )}
        </div>
      )}
    </aside>
  )
}

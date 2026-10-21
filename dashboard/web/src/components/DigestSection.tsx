import type { Digest } from '../../../worker/src/api-types.ts'
import { DIGEST_TASK_ATTEMPTS } from '../../../worker/src/api-types.ts'
import { SEVERITY, appErrorLabel, signalLabel } from '../lib/labels'
import { nameOf, type Reg } from '../lib/registry'
import { Card, Fact, Facts, Metrics, Notice, Pill, Time } from './ui'

export function DigestSection({ reg, digest, now }: { reg: Reg; digest: Digest; now: Date }) {
  return (
    <Card id="digest" title="运维摘要" level={2}>
      <p className="small muted">
        每次定时检查汇总警告和严重项目；每个 UTC 日第一次有项目时，在 Tasks 创建一条摘要任务，当天不再创建。
      </p>
      {!digest.enabled ? <Notice tone="warn">没有绑定 Tasks 的建任务入口（TASK_INBOX），不会创建摘要任务。</Notice> : null}
      {digest.last_error ? (
        <Notice tone="danger">
          上次创建失败：{appErrorLabel(digest.last_error)}。下次定时检查会用同一请求重试，每天最多 {DIGEST_TASK_ATTEMPTS} 次。
        </Notice>
      ) : null}

      {digest.items.length === 0 ? (
        <p className="small">当前没有需要汇报的项目。</p>
      ) : (
        <ul className="signal-list" aria-label="摘要项目">
          {digest.items.map((item) => {
            const severity = SEVERITY[item.severity]
            const label = signalLabel(item.code)
            return (
              <li key={`${item.source}:${item.code}`} className="signal">
                <div className="signal-head">
                  <Pill tone={severity.tone}>{severity.label}</Pill>
                  <span className="signal-source">{nameOf(reg, item.source)}</span>
                  <span className="signal-label">{label}</span>
                  {label !== item.code ? <code className="small muted">{item.code}</code> : null}
                </div>
                <p className="small muted">
                  开始于 <Time iso={item.since} now={now} />
                </p>
                <Metrics metrics={item.metrics} />
              </li>
            )
          })}
        </ul>
      )}

      <Facts>
        <Fact label="上次摘要任务">{digest.last_sent_at ? <Time iso={digest.last_sent_at} now={now} /> : '尚未创建'}</Fact>
        {digest.last_receipt ? <Fact label="任务列出">{digest.last_receipt.item_count} 项</Fact> : null}
        {digest.next_due_at ? (
          <Fact label="下一条最早">
            <Time iso={digest.next_due_at} now={now} />
          </Fact>
        ) : null}
      </Facts>
    </Card>
  )
}

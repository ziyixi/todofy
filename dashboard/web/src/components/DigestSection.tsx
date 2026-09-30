import type { DigestView } from '../../../worker/src/api-types.ts'
import { SEVERITY, appErrorLabel, signalLabel } from '../lib/labels'
import { nameOf, type Reg } from '../lib/registry'
import { Card, Fact, Facts, Metrics, Notice, Pill, Time } from './ui'

export function DigestSection({ reg, digest, now }: { reg: Reg; digest: DigestView; now: Date }) {
  return (
    <Card id="digest" title="运维摘要" level={2}>
      <p className="small muted">
        每次定时检查汇总警告和严重项目；项目变化时或至少每 6 小时发给 Todofy，由 Todofy 的每日提醒最多创建一条 Todoist 任务。
      </p>
      {!digest.enabled ? (
        <Notice tone="warn">Todofy 当前没有提供运维摘要功能（ops_digest），摘要暂不发送。</Notice>
      ) : null}
      {digest.last_error ? <Notice tone="danger">上次发送失败：{appErrorLabel(digest.last_error)}，下次定时检查会重试。</Notice> : null}

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
        <Fact label="上次发送">{digest.last_sent_at ? <Time iso={digest.last_sent_at} now={now} /> : '尚未发送'}</Fact>
        {digest.last_receipt ? (
          <Fact label="Todofy 回执">
            {digest.last_receipt.stored ? '已保存' : '未替换（Todofy 已有更新的报告）'}，{digest.last_receipt.item_count} 项
          </Fact>
        ) : null}
        {digest.next_due_at ? (
          <Fact label="最迟下次发送">
            <Time iso={digest.next_due_at} now={now} />
          </Fact>
        ) : null}
      </Facts>
    </Card>
  )
}

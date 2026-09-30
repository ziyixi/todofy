import type { OpsResponse } from '../../../worker/src/api-v2-types.ts'
import { ActionsSection } from '../components/ActionsSection'
import { AppDetails } from '../components/AppDetails'
import { DigestSection } from '../components/DigestSection'
import { Card, Fact, Facts } from '../components/ui'
import { browserTimeZone } from '../lib/format'
import { STATUS_SOURCE } from '../lib/labels'
import { entryOf, sortedByOrder, type Reg } from '../lib/registry'

/**
 * 操作与记录 `#/ops`: the guard and canary actions (confirmation texts and the CSRF flow unchanged),
 * the digest, the full ops-v1 status of every app, and what this build knows (build, zone, registry).
 */
export function OpsView({ registry, ops, now }: { registry: Reg; ops: OpsResponse; now: Date }) {
  const groups = sortedByOrder(registry.entry_groups)
  const entries = groups.flatMap((group) => sortedByOrder(registry.entries.filter((entry) => entry.group === group.id)))
  return (
    <div className="view view-ops">
      <div className="view-head">
        <h1>操作与记录</h1>
        <p className="small muted">降载与金丝雀的手动操作、每日运维摘要，以及各应用完整的 ops-v1 状态。</p>
      </div>
      <div className="ops-columns">
        <ActionsSection reg={registry} ops={ops} now={now} />
        <DigestSection reg={registry} digest={ops.digest} now={now} />
      </div>

      <section className="ops-apps" aria-labelledby="ops-apps-title">
        <h2 id="ops-apps-title">应用详情</h2>
        {ops.apps.length === 0 ? (
          <p className="empty">没有接入 ops-v1 的应用。</p>
        ) : (
          <div className="apps">
            {ops.apps.map((card) => (
              <AppDetails key={card.entry} card={card} entry={entryOf(registry, card.entry)} guard={ops.guard.apps[card.entry]} now={now} />
            ))}
          </div>
        )}
      </section>

      <Card id="about" title="构建与注册表" level={2}>
        <Facts>
          <Fact label="构建">
            <code>{ops.build.slice(0, 12)}</code>
          </Fact>
          <Fact label="时区">浏览器本地（{browserTimeZone()}）</Fact>
        </Facts>
        <div className="table-wrap">
          <table className="res-table registry-table">
            <caption className="visually-hidden">注册表中的入口</caption>
            <thead>
              <tr>
                <th scope="col">入口</th>
                <th scope="col">分组</th>
                <th scope="col">状态来源</th>
                <th scope="col">Worker</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id}>
                  <th scope="row">{entry.name}</th>
                  <td>{groups.find((group) => group.id === entry.group)?.name ?? entry.group}</td>
                  <td>{STATUS_SOURCE[entry.status_type] ?? entry.status_type}</td>
                  <td>{entry.scripts.length > 0 ? entry.scripts.map((script) => <code key={script}>{script} </code>) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}

import { ChevronRight, ExternalLink } from 'lucide-react'
import { useState } from 'react'
import type { EntryState, Level, RegistryEntryView, TileMetric } from '../../../worker/src/api-v2-types.ts'
import { formatDayHour, formatNumber } from '../lib/format'
import { LEVEL, SEVERITY, counterShort, reasonLabel, signalLabel } from '../lib/labels'
import { entryPageHash, flowsOfEntry, sortedByOrder, type Reg } from '../lib/registry'
import { routeHash } from '../router'
import { httpsUrl } from '../lib/url'
import { Modal } from './Modal'
import { AccessLock, EntryIcon, LevelMark } from './status'
import { Fact, Facts, Pill, Time } from './ui'

/** The one number a tile shows: "今日收件 37", "24 小时 41 封", "响应 180 ms", "今天 06 时有请求". */
export function metricText(metric: TileMetric | null, now: Date): string | null {
  if (!metric) return null
  switch (metric.kind) {
    case 'counter':
      return metric.name === 'ingest_today_messages' ? `今日收件 ${formatNumber(metric.value)}` : counterShort(metric.name, metric.value)
    case 'latency':
      return `响应 ${formatNumber(Math.round(metric.ms))} ms`
    case 'last_active':
      return `${formatDayHour(metric.hour, now)}有请求`
  }
}

interface StatusLine {
  level: Level
  word: string
  detail: string | null
}

/** What a tile says about its entry; never a made-up green for link-only or unmonitored entries. */
export function statusLine(entry: RegistryEntryView, state: EntryState | undefined, now: Date): StatusLine | null {
  if (entry.status_type === 'link_only' || state?.level === 'link') return null
  if (!state) return { level: 'unknown', word: '未知', detail: '无法获取这一项的数据' }
  if (state.level === 'unmonitored') return { level: 'unmonitored', word: '未接入监控', detail: null }
  if (state.reason === 'never_checked') return { level: 'unknown', word: '尚未检查', detail: null }
  if (state.reason === 'unreachable' && state.consecutive_failures > 0) {
    return { level: state.level, word: '无法连接', detail: `连续 ${state.consecutive_failures} 次失败` }
  }
  const metric = metricText(state.metric, now)
  const reason = state.level !== 'ok' && state.reason ? reasonLabel(state.reason) : null
  return { level: state.level, word: LEVEL[state.level].word, detail: metric ?? reason }
}

function linkLabel(entry: RegistryEntryView): string {
  const host = entry.host ? `，${entry.host}` : ''
  const unmonitored = entry.status_type === 'link_only' ? '，未接入监控（仅链接）' : ''
  return `打开 ${entry.name}（新标签页）${host}${unmonitored}`
}

/**
 * A launcher tile: the icon + name area is the real link (new tab); the status line is a separate
 * button that opens the entry's detail sheet. Link-only entries show their host and no mark.
 */
function Tile({
  entry,
  state,
  loading,
  now,
  onDetails,
}: {
  entry: RegistryEntryView
  state: EntryState | undefined
  loading: boolean
  now: Date
  onDetails: (entry: RegistryEntryView) => void
}) {
  const url = httpsUrl(entry.url)
  const line = loading ? null : statusLine(entry, state, now)
  const head = (
    <>
      <EntryIcon icon={entry.icon} accent={entry.accent} />
      <span className="tile-name">{entry.name}</span>
    </>
  )
  return (
    <li className="tile">
      {url ? (
        <a className="tile-link" href={url} target="_blank" rel="noreferrer noopener" aria-label={linkLabel(entry)}>
          {head}
        </a>
      ) : (
        <span className="tile-link">{head}</span>
      )}
      {entry.access ? <AccessLock /> : null}
      {entry.group === 'sites' && entry.host ? <span className="tile-host tile-host-corner">{entry.host}</span> : null}
      {entry.status_type === 'link_only' ? (
        <span className="tile-host" aria-hidden="true">
          {entry.host}
        </span>
      ) : loading ? (
        <span className="tile-status skeleton-line" aria-hidden="true" />
      ) : line ? (
        <button
          type="button"
          className="tile-status"
          aria-label={`${entry.name} 状态：${line.word}，查看详情`}
          onClick={() => onDetails(entry)}
        >
          <LevelMark level={line.level} word={line.word} />
          {line.detail ? (
            <span className="tile-detail">
              <span className="tile-sep" aria-hidden="true">
                ·{' '}
              </span>
              {line.detail}
            </span>
          ) : null}
        </button>
      ) : null}
    </li>
  )
}

/** A background service without its own page: one row that opens its Worker or flow on this page. */
function ServiceRow({ reg, entry, state, loading, now }: { reg: Reg; entry: RegistryEntryView; state: EntryState | undefined; loading: boolean; now: Date }) {
  const target = entryPageHash(reg, entry)
  const line = loading ? null : statusLine(entry, state, now)
  const detail = line ? (line.level === 'ok' ? (line.detail ?? line.word) : line.detail ? `${line.word} · ${line.detail}` : line.word) : null
  const label = line ? `${entry.name}：${line.word}${line.detail ? `，${line.detail}` : ''}，${target.what}` : `${entry.name}，${target.what}`
  return (
    <li>
      <a className="service-row" href={target.hash} aria-label={label}>
        <EntryIcon icon={entry.icon} accent={entry.accent} small />
        <span className="service-text">
          <span className="service-name">{entry.name}</span>
          {line ? (
            <LevelMark level={line.level} word={detail ?? line.word} size={10} className="service-status" />
          ) : (
            <span className="service-status skeleton-line" aria-hidden="true" />
          )}
        </span>
        <ChevronRight className="chevron" size={16} aria-hidden="true" />
      </a>
    </li>
  )
}

/** The detail sheet of a tile: level and reason, up to 3 signals, and where to look next. */
function EntrySheet({ reg, entry, state, now, onClose }: { reg: Reg; entry: RegistryEntryView; state: EntryState | undefined; now: Date; onClose: () => void }) {
  const line = statusLine(entry, state, now)
  const flows = flowsOfEntry(reg, entry.id)
  const url = httpsUrl(entry.url)
  return (
    <Modal title={`${entry.name} 状态`} onClose={onClose} variant="sheet">
      <div className="sheet-body">
        {line ? (
          <p className="sheet-level">
            <LevelMark level={line.level} word={line.word} size={12} />
            {line.detail ? <span className="muted"> · {line.detail}</span> : null}
          </p>
        ) : null}
        <p className="small muted">{entry.description}</p>
        {state ? (
          <Facts>
            {state.reason ? <Fact label="原因">{reasonLabel(state.reason)}</Fact> : null}
            <Fact label="上次检查">{state.checked_at ? <Time iso={state.checked_at} now={now} /> : '尚未检查'}</Fact>
            {state.consecutive_failures > 0 ? <Fact label="连续失败">{state.consecutive_failures} 次</Fact> : null}
          </Facts>
        ) : (
          <p className="small">无法获取这一项的数据，其他内容不受影响。</p>
        )}
        {state && state.top_signals.length > 0 ? (
          <ul className="signal-list" aria-label="主要信号">
            {state.top_signals.map((signal) => {
              const label = signalLabel(signal.code)
              return (
                <li key={signal.code} className="signal">
                  <div className="signal-head">
                    <Pill tone={SEVERITY[signal.severity].tone}>{SEVERITY[signal.severity].label}</Pill>
                    <span className="signal-label">{label}</span>
                    {label !== signal.code ? <code className="small muted">{signal.code}</code> : null}
                  </div>
                  {signal.since ? (
                    <p className="small muted">
                      开始于 <Time iso={signal.since} now={now} />
                    </p>
                  ) : null}
                </li>
              )
            })}
          </ul>
        ) : null}
        <ul className="sheet-links" aria-label="相关位置">
          {flows.map((flow) => (
            <li key={flow.id}>
              <a href={routeHash({ view: 'flows', flow: flow.id })} onClick={onClose}>
                查看流程：{flow.name} →
              </a>
            </li>
          ))}
          {entry.scripts.map((script) => (
            <li key={script}>
              <a href={routeHash({ view: 'cloudflare', script })} onClick={onClose}>
                查看 Worker：{script} →
              </a>
            </li>
          ))}
          {entry.status_type === 'ops_v1' ? (
            <li>
              <a href={routeHash({ view: 'ops' })} onClick={onClose}>
                应用详情 →
              </a>
            </li>
          ) : null}
          {url ? (
            <li>
              <a href={url} target="_blank" rel="noreferrer noopener">
                打开 {entry.name}
                <ExternalLink size={13} aria-hidden="true" />
                <span className="visually-hidden">（新标签页）</span>
              </a>
            </li>
          ) : null}
        </ul>
      </div>
    </Modal>
  )
}

/**
 * The launcher of 首页: groups by kind in registry order (tiles never reorder by status). 应用 and
 * 站点 are tiles (one grid on a phone); 后台服务 are rows. The dashboard itself (group hidden) has no tile.
 */
export function Launcher({ reg, entries, now }: { reg: Reg; entries: readonly EntryState[] | undefined; now: Date }) {
  const [open, setOpen] = useState<RegistryEntryView | null>(null)
  const loading = entries === undefined
  const stateOf = (id: string) => entries?.find((state) => state.id === id)
  const groups = sortedByOrder(reg.entry_groups)
    .filter((group) => group.id !== 'hidden')
    .map((group) => ({ group, items: sortedByOrder(reg.entries.filter((entry) => entry.group === group.id)) }))
    .filter(({ items }) => items.length > 0)
  const tileGroups = groups.filter(({ group }) => group.id !== 'services')
  const services = groups.find(({ group }) => group.id === 'services')

  if (groups.length === 0) {
    return <p className="empty">还没有登记入口。在注册表中添加应用后会显示在这里。</p>
  }

  return (
    <section className="launch" aria-labelledby="launch-title" aria-busy={loading}>
      <h2 id="launch-title" className="visually-hidden">
        入口
      </h2>
      {loading ? (
        <p className="visually-hidden" role="status">
          正在加载
        </p>
      ) : null}
      <div className={`launch-primary${tileGroups.length > 1 ? ' launch-merge' : ''}`}>
        {tileGroups.map(({ group, items }, index) => (
          <section key={group.id} className="launch-group" aria-labelledby={`group-${group.id}`}>
            <h3 id={`group-${group.id}`} className={`group-title${index > 0 ? ' group-title-follow' : ''}`}>
              {group.name}
              {index === 0 && tileGroups.length > 1 ? (
                <span className="merge-suffix" aria-hidden="true">
                  与{tileGroups
                    .slice(1)
                    .map(({ group: other }) => other.name)
                    .join('、')}
                </span>
              ) : null}
            </h3>
            <ul className="tiles">
              {items.map((entry) => (
                <Tile key={entry.id} entry={entry} state={stateOf(entry.id)} loading={loading} now={now} onDetails={setOpen} />
              ))}
            </ul>
          </section>
        ))}
      </div>
      {services ? (
        <section className="launch-group launch-services" aria-labelledby={`group-${services.group.id}`}>
          <h3 id={`group-${services.group.id}`} className="group-title">
            {services.group.name}
          </h3>
          <ul className="services">
            {services.items.map((entry) => (
              <ServiceRow key={entry.id} reg={reg} entry={entry} state={stateOf(entry.id)} loading={loading} now={now} />
            ))}
          </ul>
        </section>
      ) : null}
      {open ? <EntrySheet reg={reg} entry={open} state={stateOf(open.id)} now={now} onClose={() => setOpen(null)} /> : null}
    </section>
  )
}

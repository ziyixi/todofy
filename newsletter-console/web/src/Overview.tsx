import { useQuery } from '@tanstack/react-query';
import type { CSSProperties } from 'react';
import type { Edition } from '@ziyixi/proto/newsletter/ui/v1/edition_wire';
import type { ReplicaCounts } from '@ziyixi/proto/newsletter/ui/v1/backup_status_wire';
import type { DayStatus, Overview as OverviewView, ServiceState } from '@ziyixi/proto/newsletter/ui/v1/overview_wire';
import type { Dependency, Run, RunNode } from '@ziyixi/proto/newsletter/ui/v1/run_wire';
import type { ConfigState } from '@ziyixi/proto/newsletter/ui/v1/source_catalog_wire';
import { read } from './api.ts';
import {
  SHAPES, UNKNOWN_CATEGORIES, configState, count, deliveryState, dependency, dependencyState, drainState, duration,
  failureKind, issueDate, nodeName, nodeNameById, nodeState, replicaState, runState, seconds, short, stopReason,
  stripDay, time, trigger, webUrl, wholeSeconds, type Tone, type Word,
} from './format.ts';
import { Mark } from './Mark.tsx';
import { runHref } from './route.ts';

/** What stopped a run, in one line: 选题超出节点预算（用时 161 秒 / 预算 150 秒）. */
export function stopSentence(run: Run): string {
  const failure = run.failure;
  if (failure?.node_id) {
    const timed = (failure.kind === 'node_budget' || failure.kind === 'run_deadline') && failure.budget_seconds
      ? `（用时 ${wholeSeconds(failure.elapsed_seconds)} / 预算 ${wholeSeconds(failure.budget_seconds)}）`
      : '';
    return `${nodeNameById(failure.node_id)}${failureKind(failure.kind, failure.error_code)}${timed}`;
  }
  return stopReason(run.stop_reason) ?? failureKind(failure?.kind, run.stop_reason || failure?.error_code);
}

export interface Attention {
  readonly tone: Tone;
  readonly text: string;
  readonly run?: string;
}

/** The one line under the masthead: how the newest scheduled run and its delivery ended. */
export function attentionOf(overview: OverviewView): Attention {
  const run = overview.latest_run;
  if (run === undefined) return { tone: 'none', text: '尚无运行记录' };
  const date = issueDate(run.issue_date);
  const base = { run: run.name ?? '' };
  switch (run.state) {
    case 'queued':
    case 'running':
      return { ...base, tone: 'unknown', text: `${date} 正在运行` };
    case 'blocked':
    case 'failed':
      return { ...base, tone: 'bad', text: `${date} 未发出 · ${stopSentence(run)}` };
    case 'ready':
      switch (run.delivery_state) {
        case 'provider_accepted':
          return { ...base, tone: 'ok', text: `${date} 已交给邮件服务` };
        case 'unknown':
          return { ...base, tone: 'unknown', text: `${date} 投递结果尚未确认 · 先核对实际邮件，不能换请求键重发` };
        case 'submitting':
          return { ...base, tone: 'unknown', text: `${date} 正在提交给邮件服务` };
        case 'rejected':
          return { ...base, tone: 'bad', text: `${date} 邮件服务拒绝了这期简报` };
        default:
          return { ...base, tone: 'warn', text: `${date} 已生成，未投递` };
      }
    default:
      return { ...base, tone: 'warn', text: `${date} ${runState(run.state).label}` };
  }
}

/** A strip day's mark: ● 已投递 · ◆ 结果未确认 · ■ 未发出 · ▲ 已生成未投递 · ○ 尚未运行. */
export function dayMark(day: DayStatus): Word {
  if (!day.run) return { label: '尚未运行', tone: 'none' };
  switch (day.run_state) {
    case 'queued':
    case 'running':
      return { label: '运行中', tone: 'unknown' };
    case 'blocked':
    case 'failed':
      return { label: '未发出', tone: 'bad' };
    case 'ready':
      switch (day.delivery_state) {
        case 'provider_accepted':
          return { label: '已投递', tone: 'ok' };
        case 'unknown':
        case 'submitting':
          return { label: '结果未确认', tone: 'unknown' };
        case 'rejected':
          return { label: '未发出', tone: 'bad' };
        default:
          return { label: '已生成未投递', tone: 'warn' };
      }
    default:
      return { label: day.run_state ?? '状态未记录', tone: 'warn' };
  }
}

const LEGEND: readonly Word[] = [
  { label: '已投递', tone: 'ok' },
  { label: '结果未确认', tone: 'unknown' },
  { label: '未发出', tone: 'bad' },
  { label: '已生成未投递', tone: 'warn' },
  { label: '尚未运行', tone: 'none' },
];

function dayDetail(day: DayStatus): string {
  const mark = dayMark(day);
  const node = day.failed_node ? ` · ${nodeNameById(day.failed_node)}` : '';
  const reason = day.stop_reason ? ` · ${stopReason(day.stop_reason) ?? day.stop_reason}` : '';
  return `${mark.label}${node}${reason}`;
}

function DayStrip({ days }: { days: readonly DayStatus[] }) {
  const ordered = [...days].reverse();
  return (
    <section className="card strip-card" aria-labelledby="strip-title">
      <header className="card-head">
        <h2 id="strip-title">最近 14 天</h2>
        <ul className="legend" aria-label="图例">
          {LEGEND.map((word) => <li key={word.label}><Mark word={word} /></li>)}
        </ul>
      </header>
      <ol className="strip">
        {ordered.map((day) => {
          const mark = dayMark(day);
          const { day: dayOfMonth, weekday } = stripDay(day.issue_date);
          const label = `${issueDate(day.issue_date, true)}：${dayDetail(day)}`;
          const body = (
            <>
              <span className="strip-weekday" aria-hidden="true">{weekday}</span>
              <span className="strip-day" aria-hidden="true">{dayOfMonth}</span>
              <span className={`strip-shape ${mark.tone}`} aria-hidden="true">{SHAPES[mark.tone]}</span>
            </>
          );
          return (
            <li key={day.issue_date} className={day === days[0] ? 'today' : undefined}>
              {day.run
                ? <a href={runHref(day.run)} aria-label={label} title={label}>{body}</a>
                : <span role="img" aria-label={label} title={label}>{body}</span>}
            </li>
          );
        })}
      </ol>
      <details className="twin">
        <summary>以表格查看</summary>
        <table>
          <thead><tr><th scope="col">日期</th><th scope="col">结果</th><th scope="col">停在</th></tr></thead>
          <tbody>
            {days.map((day) => (
              <tr key={day.issue_date}>
                <td>{issueDate(day.issue_date, true)}</td>
                <td><Mark word={dayMark(day)} /></td>
                <td>{day.failed_node ? nodeNameById(day.failed_node) : day.stop_reason ? stopReason(day.stop_reason) ?? day.stop_reason : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </section>
  );
}

function Hero({ edition, run }: { edition: Edition | undefined; run: Run | undefined }) {
  if (edition === undefined) {
    return (
      <section className="card hero" aria-labelledby="hero-title">
        <p className="eyebrow">最新一期</p>
        <h2 id="hero-title" className="hero-title">还没有期刊</h2>
        <p className="muted">第一期生成后，这里显示它的标题、导读与投递结果。</p>
      </section>
    );
  }
  const kind = edition.kind === 'daily' ? '日常' : edition.kind === 'correction' ? '修订' : edition.kind === 'test' ? '测试' : '';
  const ownRun = run !== undefined && run.name === edition.run ? run : undefined;
  return (
    <section className="card hero" aria-labelledby="hero-title">
      <p className="eyebrow">最新一期 · {issueDate(edition.issue_date, true)}{kind ? ` · ${kind}` : ''}</p>
      <h2 id="hero-title" className="hero-title">{edition.title || edition.subject || '未命名期刊'}</h2>
      {edition.introduction ? <p className="hero-intro">{edition.introduction}</p> : null}
      {edition.topics?.length ? (
        <ul className="topics" aria-label="本期栏目">
          {edition.topics.map((topic, index) => <li key={index}>{topic}</li>)}
        </ul>
      ) : null}
      <dl className="hero-marks">
        <div><dt>运行</dt><dd><Mark word={ownRun ? runState(ownRun.state) : { label: '已生成', tone: 'ok' }} /></dd></div>
        <div><dt>投递</dt><dd><Mark word={deliveryState(edition.delivery?.state)} /></dd></div>
        <div><dt>Notion 备份</dt><dd><Mark word={replicaState(edition.backup?.state)} /></dd></div>
      </dl>
      {edition.run ? <p className="hero-actions"><a className="button" href={runHref(edition.run)}>查看运行</a></p> : null}
    </section>
  );
}

function ServiceCard({ service }: { service: ServiceState | undefined }) {
  const unknown = Object.entries(service?.unknown_category_counts ?? {}).filter(([, n]) => n > 0);
  const worker: Word = service?.worker_healthy === true ? { label: '健康', tone: 'ok' } : service?.worker_healthy === false
    ? { label: '异常', tone: 'bad' } : { label: '未知', tone: 'unknown' };
  return (
    <section className="card service" aria-labelledby="service-title">
      <h2 id="service-title">服务状态</h2>
      <ul className="rows">
        <li><span>后台进程</span><Mark word={worker} /></li>
        <li><span>发布入口</span><Mark word={drainState(service?.drain_state)} /></li>
      </ul>
      <dl className="counts">
        <div><dt>排队</dt><dd>{service?.queued_count ?? 0}</dd></div>
        <div><dt>进行中</dt><dd>{service?.inflight_count ?? 0}</dd></div>
        <div><dt>未确认完成记录</dt><dd className={service?.unknown_count ? 'has-unknown' : undefined}>{service?.unknown_count ?? 0}</dd></div>
      </dl>
      {unknown.length > 0 ? (
        <p className="muted small">{unknown.map(([kind, n]) => `${UNKNOWN_CATEGORIES[kind] ?? kind} ${String(n)}`).join(' · ')}；先核对，再处理。</p>
      ) : null}
      <p className="muted small">与 Fleet 读取同一份记录；发布冻结时只读查询照常可用。</p>
    </section>
  );
}

function pendingOf(backup: ReplicaCounts | undefined): number {
  if (backup === undefined) return 0;
  return (backup.syncing_count ?? 0) + (backup.outdated_count ?? 0) + (backup.retrying_count ?? 0)
    + (backup.unknown_count ?? 0) + (backup.conflict_count ?? 0);
}

function Tiles({ overview }: { overview: OverviewView }) {
  const days = overview.days ?? [];
  const delivered = days.filter((day) => day.delivery_state === 'provider_accepted').length;
  const run = overview.latest_run;
  const elapsed = seconds(run?.start_time, run?.end_time);
  const usage = overview.week_usage;
  const feeds = run?.feeds;
  const backup = overview.backup;
  const pending = pendingOf(backup);
  return (
    <dl className="tiles" aria-label="关键数字">
      <div>
        <dt>投递</dt>
        <dd className="value">{delivered}<span className="unit"> / {days.length}</span></dd>
        <dd>最近 {days.length} 天，邮件服务已接收</dd>
      </div>
      <div>
        <dt>最近一次运行用时</dt>
        <dd className="value">{run?.end_time ? duration(elapsed) : run ? runState(run.state).label : '—'}</dd>
        <dd>{run ? `${issueDate(run.issue_date)} · 期限 ${duration(run.deadline_seconds)}` : '尚无运行'}</dd>
      </div>
      <div>
        <dt>模型调用 · 7 天</dt>
        <dd className="value">{count(usage?.call_count ?? 0)}<span className="unit"> 次</span></dd>
        <dd>失败 {usage?.failed_count ?? 0} · 用量不完整 {usage?.partial_count ?? 0}</dd>
      </div>
      <div>
        <dt>输入 tokens · 7 天</dt>
        <dd className="value">{count(usage?.input_tokens ?? 0)}</dd>
        <dd>输出 {count(usage?.output_tokens ?? 0)} · 缓存命中 {count(usage?.cached_input_tokens ?? 0)}</dd>
      </div>
      <div>
        <dt>订阅源 · 最近一次</dt>
        <dd className="value">{feeds ? <>{feeds.ok_count ?? 0}<span className="unit"> / {feeds.source_count ?? 0} 正常</span></> : '—'}</dd>
        <dd>{feeds ? `失败 ${String(feeds.failed_count ?? 0)}${feeds.seed_count === undefined ? '' : ` · 线索 ${String(feeds.seed_count)}`}` : '订阅源节点尚未完成'}</dd>
      </div>
      <div>
        <dt>Notion 待同步</dt>
        <dd className="value">{backup === undefined ? '未启用' : pending}</dd>
        <dd>{backup === undefined ? '异步备份已关闭' : pending > 0 && backup.oldest_pending_time
          ? `最早一条自 ${time(backup.oldest_pending_time, true)} 起` : '副本与记录一致'}</dd>
      </div>
    </dl>
  );
}

/** One step of the flow: a node of the run's frozen graph, its state and its time against its frozen budget. */
function Step({ node }: { node: RunNode }) {
  const word = nodeState(node.state, node.degraded || node.error_code === 'partial_failure');
  const elapsed = seconds(node.start_time, node.end_time);
  const budget = node.budget_seconds ?? 0;
  const ratio = budget > 0 && elapsed !== undefined ? elapsed / budget : undefined;
  const items = node.item_count ? `${String(node.item_count - (node.failed_item_count ?? 0))}/${String(node.item_count)}` : null;
  return (
    <li className={`step ${word.tone}`}>
      <span className="step-dot" aria-hidden="true">{SHAPES[word.tone]}</span>
      <span className="step-name">{nodeName(node)}</span>
      <span className="step-word">{word.label}</span>
      <span className="step-time">{elapsed === undefined ? '—' : duration(elapsed)}{items ? ` · ${items}` : ''}</span>
      {ratio !== undefined ? (
        <span className={`budget${ratio > 1 ? ' over' : ratio > 0.8 ? ' near' : ''}`} role="img"
          aria-label={`用时 ${wholeSeconds(elapsed)}，预算 ${wholeSeconds(budget)}`}>
          <span style={{ width: `${String(Math.min(ratio, 1) * 100)}%` }} />
        </span>
      ) : <span className="budget none" aria-hidden="true" />}
    </li>
  );
}

function Flow({ run, edition }: { run: Run | undefined; edition: Edition | undefined }) {
  const detail = useQuery({
    queryKey: ['run', run?.name],
    queryFn: () => read.run(run?.name ?? ''),
    enabled: Boolean(run?.name),
  });
  const nodes = detail.data?.nodes ?? [];
  const publish = nodes.findIndex((node) => node.type === 'publish' || node.node_id === 'publish');
  const delivery = deliveryState(detail.data?.delivery_state);
  const own = edition !== undefined && edition.run === run?.name ? edition : undefined;
  const layout = { '--steps': String(nodes.length + 1), '--at': String(publish + 1) } as CSSProperties;
  return (
    <section className="card flow" aria-labelledby="flow-title">
      <header className="card-head">
        <h2 id="flow-title">今日流程</h2>
        <p className="muted">{run ? `${issueDate(run.issue_date, true)} · ${trigger(run.trigger)}运行 · 预算是这次运行开始时冻结的` : '尚无运行'}</p>
      </header>
      {detail.isPending && run ? <p className="muted">正在读取这次运行…</p> : null}
      {detail.isError ? <p className="muted">这次运行暂时读不到，稍后刷新。</p> : null}
      {nodes.length > 0 ? (
        <div className="chain-wrap" style={layout}>
          <ol className="chain" aria-label="流程各步">
            {nodes.map((node) => <Step key={node.node_id} node={node} />)}
            <li className={`step ${delivery.tone}`}>
              <span className="step-dot" aria-hidden="true">{SHAPES[delivery.tone]}</span>
              <span className="step-name">投递</span>
              <span className="step-word">{delivery.label}</span>
              <span className="step-time">{own?.delivery?.update_time ? time(own.delivery.update_time) : '—'}</span>
              <span className="budget none" aria-hidden="true" />
            </li>
          </ol>
          {publish >= 0 ? (
            <div className="side">
              <span className="side-link" aria-hidden="true" />
              <p className="side-note">
                <span className="side-name">Notion 备份</span>
                <Mark word={replicaState(own?.backup?.state)} />
                <span className="side-text">发布之后异步复制，不是流程中的一步</span>
              </p>
            </div>
          ) : null}
        </div>
      ) : null}
      <p className="muted small chain-note">细线是用时占节点预算的比例；接近预算为黄色，超出为红色。</p>
    </section>
  );
}

export function Dependencies({ dependencies, title, note, wide = false }: { dependencies: readonly Dependency[]; title: string; note: string; wide?: boolean }) {
  return (
    <section className={`card deps${wide ? ' wide' : ''}`} aria-labelledby="deps-title">
      <header className="card-head">
        <h2 id="deps-title">{title}</h2>
        <p className="muted">{note}</p>
      </header>
      <ul className="dep-rows">
        {dependencies.map((item) => {
          const named = dependency(item.kind);
          const facts = [
            item.call_count ? `${String(item.call_count)} 次` : null,
            item.failed_count ? `失败 ${String(item.failed_count)}` : null,
            item.last_call_time ? `最近 ${time(item.last_call_time)}` : null,
          ].filter(Boolean).join(' · ');
          return (
            <li key={item.kind}>
              <div className="dep-name">
                <strong>{named.name}</strong>
                <span className="muted small">{named.note}</span>
              </div>
              <div className="dep-state">
                <Mark word={dependencyState(item.state)} />
                <span className="muted small">{facts}{item.error_code ? <> · <code>{item.error_code}</code></> : null}</span>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function ConfigCard({ config }: { config: ConfigState | undefined }) {
  const state = configState(config?.state);
  const revision = webUrl(config?.revision_url);
  return (
    <section className="card config" aria-labelledby="config-title">
      <h2 id="config-title">内容配置</h2>
      <p className="config-state"><Mark word={state} /></p>
      <p className="muted small">{state.guidance} 每次运行开始时冻结当时生效的配置。</p>
      <dl className="facts compact">
        <div>
          <dt>生效版本</dt>
          <dd>{revision ? <a href={revision} rel="noopener noreferrer"><code>{short(config?.active_revision)}</code></a> : <code>{short(config?.active_revision)}</code>}{config?.pinned ? ' · 固定' : ''}</dd>
        </div>
        <div><dt>上次检查目标</dt><dd><code>{short(config?.wanted_revision)}</code></dd></div>
        <div><dt>最近检查</dt><dd>{time(config?.last_sync_attempt_time, true)}</dd></div>
        <div><dt>错误码</dt><dd>{config?.sync_error_code ? <code>{config.sync_error_code}</code> : '无错误记录'}</dd></div>
      </dl>
    </section>
  );
}

export function OverviewPage({ overview }: { overview: OverviewView }) {
  return (
    <div className="page overview">
      <div className="lead">
        <Hero edition={overview.latest_edition} run={overview.latest_run} />
        <ServiceCard service={overview.service} />
      </div>
      <DayStrip days={overview.days ?? []} />
      <Tiles overview={overview} />
      <Flow run={overview.latest_run} edition={overview.latest_edition} />
      <div className="pair">
        <Dependencies dependencies={overview.dependencies ?? []} title="外部接口"
          note="最近一次每日运行与备份记录；只看结果，不看内容" />
        <ConfigCard config={overview.config} />
      </div>
    </div>
  );
}

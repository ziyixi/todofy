import { useQuery } from '@tanstack/react-query';
import type { ModelCall } from '@ziyixi/proto/newsletter/ui/v1/model_call_wire';
import type { DirectionFunnel, ReferenceCheck, Run } from '@ziyixi/proto/newsletter/ui/v1/run_wire';
import type { StoryOutcome } from '@ziyixi/proto/newsletter/ui/v1/edition_wire';
import { read, runQuery } from './api.ts';
import {
  REFERENCE_ORDER, callState, count, deliveryState, disposition, dropReason, duration, failureKind, idOf, issueDate,
  leadStage, microUsd, nodeNameById, nodeState, purpose, referenceStage, runState, seconds, short, stopReason, time,
  trigger, webUrl, wholeSeconds,
} from './format.ts';
import { Mark } from './Mark.tsx';
import { Dependencies } from './Overview.tsx';
import { issueHref, runHref, runsHref } from './route.ts';
import { Timeline } from './Timeline.tsx';

const ROUTER_REQUEST = /^requests\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NOT_RECORDED = '上线前未记录';

/** Model Router's page of one of its requests; only a `requests/<uuid>` name becomes a link. */
export function routerHref(name: string): string | null {
  return ROUTER_REQUEST.test(name) ? `${import.meta.env.VITE_MODEL_ROUTER_URL}#/${name}` : null;
}

/** 模型回合开始 1 次、完成 0 次. */
const turns = (call: ModelCall): string =>
  `模型回合开始 ${String(call.turn_count ?? 0)} 次、完成 ${String(call.completed_turn_count ?? 0)} 次`;

/**
 * What stopped the run, in plain words from the closed vocabulary: the feed sources first when some failed, then the
 * node, why, its time against the budget the run froze, the model call that was in flight, and the run's stop.
 */
export function FailurePanel({ run, calls }: { run: Run; calls: readonly ModelCall[] | undefined }) {
  const failure = run.failure;
  if (failure === undefined) return null;
  const stopped = run.state === 'blocked' || run.state === 'failed';
  const feeds = run.feeds;
  const call = failure.model_call ? calls?.find((item) => item.name === failure.model_call) : undefined;
  const timed = failure.kind === 'node_budget' || failure.kind === 'run_deadline';
  const parts = [
    failure.node_id ? nodeNameById(failure.node_id) + (failure.item_id ? `（${failure.item_id}）` : '') : null,
    failureKind(failure.kind, failure.error_code),
    failure.elapsed_seconds !== undefined
      ? `用时 ${wholeSeconds(failure.elapsed_seconds)}${failure.budget_seconds ? `（预算 ${wholeSeconds(failure.budget_seconds)}${timed ? '，含会话关闭最多约 30 秒' : ''}）` : ''}`
      : null,
    call ? turns(call) : failure.model_call ? '模型调用的回合未记录' : null,
  ].filter((part): part is string => part !== null);
  const stop = stopReason(run.stop_reason) ?? run.stop_reason;
  const headline = `${failure.node_id ? nodeNameById(failure.node_id) : ''}${failureKind(failure.kind, failure.error_code)}`;
  return (
    <section className={`card failure ${stopped ? 'bad' : 'warn'}`} aria-labelledby="failure-title">
      <h2 id="failure-title">
        <span className="shape" aria-hidden="true">{stopped ? '■' : '▲'}</span>
        {stopped ? `未发出：${headline}` : `有降级：${headline}，仍生成了期刊`}
      </h2>
      {feeds?.failed_count ? (
        <p className="failure-prelude">
          订阅源 部分失败 {feeds.failed_count}/{feeds.source_count}
          {feeds.failures?.length ? `：${feeds.failures.map((item) => `${item.source_id ?? '?'} ${item.code ?? ''}`.trim()).join('、')}` : ''}
        </p>
      ) : null}
      <p className="failure-line">{parts.join(' · ')}</p>
      {stopped && stop ? <p className="failure-stop">→ 运行停止：{stop}</p> : null}
      <p className="muted small">
        错误码 <code>{failure.error_code || run.stop_reason || '未记录'}</code>
        {call ? <> · <a href={`#call-${idOf(call.name)}`} onClick={(event) => { event.preventDefault(); document.getElementById(`call-${idOf(call.name)}`)?.scrollIntoView({ block: 'center' }); }}>查看这次模型调用</a></> : null}
        {timed ? ' · 预算是这次运行开始时冻结的，不是今天的配置。' : ''}
      </p>
    </section>
  );
}

function Facts({ run }: { run: Run }) {
  const elapsed = seconds(run.start_time, run.end_time);
  const usage = run.usage;
  return (
    <dl className="facts">
      <div><dt>开始</dt><dd>{run.start_time ? time(run.start_time, true) : `排队于 ${time(run.create_time, true)}`}</dd></div>
      <div><dt>结束</dt><dd>{run.end_time ? time(run.end_time, true) : '尚未结束'}</dd></div>
      <div><dt>用时</dt><dd>{run.end_time ? duration(elapsed) : '—'}{run.deadline_seconds ? <span className="muted"> / 期限 {duration(run.deadline_seconds)}</span> : null}</dd></div>
      <div><dt>触发</dt><dd>{trigger(run.trigger)}</dd></div>
      <div><dt>请求模型</dt><dd><code>{run.requested_model || '未记录'}</code></dd></div>
      <div><dt>配置版本</dt><dd><code title={run.config_revision}>{short(run.config_revision)}</code></dd></div>
      <div><dt>订阅源</dt><dd>{run.feeds ? `${String(run.feeds.ok_count ?? 0)}/${String(run.feeds.source_count ?? 0)} 正常${run.feeds.seed_count === undefined ? '' : ` · 线索 ${String(run.feeds.seed_count)}`}` : '未完成'}</dd></div>
      <div><dt>候选 · 入选</dt><dd>{run.candidate_count ?? 0} · {run.selected_count ?? 0}</dd></div>
      <div className="wide"><dt>模型用量</dt><dd>{usage?.call_count ? `${String(usage.call_count)} 次 · 输入 ${count(usage.input_tokens ?? 0)} · 输出 ${count(usage.output_tokens ?? 0)}` : '无调用'}{usage?.call_count && !usage.complete ? <span className="muted">（下限）</span> : null}</dd></div>
      {run.parent_run ? <div><dt>重放自</dt><dd><a href={runHref(run.parent_run)}>{idOf(run.parent_run).slice(0, 8)}</a></dd></div> : null}
      {run.replay_run ? <div><dt>重放</dt><dd><a href={runHref(run.replay_run)}>{idOf(run.replay_run).slice(0, 8)}</a></dd></div> : null}
    </dl>
  );
}

const RESULTS: Readonly<Record<string, string>> = {
  approved: '通过', confirmed_signal: '确认信号', withheld: '撤下', repaired: '已修订', invalid_output: '输出无效',
  editor_unavailable: '编辑不可用',
};

function Stories({ stories }: { stories: readonly StoryOutcome[] }) {
  return (
    <section className="card stories" aria-labelledby="stories-title">
      <header className="card-head">
        <h2 id="stories-title">选题</h2>
        <p className="muted">这次运行考虑过的题目与处理结果</p>
      </header>
      {stories.length === 0 ? <p className="muted">没有进入规划的题目。</p> : (
        <ul className="story-rows">
          {stories.map((story) => (
            <li key={story.story_id}>
              <span className="story-title">{story.title || story.story_id}</span>
              <span className="story-tags">
                <span className="chip quiet">{disposition(story.disposition) ?? '—'}</span>
                {story.result ? <span className="chip quiet">{RESULTS[story.result] ?? story.result}</span> : null}
              </span>
              {story.reason ? <span className="muted small story-reason">{story.reason}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const shown = (value: number | undefined): string => (value === undefined ? '未记录' : String(value));
/** The non-zero parts of a breakdown: 新闻 1 · 研究 2. */
const parts = (pairs: readonly (readonly [string, number | undefined])[]): string =>
  pairs.filter(([, value]) => value).map(([label, value]) => `${label} ${String(value)}`).join(' · ');

function FunnelRow({ row }: { row: DirectionFunnel }) {
  const failed = row.state !== undefined && row.state !== 'succeeded';
  const cost = microUsd(row.usage?.estimated_cost_microusd);
  return (
    <tr>
      <th scope="row" data-label="方向">
        {row.direction ?? '未命名方向'}
        {failed ? <span className="cell-sub"><Mark word={nodeState(row.state)} />{row.error_code ? <> <code>{row.error_code}</code></> : null}</span> : null}
      </th>
      <td data-label="线索" className="num">{shown(row.seed_count)}</td>
      <td data-label="尝试打开" className="num">{shown(row.opened_count)}</td>
      <td data-label="交接" className="num">
        {row.handed_count ?? 0}
        <span className="cell-sub">{parts([['新闻', row.news_count], ['研究', row.research_count], ['未定', row.unknown_count]])}</span>
        <span className="cell-sub">{parts([['全文', row.full_text_count], ['摘要', row.abstract_count], ['仅线索', row.metadata_count]])}</span>
      </td>
      <td data-label="入池" className="num">
        {row.pooled_count ?? 0}
        <span className="cell-sub">{parts([['接续', row.thread_count]])}</span>
      </td>
      <td data-label="丢弃" className="num">
        {shown(row.dropped_count)}
        <span className="cell-sub">{(row.drops ?? []).map((drop, index) => <span key={drop.reason} className="drop-item">{index ? ' · ' : ''}<span>{`${dropReason(drop.reason)} ${String(drop.count ?? 0)}`}</span></span>)}</span>
      </td>
      <td data-label="入选" className="num">{row.selected_count ?? 0}</td>
      <td data-label="刊出" className="num">{row.published_count ?? 0}</td>
      <td data-label="用时 · 成本" className="num">
        {row.elapsed_seconds === undefined ? '—' : duration(row.elapsed_seconds)}
        <span className="cell-sub">{cost ? `估算 ${cost}` : row.usage?.call_count ? `${String(row.usage.call_count)} 次调用` : ''}</span>
      </td>
    </tr>
  );
}

/** Each discovery direction from its feed leads to the edition, with what the pool left out and why. */
function Funnel({ rows }: { rows: readonly DirectionFunnel[] }) {
  if (rows.length === 0) return null;
  const old = rows.every((row) => row.opened_count === undefined && row.dropped_count === undefined);
  return (
    <section className="card funnel" aria-labelledby="funnel-title">
      <header className="card-head">
        <h2 id="funnel-title">检索漏斗</h2>
        <p className="muted">每个方向从订阅源线索到刊出。尝试打开只记录打开动作，不代表读到了页面；交接含仅线索的候选；接续指与近 30 天已刊故事同属一条线索。</p>
      </header>
      <div className="table-scroll">
        <table className="funnel-table">
          <thead>
            <tr>
              <th scope="col">方向</th><th scope="col" className="num">线索</th><th scope="col" className="num">尝试打开</th>
              <th scope="col" className="num">交接</th><th scope="col" className="num">入池</th><th scope="col" className="num">丢弃</th>
              <th scope="col" className="num">入选</th><th scope="col" className="num">刊出</th><th scope="col" className="num">用时 · 成本</th>
            </tr>
          </thead>
          <tbody>{rows.map((row) => <FunnelRow key={row.direction} row={row} />)}</tbody>
        </table>
      </div>
      {old ? <p className="muted small funnel-note">尝试打开与丢弃：{NOT_RECORDED}。</p> : null}
    </section>
  );
}

function Headlines({ run }: { run: Run }) {
  const leads = run.consensus_leads ?? [];
  return (
    <div className="must-block">
      <h3>头条共识</h3>
      {(run.headlines ?? []).map((summary) => (
        <p key={summary.direction} className="muted small">
          {summary.direction} · 头条源 {summary.feed_ok_count ?? 0}/{summary.feed_count ?? 0} 正常 · 窗口内 {summary.entry_count ?? 0} 条，
          {summary.group_count ?? 0} 组，3 家及以上 {summary.consensus_group_count ?? 0} 组
          {summary.top_groups?.length ? `；前三组：${summary.top_groups.map((group) => `${group.title ?? ''}（${String(group.outlet_count ?? 0)} 家）`).join('、')}` : ''}
        </p>
      ))}
      {leads.length === 0 ? <p className="muted">这次没有 3 家及以上媒体同报、进入候选池的事件组。</p> : (
        <ul className="must-rows">
          {leads.map((lead, index) => {
            const href = webUrl(lead.url);
            return (
              <li key={index}>
                <span className="must-title">{href ? <a href={href} target="_blank" rel="noopener noreferrer">{lead.title}</a> : lead.title}</span>
                <span className="must-tags">
                  <span className="chip quiet">{lead.outlet_count ?? 0} 家</span>
                  {lead.excerpt_count ? <span className="chip quiet">摘要 {lead.excerpt_count} 家</span> : null}
                  <Mark word={leadStage(lead.stage, lead.disposition)} />
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <p className="muted small">家数由代码按标题聚类算出，可能把同一议题的不同事件并在一起；是否必知由选题判断。搜集已作为新闻交接的组不再列入。摘要是代码冻结的各家标题与导语，最多支撑一段注明来源的信号。</p>
    </div>
  );
}

/** The candidates discovery marked must-know (change_basis 必知：), and how far each got. */
function Marked({ run }: { run: Run }) {
  const marked = run.must_know_candidates ?? [];
  // A running discovery has listed only the directions it finished.
  const discovering = run.state === 'running'
    && (run.nodes ?? []).some((node) => node.type === 'discovery' && (node.state === 'pending' || node.state === 'running'));
  return (
    <div className="must-block">
      <h3>搜集标为必知</h3>
      {marked.length === 0 ? <p className="muted">{discovering ? '搜集尚未完成。' : '这次搜集没有交接标为必知的候选。'}</p> : (
        <ul className="must-rows">
          {marked.map((item, index) => {
            const href = webUrl(item.url);
            return (
              <li key={index}>
                <span className="must-title">{href ? <a href={href} target="_blank" rel="noopener noreferrer">{item.title}</a> : item.title}</span>
                <span className="must-tags">
                  <span className="chip quiet">{item.direction}</span>
                  <Mark word={leadStage(item.stage, item.disposition)} />
                </span>
                {item.stage === 'dropped' ? <span className="muted small must-note">{dropReason(item.drop_reason)}</span> : null}
              </li>
            );
          })}
        </ul>
      )}
      <p className="muted small">标记是搜集模型按必知定义自己写的（change_basis 以“必知：”开头），入池的以选题看到的分类为准；选题按同一定义再判断，不另记结论。</p>
    </div>
  );
}

function Reference({ check }: { check: ReferenceCheck }) {
  const events = check.events ?? [];
  const href = webUrl(check.url);
  const title = `维基百科时事 · ${issueDate(check.date)}（UTC）`;
  const counts = REFERENCE_ORDER.map((stage) => [referenceStage(stage).label, events.filter((event) => event.stage === stage).length] as const);
  return (
    <div className="must-block">
      <h3>{href ? <a href={href} target="_blank" rel="noopener noreferrer">{title}</a> : title}</h3>
      {check.state !== 'available' ? (
        <p><Mark word={{ label: `参照不可用${check.error_code ? `（${check.error_code}）` : ''}`, tone: 'warn' }} /> <span className="muted">这次读不到参照，不能据此判断有没有漏掉大事。</span></p>
      ) : (
        <>
          <p className="muted small">{events.length === 0 ? '参照里没有读到可比对的条目。' : parts(counts)}</p>
          <ul className="must-rows">
            {events.map((event, index) => (
              <li key={index}>
                <span className="must-title plain">{event.text}</span>
                <span className="must-tags"><Mark word={referenceStage(event.stage)} /></span>
                <span className="muted small must-note">
                  {[event.category, event.drop_reason ? dropReason(event.drop_reason) : null, event.match ? `匹配：${event.match}` : null].filter(Boolean).join(' · ')}
                </span>
              </li>
            ))}
          </ul>
          <p className="muted small">按英文词、引用来源和订阅条目地址比对；匹配的是最接近的一条，可能是同一地点或人物的另一件事；只有弱匹配、或弱匹配走得更远时记未确定。这里不说明没有漏报。</p>
        </>
      )}
    </div>
  );
}

/**
 * Must-know tracking: the two ways a must-know event enters the run (discovery's mark and the code-counted headline
 * consensus) and an independent reference, against what the run did.
 */
function MustKnow({ run }: { run: Run }) {
  const recorded = run.reference !== undefined || (run.headlines ?? []).length > 0
    || (run.must_know_candidates ?? []).length > 0 || (run.funnel ?? []).some((row) => row.opened_count !== undefined);
  return (
    <section className="card must" aria-labelledby="must-title">
      <header className="card-head">
        <h2 id="must-title">必知追踪</h2>
        <p className="muted">搜集标为必知的候选、多家头条同报的事件与独立参照，各自走到了哪一步</p>
      </header>
      {!recorded ? <p className="muted">{NOT_RECORDED}。</p> : (
        <div className="must-grid">
          <div className="must-routes">
            <Marked run={run} />
            <Headlines run={run} />
          </div>
          {run.reference ? <Reference check={run.reference} /> : (
            <div className="must-block"><h3>参照</h3><p className="muted">这次运行没有参照源。</p></div>
          )}
        </div>
      )}
    </section>
  );
}

function CallRow({ call }: { call: ModelCall }) {
  const word = callState(call.state);
  const elapsed = seconds(call.start_time, call.end_time);
  const what = purpose(call.purpose);
  const cost = microUsd(call.estimated_cost_microusd);
  // A call recorded before these fields existed has neither a purpose nor a start; a newer one without a Router answer
  // (cut off or failed) simply has none to show.
  const legacy = call.start_time === undefined && what === null;
  const unanswered = legacy ? NOT_RECORDED : '没有回答';
  return (
    <tr id={`call-${idOf(call.name)}`}>
      <td data-label="节点 · 用途">
        <strong>{nodeNameById(call.node_id)}</strong>
        <span className="cell-sub">{what ?? NOT_RECORDED}{call.item_id ? ` · ${call.item_id}` : ''}</span>
      </td>
      <td data-label="请求 · 实际模型">
        <code>{call.requested_model || '—'}</code>
        <span className="cell-sub">{call.reported_models?.length ? call.reported_models.join('、') : unanswered}</span>
      </td>
      <td data-label="状态">
        <Mark word={word} />
        {call.failure_code ? <span className="cell-sub"><code>{call.failure_code}</code></span> : null}
      </td>
      <td data-label="回合" className="num">{call.completed_turn_count ?? 0}/{call.turn_count ?? 0}</td>
      <td data-label="Tokens 输入 / 输出" className="num">
        {count(call.input_tokens ?? 0)} / {count(call.output_tokens ?? 0)}
        <span className="cell-sub">{call.partial ? '用量不完整 · ' : ''}{cost ? `估算 ${cost}` : call.billing_kind === 'subscription' ? '订阅额度' : ''}</span>
      </td>
      <td data-label="开始 · 用时">
        {call.start_time ? time(call.start_time, false, true) : NOT_RECORDED}
        <span className="cell-sub">{call.start_time ? (call.end_time ? duration(elapsed) : '未结束') : ''}</span>
      </td>
      <td data-label="请求记录">
        {(call.router_requests ?? []).map((name) => {
          const href = routerHref(name);
          return href ? <a key={name} href={href} rel="noopener noreferrer">在 Model Router 中查看</a> : null;
        })}
        {call.router_requests?.length ? null : <span className="muted small">{legacy ? NOT_RECORDED : call.conversation ? '只有会话记录' : '没有请求记录'}</span>}
      </td>
    </tr>
  );
}

function ModelCalls({ run }: { run: Run }) {
  const calls = useQuery({ queryKey: ['modelCalls', run.name], queryFn: () => read.modelCalls(run.name ?? '') });
  const list = calls.data?.model_calls ?? [];
  return (
    <section className="card calls" aria-labelledby="calls-title">
      <header className="card-head">
        <h2 id="calls-title">模型调用</h2>
        <p className="muted">Newsletter 自己的调用账本；Model Router 的请求记录是另一份账本，可从每行打开。</p>
      </header>
      {calls.isPending ? <p className="muted">正在读取模型调用…</p> : null}
      {calls.isError ? <p className="muted">模型调用暂时读不到，稍后刷新。</p> : null}
      {calls.isSuccess && list.length === 0 ? <p className="muted">这次运行没有模型调用。</p> : null}
      {list.length > 0 ? (
        <div className="table-scroll">
          <table className="call-table">
            <thead>
              <tr>
                <th scope="col">节点 · 用途</th><th scope="col">请求 · 实际模型</th><th scope="col">状态</th>
                <th scope="col" className="num">回合</th><th scope="col" className="num">Tokens 输入 / 输出</th>
                <th scope="col">开始 · 用时</th><th scope="col">请求记录</th>
              </tr>
            </thead>
            <tbody>{list.map((call) => <CallRow key={call.name} call={call} />)}</tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

function Delivery({ run }: { run: Run }) {
  const word = deliveryState(run.delivery_state);
  return (
    <section className="card delivery" aria-labelledby="delivery-title">
      <h2 id="delivery-title">投递</h2>
      <p><Mark word={word} /></p>
      <p className="muted small">
        {run.delivery_state === 'unknown'
          ? '结果未确认时先核对实际邮件，不能换请求键重发。'
          : run.delivery_state === 'provider_accepted'
            ? '邮件服务已接收不代表已进入收件箱。'
            : run.edition ? '这期简报没有交给邮件服务。' : '这次运行没有生成期刊，所以没有投递。'}
      </p>
      {run.edition ? <p className="delivery-read"><a href={issueHref(run.edition)}>阅读这一期 →</a></p> : null}
    </section>
  );
}

export function RunPage({ id }: { id: string }) {
  const name = `runs/${id}`;
  const run = useQuery(runQuery(name));
  const calls = useQuery({ queryKey: ['modelCalls', name], queryFn: () => read.modelCalls(name), enabled: run.isSuccess });
  if (run.isPending) return <p className="muted">正在读取这次运行…</p>;
  if (run.isError || run.data === undefined) {
    return (
      <div className="page run">
        <p><a href={runsHref()}>← 全部运行</a></p>
        <p className="notice">这次运行读不到：它可能不存在，或 Newsletter 暂时没有回答。</p>
      </div>
    );
  }
  const data = run.data;
  const monthOf = data.issue_date?.slice(0, 7) ?? '';
  return (
    <div className="page run">
      <p className="crumb"><a href={runsHref(monthOf)}>← 全部运行</a></p>
      <header className="page-head run-head">
        <div>
          <p className="eyebrow">{trigger(data.trigger)}运行 · <code>{id.slice(0, 8)}</code></p>
          <h2>{issueDate(data.issue_date, true)}</h2>
        </div>
        <p className="run-head-state"><Mark word={runState(data.state)} /></p>
      </header>
      <FailurePanel run={data} calls={calls.data?.model_calls} />
      <section className="card" aria-label="运行概况"><Facts run={data} /></section>
      <section className="card timeline" aria-labelledby="timeline-title">
        <header className="card-head">
          <h2 id="timeline-title">节点时间线</h2>
          <p className="muted">竖线是节点预算（这次运行开始时冻结）；超出部分为红色。可展开的节点含多个依次运行的子项，预算按每个子项计。</p>
        </header>
        <Timeline run={data} />
      </section>
      <Funnel rows={data.funnel ?? []} />
      <MustKnow run={data} />
      {data.stories?.length ? (
        <div className="pair">
          <Dependencies dependencies={data.dependencies ?? []} title="外部调用" note="这次运行调用了哪些接口，以及结果" />
          <Stories stories={data.stories} />
        </div>
      ) : (
        // No story reached planning (the facts say how many were selected): the interfaces take the whole row.
        <Dependencies dependencies={data.dependencies ?? []} title="外部调用" note="这次运行调用了哪些接口，以及结果" wide />
      )}
      <ModelCalls run={data} />
      <Delivery run={data} />
    </div>
  );
}

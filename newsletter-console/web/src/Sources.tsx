import { useQuery } from '@tanstack/react-query';
import type { SourceOutcome } from '@ziyixi/proto/newsletter/ui/v1/run_wire';
import type { ConfigRevision, Direction, FeedSource, NodeBudget, SourceCatalog } from '@ziyixi/proto/newsletter/ui/v1/source_catalog_wire';
import { read } from './api.ts';
import {
  SHAPES, budgetSeconds, count, editorialLimit, editorialOrder, issueDate, nodeNameById, nodeState, short, sourceCode, sourceKind,
  time, webUrl, wholeSeconds, type Word,
} from './format.ts';
import { Mark } from './Mark.tsx';
import { ConfigCard } from './Overview.tsx';

/*
 * 来源 shows where each run's inputs come from: the content configuration, the researcher's feeds, the discovery
 * directions, the optional personal input and the history. The backup is an output of the record, never an input,
 * so it has no place on this page.
 */

/** A source's outcome in one run, in words: 4 条线索（14 条中 6 条可用）, or why it failed. */
export function outcomeText(outcome: SourceOutcome | undefined): string {
  if (outcome === undefined) return '尚无运行记录';
  const word = sourceCode(outcome.code);
  if (outcome.code !== 'ok') return `${word.label}${word.label === outcome.code ? '' : `（${outcome.code ?? ''}）`}`;
  if (outcome.seed_count === undefined) return '正常 · 线索数上线前未记录';
  if (outcome.seed_count === 0) return '正常 · 没有新线索';
  const found = outcome.entry_count === undefined ? '' : `（${String(outcome.entry_count)} 条中 ${String(outcome.accepted_count ?? 0)} 条可用）`;
  return `${String(outcome.seed_count)} 条线索${found}`;
}

/** The latest runs' outcomes as marks, oldest to newest, with each in words for a screen reader. */
function Recent({ recent }: { recent: readonly SourceOutcome[] }) {
  if (recent.length === 0) return <span className="muted small">尚无运行记录</span>;
  const ordered = [...recent].reverse();
  const label = `最近 ${String(recent.length)} 次：${ordered.map((item) => `${issueDate(item.issue_date)} ${sourceCode(item.code).label}`).join('；')}`;
  return (
    <span className="recent" role="img" aria-label={label} title={label}>
      {ordered.map((item, index) => {
        const word = sourceCode(item.code);
        return <span key={index} className={`shape ${word.tone}`} aria-hidden="true">{SHAPES[word.tone]}</span>;
      })}
    </span>
  );
}

function SourceRow({ source }: { source: FeedSource }) {
  const latest = source.recent?.[0];
  const href = webUrl(source.url);
  const limits = [
    source.max_seeds ? `每次最多 ${String(source.max_seeds)} 条线索` : null,
    source.max_age_days ? `只看 ${String(source.max_age_days)} 天内` : null,
  ].filter(Boolean).join(' · ');
  return (
    <li className={source.enabled ? undefined : 'paused'}>
      <div className="source-name">
        <strong>{source.display_name || source.id}</strong>
        <span className="chip quiet">{sourceKind(source.kind)}</span>
        {source.enabled ? null : <span className="chip quiet">已停用</span>}
      </div>
      <div className="source-outcome">
        {source.enabled ? <Recent recent={source.recent ?? []} /> : null}
        <span className={latest && latest.code !== 'ok' ? 'source-last bad' : 'source-last'}>
          {source.enabled ? outcomeText(latest) : '运行不读取'}
        </span>
      </div>
      <div className="source-meta">
        {limits ? <span>{limits}</span> : null}
        {href ? <a href={href} target="_blank" rel="noopener noreferrer">{source.id}</a> : <code>{source.id}</code>}
      </div>
    </li>
  );
}

function DirectionCard({ direction, sources }: { direction: Direction | null; sources: readonly FeedSource[] }) {
  const id = `direction-${direction?.id ?? 'other'}`;
  const number = /^(\d{2})-/.exec(direction?.id ?? '')?.[1];
  const word = direction?.latest_state ? nodeState(direction.latest_state) : { label: '最近一次未运行', tone: 'none' } as Word;
  return (
    <section className="card direction" aria-labelledby={id}>
      <header className="direction-head">
        {number ? <span className="direction-number" aria-hidden="true">{number}</span> : null}
        <h3 id={id}>{direction ? direction.title || direction.id : '未归入方向的订阅源'}</h3>
        {direction ? (
          <p className="direction-state">
            <Mark word={word} />
            <span className="muted small">最近一次每日运行 · {direction.latest_candidate_count ?? 0} 个候选</span>
          </p>
        ) : null}
      </header>
      {sources.length > 0
        ? <ul className="source-rows">{sources.map((source) => <SourceRow key={source.id} source={source} />)}</ul>
        : <p className="muted small">没有订阅源，只由模型检索。</p>}
      {direction?.instructions ? (
        <details className="twin">
          <summary>检索说明</summary>
          <div className="instructions">{direction.instructions}</div>
        </details>
      ) : null}
    </section>
  );
}

function Inputs({ catalog }: { catalog: SourceCatalog }) {
  const sources = catalog.sources ?? [];
  const enabled = sources.filter((source) => source.enabled);
  const newest = enabled.map((source) => source.recent?.[0]?.issue_date ?? '').sort().at(-1) ?? '';
  const latest = enabled.map((source) => source.recent?.[0]).filter((item) => item !== undefined && item.issue_date === newest);
  const failed = latest.filter((item) => item?.code !== 'ok').length;
  const directions = catalog.directions ?? [];
  const candidates = directions.reduce((sum, direction) => sum + (direction.latest_candidate_count ?? 0), 0);
  const personal = catalog.personal_input;
  return (
    <section className="inputs" aria-labelledby="inputs-title">
      <header className="card-head section-head">
        <h2 id="inputs-title">输入从哪里来</h2>
        <p className="muted">每次运行读取这四类输入；订阅源与搜集方向在下方逐一列出</p>
      </header>
      <dl className="tiles four">
        <div>
          <dt>订阅源 · 研究员</dt>
          <dd className="value">{enabled.length}<span className="unit"> / {sources.length} 启用</span></dd>
          <dd>{newest ? `${issueDate(newest)}：${String(latest.length - failed)} 个正常，${String(failed)} 个失败` : '尚无运行记录'}</dd>
        </div>
        <div>
          <dt>搜集方向 · 模型检索</dt>
          <dd className="value">{directions.length}<span className="unit"> 个方向</span></dd>
          <dd>最近一次每日运行找到 {candidates} 个候选</dd>
        </div>
        <div>
          <dt>个人事项 · Todofy，可选</dt>
          <dd className="value">{personal?.enabled ? '已启用' : '未启用'}</dd>
          <dd>
            {personal?.last_error_code ? <><code>{personal.last_error_code}</code> · </> : null}
            {personal?.last_fetch_time ? `最近读取 ${time(personal.last_fetch_time, true)}` : '尚无读取'} · 仅你可见
          </dd>
        </div>
        <div>
          <dt>历史去重</dt>
          <dd className="value">{count(catalog.history_candidate_count ?? 0)}<span className="unit"> 条</span></dd>
          <dd>记住的候选，搜集时跳过</dd>
        </div>
      </dl>
    </section>
  );
}

function History({ history, active }: { history: readonly ConfigRevision[]; active: string | undefined }) {
  return (
    <section className="card history" aria-labelledby="history-title">
      <h2 id="history-title">最近运行冻结的版本</h2>
      {history.length === 0 ? <p className="muted">还没有运行冻结过配置。</p> : (
        <ol className="history-rows">
          {history.map((revision) => (
            <li key={revision.revision}>
              <span><code title={revision.revision}>{short(revision.revision)}</code>{revision.revision === active ? <span className="chip">生效中</span> : null}</span>
              <span className="muted">
                {revision.first_issue_date === revision.last_issue_date
                  ? issueDate(revision.first_issue_date)
                  : `${issueDate(revision.first_issue_date)} – ${issueDate(revision.last_issue_date)}`} · {revision.run_count ?? 0} 次运行
              </span>
            </li>
          ))}
        </ol>
      )}
      <p className="muted small">每次运行的预算与规则都取自它冻结的版本，之后的发布不改变它。</p>
    </section>
  );
}

/**
 * How a node's recent runs used its budget: an overrun against the budget each run froze, else today's budget. A
 * longest time past today's budget without an overrun (a run that froze a larger one) would not fit it now.
 */
export function budgetMark(budget: NodeBudget): Word {
  if (budget.overrun_count) return { label: `超出 ${String(budget.overrun_count)} 次`, tone: 'bad' };
  if (!budget.budget_seconds) return { label: '无单独预算', tone: 'none' };
  if (budget.recent_max_seconds === undefined) return { label: '尚无记录', tone: 'none' };
  if (budget.recent_max_seconds > budget.budget_seconds) return { label: '超过当前预算', tone: 'warn' };
  if (budget.recent_max_seconds > budget.budget_seconds * 0.8) return { label: '接近预算', tone: 'warn' };
  return { label: '在预算内', tone: 'ok' };
}

const seconds = (value: number | undefined): string => (value === undefined ? '—' : budgetSeconds(value));

function Budgets({ budgets }: { budgets: readonly NodeBudget[] }) {
  return (
    <section className="card budgets" aria-labelledby="budgets-title">
      <header className="card-head">
        <h2 id="budgets-title">节点预算</h2>
        <p className="muted">预算是当前配置；「超出」按每次运行开始时冻结的预算计，最近至多 7 次每日运行</p>
      </header>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">节点</th><th scope="col" className="num">预算</th><th scope="col" className="num">中位用时</th>
              <th scope="col" className="num">最长用时</th><th scope="col" className="num">运行</th><th scope="col">状态</th>
            </tr>
          </thead>
          <tbody>
            {budgets.map((budget) => (
              <tr key={budget.node_id}>
                <th scope="row">{nodeNameById(budget.node_id)}</th>
                <td className="num">{budget.budget_seconds ? wholeSeconds(budget.budget_seconds) : '—'}</td>
                <td className="num">{seconds(budget.recent_median_seconds)}</td>
                <td className="num">{seconds(budget.recent_max_seconds)}</td>
                <td className="num">{budget.recent_run_count ?? 0} 次</td>
                <td><Mark word={budgetMark(budget)} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Rules({ limits }: { limits: Readonly<Record<string, number>> }) {
  const entries = editorialOrder(Object.entries(limits));
  return (
    <section className="card rules" aria-labelledby="rules-title">
      <h2 id="rules-title">编辑规则</h2>
      {entries.length === 0 ? <p className="muted">配置没有编辑规则。</p> : (
        <dl className="facts compact">
          {entries.map(([key, value]) => <div key={key}><dt>{editorialLimit(key)}</dt><dd>{value}</dd></div>)}
        </dl>
      )}
    </section>
  );
}

export function SourcesPage() {
  const catalog = useQuery({ queryKey: ['sourceCatalog'], queryFn: read.sourceCatalog });
  if (catalog.isPending) return <p className="muted">正在读取来源…</p>;
  if (catalog.isError) return <p className="notice">来源暂时读不到，稍后刷新。</p>;
  const data = catalog.data;
  const directions = data.directions ?? [];
  const sources = data.sources ?? [];
  const known = new Set(directions.map((direction) => direction.id));
  const unrouted = sources.filter((source) => !known.has(source.direction_id));
  return (
    <div className="page sources">
      <header className="page-head">
        <div>
          <h2>来源</h2>
          <p className="muted">下一次运行会读取的输入，以及它们在最近几次每日运行中的结果。读取于 {time(data.generate_time, true)}。</p>
        </div>
      </header>
      <div className="pair">
        <ConfigCard config={data.config} />
        <History history={data.config_history ?? []} active={data.config?.active_revision} />
      </div>
      <Inputs catalog={data} />
      <div className="directions">
        {directions.map((direction) => (
          <DirectionCard key={direction.id} direction={direction} sources={sources.filter((source) => source.direction_id === direction.id)} />
        ))}
        {unrouted.length > 0 ? <DirectionCard direction={null} sources={unrouted} /> : null}
      </div>
      <div className="pair lean">
        <Budgets budgets={data.budgets ?? []} />
        <Rules limits={data.editorial_limits ?? {}} />
      </div>
    </div>
  );
}

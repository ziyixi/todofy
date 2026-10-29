import { useQuery } from '@tanstack/react-query';
import type { Edition } from '@ziyixi/proto/newsletter/ui/v1/edition_wire';
import { read } from './api.ts';
import { EDITION_DELIVERY, deliveryState, editionKind, issueDate, month, replicaState } from './format.ts';
import { Mark } from './Mark.tsx';
import { issueHref, issuesHref, runsHref, type IssueFilter } from './route.ts';

/**
 * Deliveries that certainly left no mail: not requested, refused, or written by the local fake adapter. Anything else,
 * an unconfirmed or submitting send and a state this console does not know included, may have gone out.
 */
const UNSENT = new Set(['not_requested', 'rejected', 'simulated']);

/**
 * The month's filters. 未发出 is an issue that is not a test and whose delivery certainly left no mail; an unconfirmed
 * result is never counted, since the mail may have gone out (it is checked first, never resent).
 */
export const FILTERS: readonly { value: IssueFilter; name: string; test: (edition: Edition) => boolean; empty: string }[] = [
  { value: 'all', name: '全部', test: () => true, empty: '这个月没有期刊。' },
  { value: 'delivered', name: '已投递', test: (edition) => edition.delivery?.state === 'provider_accepted', empty: '这个月没有交给邮件服务的期刊。' },
  {
    value: 'unsent', name: '未发出',
    test: (edition) => edition.kind !== 'test' && UNSENT.has(edition.delivery?.state ?? ''),
    empty: '这个月没有生成后未发出的期刊。运行停止、没有生成期刊的日子见「运行」。',
  },
  { value: 'test', name: '测试', test: (edition) => edition.kind === 'test', empty: '这个月没有测试期刊。' },
];

function IssueCard({ edition }: { edition: Edition }) {
  const topics = edition.topics ?? [];
  const sections = edition.section_count ?? topics.length;
  return (
    <li>
      <a className="issue-card" href={issueHref(edition.name)}>
        <span className="issue-meta">
          <span className="issue-date">{issueDate(edition.issue_date, true)}</span>
          <span className={`chip${edition.kind === 'daily' ? '' : ' quiet'}`}>{editionKind(edition.kind)}</span>
        </span>
        <span className="issue-title">{edition.title || edition.subject || '未命名期刊'}</span>
        {edition.introduction ? <span className="issue-intro">{edition.introduction}</span> : null}
        <span className="issue-topics">{sections} 个栏目{topics.length ? ` · ${topics.join('、')}` : ''}</span>
        <span className="issue-marks">
          <span><span className="issue-mark-label">投递</span><Mark word={deliveryState(edition.delivery?.state, EDITION_DELIVERY)} /></span>
          <span><span className="issue-mark-label">Notion 备份</span><Mark word={replicaState(edition.backup?.state)} /></span>
        </span>
      </a>
    </li>
  );
}

export function IssuesPage({ month: wanted, filter }: { month: string; filter: IssueFilter }) {
  const list = useQuery({ queryKey: ['editions', wanted], queryFn: () => read.editions(wanted) });
  const shown = list.data?.month ?? wanted;
  const editions = list.data?.editions ?? [];
  const current = FILTERS.find((item) => item.value === filter) ?? FILTERS[0]!;
  const visible = editions.filter(current.test);
  return (
    <div className="page issues">
      <header className="page-head">
        <div>
          <h2>{shown ? month(shown) : '期刊'}</h2>
          <p className="muted">每期的正文、投递与备份，都来自 Newsletter 的记录；Notion 备份只是它的副本。</p>
        </div>
        <nav className="month-nav" aria-label="其他月份">
          {list.data?.earlier_month ? <a href={issuesHref(list.data.earlier_month, filter)}>‹ {month(list.data.earlier_month)}</a> : <span className="muted">‹ 没有更早的期刊</span>}
          {list.data?.later_month ? <a href={issuesHref(list.data.later_month, filter)}>{month(list.data.later_month)} ›</a> : null}
        </nav>
      </header>
      <nav className="segmented" aria-label="筛选期刊">
        {FILTERS.map((item) => {
          const n = list.isSuccess ? editions.filter(item.test).length : null;
          return (
            <a key={item.value} href={issuesHref(shown, item.value)} aria-current={item.value === current.value ? 'page' : undefined}
              aria-label={n === null ? undefined : `${item.name} ${String(n)} 期`}>
              {item.name}{n === null ? null : <span className="segment-count">{n}</span>}
            </a>
          );
        })}
      </nav>
      {list.isPending ? <p className="muted">正在读取期刊…</p> : null}
      {list.isError ? <p className="notice">期刊暂时读不到，稍后刷新。</p> : null}
      {list.isSuccess && visible.length === 0 ? (
        <p className="card empty">
          {current.empty}
          {current.value === 'unsent' ? <> <a href={runsHref(shown)}>查看这个月的运行 →</a></> : null}
        </p>
      ) : null}
      {visible.length > 0 ? (
        <ol className="issue-grid" aria-label={`${month(shown)}的期刊`}>
          {visible.map((edition) => <IssueCard key={edition.name} edition={edition} />)}
        </ol>
      ) : null}
    </div>
  );
}

import { useQuery } from '@tanstack/react-query';
import type { Run } from '@ziyixi/proto/newsletter/ui/v1/run_wire';
import { read } from './api.ts';
import { count, deliveryState, duration, issueDate, month, runState, seconds, trigger } from './format.ts';
import { Mark } from './Mark.tsx';
import { stopSentence } from './Overview.tsx';
import { runHref, runsHref } from './route.ts';

/** The run's outcome in a few words: its stop for a stopped run, else its delivery. */
function outcome(run: Run): string {
  if (run.state === 'blocked' || run.state === 'failed') return stopSentence(run);
  if (run.state === 'ready') return deliveryState(run.delivery_state).label;
  return '';
}

function RunRow({ run }: { run: Run }) {
  const elapsed = seconds(run.start_time ?? run.create_time, run.end_time);
  const usage = run.usage;
  return (
    <li>
      <a className="run-row" href={runHref(run.name)}>
        <span className="run-date">
          <strong>{issueDate(run.issue_date, true)}</strong>
          <span className={`chip${run.trigger === 'scheduled' ? '' : ' quiet'}`}>{trigger(run.trigger)}</span>
        </span>
        <span className="run-state">
          <Mark word={runState(run.state)} />
          <span className="run-outcome">{outcome(run)}</span>
        </span>
        <span className="run-num"><span className="run-num-label">用时</span>{run.end_time ? duration(elapsed) : '—'}</span>
        <span className="run-num"><span className="run-num-label">模型调用</span>{usage?.call_count ? `${String(usage.call_count)} 次 · ${count((usage.input_tokens ?? 0) + (usage.output_tokens ?? 0))} tokens` : '—'}</span>
        <span className="run-go" aria-hidden="true">→</span>
      </a>
    </li>
  );
}

export function RunsPage({ month: wanted }: { month: string }) {
  const list = useQuery({ queryKey: ['runs', wanted], queryFn: () => read.runs(wanted) });
  const shown = list.data?.month ?? wanted;
  const runs = list.data?.runs ?? [];
  return (
    <div className="page runs">
      <header className="page-head">
        <div>
          <h2>{shown ? month(shown) : '最近的运行'}</h2>
          <p className="muted">每一次运行冻结的配置与预算、停在哪里、调用了什么；时间按你的浏览器时区显示。</p>
        </div>
        <nav className="month-nav" aria-label="其他月份">
          {list.data?.earlier_month ? <a href={runsHref(list.data.earlier_month)}>‹ {month(list.data.earlier_month)}</a> : <span className="muted">‹ 没有更早的记录</span>}
          {list.data?.later_month ? <a href={runsHref(list.data.later_month)}>{month(list.data.later_month)} ›</a> : null}
        </nav>
      </header>
      {list.isPending ? <p className="muted">正在读取运行记录…</p> : null}
      {list.isError ? <p className="notice">运行记录暂时读不到，稍后刷新。</p> : null}
      {list.isSuccess && runs.length === 0 ? <p className="card empty">这个月没有运行记录。</p> : null}
      {runs.length > 0 ? (
        <ol className="run-list" aria-label={`${month(shown)}的运行`}>
          {runs.map((run) => <RunRow key={run.name} run={run} />)}
        </ol>
      ) : null}
    </div>
  );
}

import { useState } from 'react';
import type { Run, RunNode, RunNodeItem } from '@ziyixi/proto/newsletter/ui/v1/run_wire';
import { duration, nodeName, nodeState, seconds, SHAPES, time, wholeSeconds } from './format.ts';
import { Mark } from './Mark.tsx';

/** Tick spacings the axis may use, in seconds; the first that gives at most six ticks wins. */
const STEPS = [10, 30, 60, 120, 300, 600, 900, 1800, 3600];

interface Span {
  readonly left: number;
  readonly width: number;
}

/** Percentages of the run's time frame [start, end]. */
function spanOf(from: number, to: number, start: number, total: number): Span {
  const left = Math.max(0, Math.min(1, (from - start) / total));
  const right = Math.max(left, Math.min(1, (to - start) / total));
  return { left: left * 100, width: (right - left) * 100 };
}

const pct = (value: number): string => `${value.toFixed(3)}%`;

interface Frame {
  readonly start: number;
  readonly total: number;
  readonly now: number;
}

/** One bar: its part within the frozen budget, the part past it, and the budget's hairline. */
function Bar({ start, end, budget, tone, frame }: { start?: string; end?: string; budget: number; tone: string; frame: Frame }) {
  if (!start) return <span className="bar-none">未开始</span>;
  const from = Date.parse(start);
  const to = end ? Date.parse(end) : frame.now;
  const limit = budget > 0 ? from + budget * 1000 : undefined;
  const within = spanOf(from, limit === undefined ? to : Math.min(to, limit), frame.start, frame.total);
  const over = limit !== undefined && to > limit ? spanOf(limit, to, frame.start, frame.total) : undefined;
  const tick = limit === undefined ? undefined : spanOf(limit, limit, frame.start, frame.total).left;
  return (
    <>
      {/* Past the budget only the overrun is red: the part within it keeps the normal colour. */}
      <span className={`bar ${over ? 'ok' : tone}${end ? '' : ' open'}`} style={{ left: pct(within.left), width: pct(within.width) }} />
      {over ? <span className="bar over" style={{ left: pct(over.left), width: pct(over.width) }} /> : null}
      {tick !== undefined && tick < 100 ? <span className="budget-tick" style={{ left: pct(tick) }} title={`预算 ${wholeSeconds(budget)}`} /> : null}
    </>
  );
}

function toneOf(state: string | undefined, degraded: boolean): string {
  if (state === 'failed') return 'bad';
  if (state === 'unknown') return 'unknown';
  if (degraded) return 'warn';
  if (state === 'running') return 'running';
  return 'ok';
}

function NodeRow({ node, frame }: { node: RunNode; frame: Frame }) {
  const [open, setOpen] = useState(false);
  const degraded = Boolean(node.degraded) || node.error_code === 'partial_failure';
  const word = nodeState(node.state, degraded);
  const elapsed = seconds(node.start_time, node.end_time);
  const budget = node.budget_seconds ?? 0;
  const over = budget > 0 && elapsed !== undefined && elapsed > budget;
  const items: readonly RunNodeItem[] = node.items ?? [];
  const done = (node.item_count ?? 0) - (node.failed_item_count ?? 0);
  return (
    <>
      <li className={`gantt-row ${word.tone}`}>
        <span className="gantt-label">
          <span className={`shape ${word.tone}`} aria-hidden="true">{SHAPES[word.tone]}</span>
          <span className="gantt-name">{nodeName(node)}</span>
          {items.length > 0 ? (
            <button type="button" className="items-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
              {done}/{node.item_count} 完成
            </button>
          ) : null}
        </span>
        <span className="gantt-track">
          <Bar start={node.start_time} end={node.end_time} budget={budget} tone={toneOf(node.state, degraded)} frame={frame} />
        </span>
        <span className="gantt-time">
          {/* Against a budget, both in whole seconds, as the failure panel says them. */}
          {elapsed === undefined
            ? budget > 0 ? <span className="muted">预算 {wholeSeconds(budget)}</span> : null
            : budget > 0 ? <>{wholeSeconds(elapsed)}<span className="muted"> / {wholeSeconds(budget)}</span></> : duration(elapsed)}
          {over ? <span className="mark bad over-note"><span aria-hidden="true">■</span>超出预算</span> : null}
        </span>
      </li>
      {open ? items.map((item) => {
        const itemWord = nodeState(item.state);
        const itemElapsed = seconds(item.start_time, item.end_time);
        return (
          <li key={item.item_id} className="gantt-row item">
            <span className="gantt-label">
              <span className={`shape ${itemWord.tone}`} aria-hidden="true">{SHAPES[itemWord.tone]}</span>
              <span className="gantt-name" title={item.label}>{item.label || item.item_id}</span>
            </span>
            <span className="gantt-track">
              <Bar start={item.start_time} end={item.end_time} budget={0} tone={toneOf(item.state, false)} frame={frame} />
            </span>
            <span className="gantt-time">{itemElapsed === undefined ? itemWord.label : duration(itemElapsed)}</span>
          </li>
        );
      }) : null}
    </>
  );
}

function Axis({ frame }: { frame: Frame }) {
  const totalSeconds = frame.total / 1000;
  const step = STEPS.find((s) => totalSeconds / s <= 6) ?? 3600;
  const ticks: number[] = [];
  for (let t = 0; t <= totalSeconds; t += step) ticks.push(t);
  return (
    <div className="gantt-axis" aria-hidden="true">
      <span className="gantt-label" />
      <span className="gantt-track">
        {ticks.map((t) => (
          <span key={t} className="axis-tick" style={{ left: pct((t / totalSeconds) * 100) }}>
            {t === 0 ? '0' : `+${duration(t)}`}
          </span>
        ))}
      </span>
      <span className="gantt-time" />
    </div>
  );
}

/**
 * The run's frozen graph on a time axis: one row per node from its first attempt's start to its last attempt's end,
 * a hairline at the node's frozen budget, and the part past it in red. Mapped nodes open into their items. A table
 * follows with the same numbers.
 */
export function Timeline({ run, now = Date.now() }: { run: Run; now?: number }) {
  const nodes = run.nodes ?? [];
  const starts = nodes.map((node) => node.start_time).filter((value): value is string => Boolean(value)).map(Date.parse);
  const ends = nodes.map((node) => node.end_time).filter((value): value is string => Boolean(value)).map(Date.parse);
  const start = run.start_time ? Date.parse(run.start_time) : Math.min(...starts);
  const end = run.end_time ? Date.parse(run.end_time) : Math.max(now, ...ends);
  if (nodes.length === 0 || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return <p className="muted">这次运行还没有节点开始。</p>;
  }
  const frame: Frame = { start, total: end - start, now };
  return (
    <>
      <ol className="gantt" aria-label="节点时间线">
        {nodes.map((node) => <NodeRow key={node.node_id} node={node} frame={frame} />)}
      </ol>
      <Axis frame={frame} />
      <p className="muted small axis-note">时间自运行开始（{time(frame.start, false, true)}）起算。</p>
      <details className="twin">
        <summary>以表格查看</summary>
        <div className="table-scroll">
          <table>
            <thead>
              <tr><th scope="col">节点</th><th scope="col">状态</th><th scope="col">开始</th><th scope="col">结束</th><th scope="col">用时</th><th scope="col">预算</th><th scope="col">错误码</th></tr>
            </thead>
            <tbody>
              {nodes.map((node) => (
                <tr key={node.node_id}>
                  <td>{nodeName(node)}</td>
                  <td><Mark word={nodeState(node.state, Boolean(node.degraded) || node.error_code === 'partial_failure')} /></td>
                  <td>{node.start_time ? time(node.start_time, false, true) : '—'}</td>
                  <td>{node.end_time ? time(node.end_time, false, true) : '—'}</td>
                  <td>{duration(seconds(node.start_time, node.end_time))}</td>
                  <td>{node.budget_seconds ? wholeSeconds(node.budget_seconds) : '—'}</td>
                  <td>{node.error_code ? <code>{node.error_code}</code> : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </>
  );
}

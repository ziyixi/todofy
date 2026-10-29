import { useQuery } from '@tanstack/react-query';
import type { ReplicaCounts, ReplicaException } from '@ziyixi/proto/newsletter/ui/v1/backup_status_wire';
import { read } from './api.ts';
import { SHAPES, daysBetween, httpsUrl, issueDate, replicaState, replicaTarget, time } from './format.ts';
import { Mark } from './Mark.tsx';
import { issueHref } from './route.ts';

/** The one sentence the page stands on: the record is Newsletter's, Notion holds a copy. */
export const AUTHORITY = '权威记录：Newsletter 的 SQLite。Notion：异步副本，便于阅读与检索；在 Notion 中的修改不会回写。';

/** What to do about a record in each state that needs attention. */
const GUIDANCE: Readonly<Record<string, string>> = {
  unknown: '写入结果未确认：可能已产生副本，先核对，避免重复创建。',
  conflict: 'Notion 中的页面与记录不一致（在 Notion 中改过，或身份重复）；自动写入暂停，直到再次读取时一致。',
  retrying: '上次写入失败，会自动再试。',
  outdated: '记录在上次写入之后有变化；下次写入之前，副本仍是旧版本。',
};

/** Counts in the order a record moves through them, each a shape and a word as on the issues. */
const STATES: readonly { key: keyof ReplicaCounts; state: string }[] = [
  { key: 'synced_count', state: 'synced' },
  { key: 'syncing_count', state: 'syncing' },
  { key: 'outdated_count', state: 'outdated' },
  { key: 'retrying_count', state: 'retrying' },
  { key: 'unknown_count', state: 'unknown' },
  { key: 'conflict_count', state: 'conflict' },
];

function Target({ counts, now }: { counts: ReplicaCounts; now: string | undefined }) {
  const name = replicaTarget(counts.target);
  const waited = daysBetween(counts.oldest_pending_time, now);
  return (
    <section className="card target" aria-label={name}>
      <h2>{name}</h2>
      <ul className="target-counts">
        {STATES.map(({ key, state }) => {
          const word = replicaState(state);
          const value = Number(counts[key] ?? 0);
          return (
            <li key={state} className={value === 0 ? 'zero' : undefined}>
              <span className="target-value">{value}</span>
              <span className={`mark ${value === 0 ? 'none' : word.tone}`}><span className="shape" aria-hidden="true">{SHAPES[value === 0 ? 'none' : word.tone]}</span>{word.label}</span>
            </li>
          );
        })}
      </ul>
      <dl className="facts compact">
        <div><dt>最近确认写入</dt><dd>{counts.last_progress_time ? time(counts.last_progress_time, true) : '尚无记录'}</dd></div>
        <div>
          <dt>最早待同步</dt>
          <dd>{counts.oldest_pending_time ? `${time(counts.oldest_pending_time, true)}起${waited ? `，已等 ${String(waited)} 天` : ''}` : '没有，副本与记录一致'}</dd>
        </div>
      </dl>
    </section>
  );
}

function Exception({ item }: { item: ReplicaException }) {
  const replica = item.replica;
  const notion = httpsUrl(replica?.notion_url);
  const facts = [
    replica?.attempt_count ? `已尝试 ${String(replica.attempt_count)} 次` : null,
    replica?.state === 'retrying' && replica.next_retry_time ? `下次 ${time(replica.next_retry_time, true)}` : null,
    replica?.last_progress_time ? `最近确认写入 ${time(replica.last_progress_time, true)}` : null,
  ].filter(Boolean).join(' · ');
  return (
    <li>
      <div className="exception-head">
        <span className="chip quiet">{replicaTarget(item.target)}</span>
        <span className="exception-date">{item.issue_date ? issueDate(item.issue_date) : '日期未记录'}</span>
        {item.edition
          ? <a className="exception-title" href={issueHref(item.edition)}>{item.title || '未命名期刊'}</a>
          : <span className="exception-title">{item.title || '未命名材料'}</span>}
        <Mark word={replicaState(replica?.state)} />
      </div>
      <p className="exception-guidance">{GUIDANCE[replica?.state ?? ''] ?? ''}</p>
      <p className="muted small">
        {facts}
        {replica?.error_code ? <>{facts ? ' · ' : ''}<code>{replica.error_code}</code></> : null}
        {notion ? <>{facts || replica?.error_code ? ' · ' : ''}<a href={notion} target="_blank" rel="noopener noreferrer">在 Notion 中打开</a></> : null}
      </p>
    </li>
  );
}

export function BackupPage() {
  const status = useQuery({ queryKey: ['backupStatus'], queryFn: read.backupStatus });
  if (status.isPending) return <p className="muted">正在读取备份状态…</p>;
  if (status.isError) return <p className="notice">备份状态暂时读不到，稍后刷新。</p>;
  const data = status.data;
  const exceptions = data.exceptions ?? [];
  const imports = Object.entries(data.import_error_counts ?? {}).filter(([, n]) => n > 0);
  return (
    <div className="page backup">
      <header className="page-head">
        <div>
          <h2>Notion 备份</h2>
          <p className="muted">这里的状态都来自 Newsletter 的备份日志，读取这一页不会访问 Notion。读取于 {time(data.generate_time, true)}。</p>
        </div>
      </header>
      <p className="authority" role="note">{AUTHORITY}</p>
      {data.enabled ? null : (
        <p className="notice"><Mark word={{ label: 'Notion 备份未启用', tone: 'none' }} />：下面是关闭之前写入的副本。</p>
      )}
      <p className="muted">{data.includes_personal ? '个人事项（Todofy）随期刊写入备份。' : '个人事项（Todofy）不写入备份，只在这里与邮件中可见。'}</p>
      <div className="pair">
        {(data.targets ?? []).map((counts) => <Target key={counts.target ?? 'all'} counts={counts} now={data.generate_time} />)}
      </div>
      <section className="card exceptions" aria-labelledby="exceptions-title">
        <header className="card-head">
          <h2 id="exceptions-title">需要关注的记录</h2>
          <p className="muted">最早的在前，至多 50 条</p>
        </header>
        {exceptions.length === 0
          ? <p className="muted">没有需要关注的记录。</p>
          : <ul className="exception-rows">{exceptions.map((item, index) => <Exception key={index} item={item} />)}</ul>}
      </section>
      {imports.length > 0 ? (
        <section className="card" aria-labelledby="imports-title">
          <h2 id="imports-title">未能记入备份日志</h2>
          <ul className="rows">
            {imports.map(([code, n]) => <li key={code}><code>{code}</code><span>{n} 条</span></li>)}
          </ul>
          <p className="muted small">这些记录没有进入备份日志，所以也不在上面的计数里。</p>
        </section>
      ) : null}
    </div>
  );
}

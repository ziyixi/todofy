import { useQuery } from '@tanstack/react-query';
import type { MouseEvent } from 'react';
import type {
  Edition, EditionChart, EditionReading, EditionReference, EditionSection, PersonalDigest,
} from '@ziyixi/proto/newsletter/ui/v1/edition_wire';
import { read } from './api.ts';
import {
  accessScope, count, deliveryState, editionKind, hostOf, httpsUrl, idOf, issueDate, personalState, replicaState,
  sectionKind, short, time, webUrl, type Word,
} from './format.ts';
import { Mark } from './Mark.tsx';
import { issueHref, issuesHref, runHref, type ReaderView } from './route.ts';

/**
 * The frozen email's own policy, put before its markup: no scripts, fetches, fonts, forms or base, only its embedded
 * data: images and inline styles. The frame adds `sandbox=""` (no scripts, a unique origin, no navigation of the
 * page, no popups) and inherits the page's own CSP, so links inside it cannot be followed.
 */
export const MAIL_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'";

/**
 * The email's HTML for the frame's srcdoc, with MAIL_CSP first. The email's doctype stays in front, so the frame renders
 * in the mode the email was written for; everything after it is the email, never parsed or changed here. Links open
 * in a new window by default, which the sandbox refuses: a click does nothing, rather than replace the email with the
 * browser's error page for a navigation the page's CSP blocks.
 */
export function isolatedMail(html: string): string {
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html)?.[0] ?? '';
  return `${doctype}<meta http-equiv="Content-Security-Policy" content="${MAIL_CSP}"><base target="_blank">${html.slice(doctype.length)}`;
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
/** The chart as the email embedded it: a PNG data: URL only when the text is plain base64, never anything else. */
export function chartImage(base64: string | undefined): string | null {
  return base64 && BASE64.test(base64) ? `data:image/png;base64,${base64}` : null;
}

/** The email's chart caption line (newsletter/src/newsletter/charts.py `chart_metadata`), so both say the same. */
export function chartMetadata(chart: EditionChart): string {
  const metric = (chart.metric ?? '').trim();
  const unit = (chart.unit ?? '').trim();
  const included = metric === unit || metric.endsWith(`（${unit}）`) || metric.endsWith(`(${unit})`);
  return `指标：${included || !unit ? metric : `${metric}（${unit}）`} · 范围：${chart.period ?? ''}`;
}

/** Paragraphs as the email splits them: at blank lines; single line breaks stay inside a paragraph (pre-line). */
function paragraphsOf(text: string | undefined): string[] {
  return (text ?? '').split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
}

/** Moves to a numbered reference without touching the location hash, which names the page. */
function toReference(number: number) {
  return (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    const target = document.getElementById(`ref-${String(number)}`);
    target?.scrollIntoView?.({ block: 'center' });
    target?.focus({ preventScroll: true });
  };
}

type References = ReadonlyMap<number, EditionReference>;

/** `[1][2]` after a paragraph, each a link to its reference when the edition lists it. */
function Cites({ numbers, references }: { numbers: readonly number[] | undefined; references: References }) {
  if (!numbers?.length) return null;
  return (
    <sup className="cites">
      {numbers.map((number, index) => {
        const reference = references.get(number);
        return reference
          ? <a key={index} href={`#ref-${String(number)}`} title={reference.title} onClick={toReference(number)}>[{number}]</a>
          : <span key={index}>[{number}]</span>;
      })}
    </sup>
  );
}

function Section({ section, index, references }: { section: EditionSection; index: number; references: References }) {
  const id = `section-${String(index + 1)}`;
  return (
    <section className="reader-block" aria-labelledby={id}>
      <p className="reader-kicker">{String(index + 1).padStart(2, '0')} / {sectionKind(section.kind)}</p>
      <h3 id={id} className={section.kind === 'feature' ? 'feature' : undefined}>{section.heading}</h3>
      {(section.paragraphs ?? []).map((paragraph, at) => (
        <p key={at} className="reader-text">{paragraph.text}<Cites numbers={paragraph.reference_numbers} references={references} /></p>
      ))}
      {section.limitations ? <p className="reader-limit">边界：{section.limitations}</p> : null}
    </section>
  );
}

function Chart({ chart, image, references }: { chart: EditionChart; image: string | null; references: References }) {
  const points = chart.points ?? [];
  return (
    <figure className="reader-block reader-chart" aria-labelledby="chart-title">
      <p className="reader-kicker">一图看懂 / 数据视角</p>
      <h3 id="chart-title">{chart.question}</h3>
      {image ? <img src={image} alt={chart.alt_text ?? ''} /> : <p className="muted small">这期没有保存图表图片；数值见下表。</p>}
      <figcaption>
        {chart.caption ? <p className="reader-text">{chart.caption}</p> : null}
        <p className="reader-note">
          {chartMetadata(chart)}
          <br />
          {chart.kind === 'line' ? '缺失值断线，不作零值处理。' : '条形以零为基线；缺失不代表零。'}
        </p>
      </figcaption>
      {/* The values as the email's table states them: the unit is the metadata line's. */}
      <table className="chart-points" aria-label="图表原始数据">
        <tbody>
          {points.map((point, index) => (
            <tr key={index}>
              <th scope="row">{point.label}</th>
              <td className="num">
                {point.decimal_value || `缺失（${point.missing_reason || '原因未记录'}）`}
                <Cites numbers={point.reference_numbers} references={references} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {chart.limitations ? <p className="reader-limit">边界：{chart.limitations}</p> : null}
    </figure>
  );
}

function Reading({ reading, references }: { reading: EditionReading; references: References }) {
  const number = reading.reference_number ?? 0;
  const reference = references.get(number);
  const href = webUrl(reference?.url);
  return (
    <section className="reader-block reader-reading" aria-labelledby="reading-title">
      <p className="reader-kicker">研究介绍</p>
      <h3 id="reading-title">{reference?.title || `参考 [${String(number)}]`}<Cites numbers={[number]} references={references} /></h3>
      {paragraphsOf(reading.reason).map((paragraph, index) => <p key={index} className="reader-text">{paragraph}</p>)}
      {reading.supporting_reference_numbers?.length ? (
        <p className="reader-note">补充证据：<Cites numbers={reading.supporting_reference_numbers} references={references} />（见文末来源）</p>
      ) : null}
      {href ? (
        <p className="reader-note">
          <a href={href} target="_blank" rel="noopener noreferrer">原文与方法 [{number}]</a>
          {[accessScope(reference?.access_scope), reference?.publication_date].filter(Boolean).map((part) => ` · ${part ?? ''}`).join('')}
        </p>
      ) : null}
    </section>
  );
}

/** The private Todofy section: the owner's own items, labelled as such, and whether the backup copies them. */
function Personal({ digest }: { digest: PersonalDigest }) {
  const word = personalState(digest.state);
  const meta = [
    digest.task_count === undefined ? null : `${String(digest.task_count)} 条来源记录`,
    digest.fetch_time ? `${time(digest.fetch_time, true)} 读取` : null,
  ].filter(Boolean).join(' · ');
  return (
    <section className="reader-block reader-personal" aria-labelledby="personal-title">
      <p className="reader-kicker">个人事项 · 来自 Todofy<span className="private">仅你可见</span></p>
      <h3 id="personal-title">{digest.title || '与你有关'}</h3>
      {meta ? <p className="reader-note">{meta}</p> : null}
      {digest.state !== 'current' ? (
        <p className="reader-note"><Mark word={word} />{digest.error_code ? <> · <code>{digest.error_code}</code></> : null}</p>
      ) : null}
      {paragraphsOf(digest.summary).map((paragraph, index) => <p key={index} className="reader-text">{paragraph}</p>)}
      {digest.items?.length ? (
        <ol className="personal-items">
          {digest.items.map((item, index) => (
            <li key={index}>
              <span className="personal-rank" aria-hidden="true">{item.rank ?? index + 1}</span>
              <div>
                <strong>{item.title}</strong>
                {item.detail ? <p className="reader-text">{item.detail}</p> : null}
              </div>
            </li>
          ))}
        </ol>
      ) : null}
      <p className="reader-note">{digest.backup_included ? '这一节随本期写入 Notion 备份。' : '这一节不写入 Notion 备份。'}</p>
    </section>
  );
}

function ReferenceList({ references }: { references: readonly EditionReference[] }) {
  return (
    <section className="reader-block reader-refs" aria-labelledby="refs-title">
      <h3 id="refs-title" className="reader-kicker">来源与核对</h3>
      <ol className="ref-list">
        {references.map((reference) => {
          const href = webUrl(reference.url);
          const meta = [hostOf(reference.url), accessScope(reference.access_scope), reference.publication_date].filter(Boolean);
          return (
            <li key={reference.number} id={`ref-${String(reference.number)}`} tabIndex={-1}>
              <span className="ref-number">[{reference.number}]</span>
              <span className="ref-body">
                {href ? <a href={href} target="_blank" rel="noopener noreferrer">{reference.title || href}</a> : <span>{reference.title || '未命名来源'}</span>}
                {meta.length ? <span className="ref-meta">{meta.join(' · ')}</span> : null}
              </span>
            </li>
          );
        })}
      </ol>
      <p className="reader-note">链接在新标签页打开；控制台不会读取这些地址。</p>
    </section>
  );
}

/** 阅读: the edition rendered from its structured body, in the email's order and words, as text only. */
export function Article({ edition }: { edition: Edition }) {
  const references: References = new Map((edition.references ?? []).map((reference) => [reference.number ?? 0, reference]));
  const image = chartImage(edition.chart_png_base64);
  return (
    <article className="reader" aria-labelledby="issue-title">
      <p className="reader-eyebrow">{issueDate(edition.issue_date, true)} · {editionKind(edition.kind)}</p>
      <h2 id="issue-title" className="reader-title">{edition.title || '未命名期刊'}</h2>
      {edition.subject ? <p className="reader-subject">邮件主题：{edition.subject}</p> : null}
      <div className="reader-intro">
        {paragraphsOf(edition.introduction).map((paragraph, index) => <p key={index}>{paragraph}</p>)}
      </div>
      {(edition.sections ?? []).map((section, index) => <Section key={index} section={section} index={index} references={references} />)}
      {edition.chart ? <Chart chart={edition.chart} image={image} references={references} /> : null}
      {edition.recommended_reading ? <Reading reading={edition.recommended_reading} references={references} /> : null}
      {edition.limitations ? (
        <section className="reader-block" aria-labelledby="limits-title">
          <h3 id="limits-title" className="reader-kicker">本期边界</h3>
          {paragraphsOf(edition.limitations).map((paragraph, index) => <p key={index} className="reader-text">{paragraph}</p>)}
        </section>
      ) : null}
      {edition.references?.length ? <ReferenceList references={edition.references} /> : null}
      {edition.personal_digest ? <Personal digest={edition.personal_digest} /> : null}
    </article>
  );
}

/** 邮件原样 and 纯文本: the frozen rendering, read only when one of them is opened (it never changes). */
function Rendering({ edition, view }: { edition: Edition; view: 'mail' | 'text' }) {
  const name = edition.name ?? '';
  const rendering = useQuery({ queryKey: ['rendering', name], queryFn: () => read.rendering(name), staleTime: Infinity });
  if (rendering.isPending) return <p className="muted">正在读取邮件原样…</p>;
  if (rendering.isError) return <p className="notice">邮件原样暂时读不到，稍后刷新。</p>;
  const data = rendering.data;
  const mismatch = data.render_hash && edition.render_hash && data.render_hash !== edition.render_hash;
  return (
    <div className="rendering">
      {mismatch ? (
        <p className="notice"><Mark word={{ label: '渲染指纹与期刊记录不一致', tone: 'warn' }} />：先核对，再以期刊记录为准。</p>
      ) : null}
      {view === 'mail' ? (
        <>
          <p className="muted small">
            隔离窗口展示，链接不可点击，请用「阅读」中的参考列表。邮件里的个人事项同样仅你可见。
          </p>
          {data.html ? (
            <iframe className="mail-frame" title="邮件原样" sandbox="" referrerPolicy="no-referrer" srcDoc={isolatedMail(data.html)} />
          ) : <p className="card empty">这期没有保存 HTML 正文。</p>}
        </>
      ) : data.text ? <pre className="mail-text">{data.text}</pre> : <p className="card empty">这期没有保存纯文本正文。</p>}
    </div>
  );
}

/** The record beside the issue: run, configuration, delivery, the Notion copy, model use and the review. */
function Rail({ edition }: { edition: Edition }) {
  const delivery = edition.delivery;
  const backup = edition.backup;
  const notion = httpsUrl(backup?.notion_url);
  const usage = edition.usage;
  // The record keeps a passed review as true and anything else as false: without findings, false may only mean that
  // no review was recorded (a fixture), which is not a failure.
  const review: Word = edition.review_passed ? { label: '通过', tone: 'ok' }
    : edition.review_findings?.length ? { label: '未通过', tone: 'warn' } : { label: '无通过记录', tone: 'none' };
  const deliveryNote = delivery?.state === 'unknown'
    ? '结果未确认：先核对实际邮件，不能换请求键重发。'
    : delivery?.state === 'provider_accepted' ? '邮件服务已接收不代表进入收件箱。' : null;
  return (
    <aside className="reader-rail" aria-label="本期记录">
      <dl className="rail">
        <div>
          <dt>运行</dt>
          <dd>{edition.run ? <a href={runHref(edition.run)}>查看运行 <code>{idOf(edition.run).slice(0, 8)}</code></a> : '没有对应的运行'}</dd>
          <dd className="rail-note">生成于 {time(edition.create_time, true)} · 配置 <code>{short(edition.config_revision)}</code></dd>
        </div>
        <div>
          <dt>投递</dt>
          <dd><Mark word={deliveryState(delivery?.state)} /></dd>
          {delivery?.update_time ? <dd className="rail-note">更新于 {time(delivery.update_time, true)}</dd> : null}
          {delivery?.error_code ? <dd className="rail-note"><code>{delivery.error_code}</code></dd> : null}
          {delivery?.verification_count ? <dd className="rail-note">这一天已发修订 {delivery.verification_count} 次</dd> : null}
          {deliveryNote ? <dd className="rail-note">{deliveryNote}</dd> : null}
        </div>
        <div>
          <dt>Notion 副本</dt>
          <dd><Mark word={replicaState(backup?.state)} /></dd>
          <dd className="rail-note">
            {backup?.last_progress_time ? `最近确认写入 ${time(backup.last_progress_time, true)}`
              : backup?.state === 'synced' || backup?.state === 'outdated' ? '写入时间上线前未记录' : '尚无确认的写入'}
          </dd>
          {backup?.state === 'retrying' && backup.next_retry_time ? (
            <dd className="rail-note">下次重试 {time(backup.next_retry_time, true)} · 已尝试 {backup.attempt_count ?? 0} 次</dd>
          ) : null}
          {backup?.error_code ? <dd className="rail-note"><code>{backup.error_code}</code></dd> : null}
          {notion ? <dd className="rail-note"><a href={notion} target="_blank" rel="noopener noreferrer">在 Notion 中打开</a></dd> : null}
          <dd className="rail-note">异步副本，以这里的记录为准；在 Notion 中的修改不会回写。</dd>
        </div>
        <div>
          <dt>模型用量</dt>
          <dd>{usage?.call_count ? `${String(usage.call_count)} 次调用` : '无记录'}</dd>
          {usage?.call_count ? (
            <dd className="rail-note">
              输入 {count(usage.input_tokens ?? 0)} · 输出 {count(usage.output_tokens ?? 0)} tokens{usage.complete ? '' : '（下限）'}；即邮件页脚的数字
            </dd>
          ) : null}
        </div>
        <div>
          <dt>审校</dt>
          <dd><Mark word={review} /></dd>
          {edition.review_findings?.length ? (
            <dd className="rail-note">
              <ul className="findings">{edition.review_findings.map((finding, index) => <li key={index}>{finding}</li>)}</ul>
            </dd>
          ) : null}
        </div>
        {edition.corrected_edition ? (
          <div><dt>修订自</dt><dd><a href={issueHref(edition.corrected_edition)}>原来的一期</a></dd></div>
        ) : null}
        <div><dt>渲染指纹</dt><dd><code title={edition.render_hash}>{short(edition.render_hash)}</code></dd></div>
      </dl>
    </aside>
  );
}

const VIEWS: readonly { value: ReaderView; name: string }[] = [
  { value: 'read', name: '阅读' },
  { value: 'mail', name: '邮件原样' },
  { value: 'text', name: '纯文本' },
];

export function IssuePage({ id, view }: { id: string; view: ReaderView }) {
  const name = `editions/${id}`;
  const edition = useQuery({ queryKey: ['edition', name], queryFn: () => read.edition(name) });
  if (edition.isPending) return <p className="muted">正在读取这一期…</p>;
  if (edition.isError) {
    return (
      <div className="page issue">
        <p className="crumb"><a href={issuesHref()}>← 全部期刊</a></p>
        <p className="notice">这一期读不到：它可能不存在，或 Newsletter 暂时没有回答。</p>
      </div>
    );
  }
  const data = edition.data;
  return (
    <div className="page issue">
      <div className="issue-bar">
        <p className="crumb"><a href={issuesHref(data.issue_date?.slice(0, 7) ?? '')}>← 全部期刊</a></p>
        <nav className="segmented" aria-label="阅读方式">
          {VIEWS.map((item) => (
            <a key={item.value} href={issueHref(data.name, item.value)} aria-current={item.value === view ? 'page' : undefined}>{item.name}</a>
          ))}
        </nav>
      </div>
      <div className="issue-layout">
        <div className="issue-main">
          {view === 'read' ? <Article edition={data} /> : <Rendering edition={data} view={view} />}
        </div>
        <Rail edition={data} />
      </div>
    </div>
  );
}

import type { NewsletterConfigSync } from '@ziyixi/proto/fleet/telemetry/v1/host_report_wire';
import { configState, type ConfigState } from '../../worker/src/newsletter-config.ts';
import { SHAPES, time, type Tone } from './format.ts';

const STATES: Readonly<Record<ConfigState, { label: string; tone: Tone; guidance: string }>> = {
  current: { label: '与上次检查目标一致', tone: 'ok', guidance: '自动检查继续运行；此处未核对检查之后的新发布。' },
  pending: { label: '等待激活', tone: 'unknown', guidance: '生效配置与上次检查目标或固定版本不同，请等待下一次检查并核对结果。' },
  failed: { label: '配置检查失败', tone: 'warn', guidance: '请按错误码检查配置同步；本次失败不代表每日投递失败。' },
  stale: { label: '配置检查延迟', tone: 'warn', guidance: '超过 30 分钟没有检查，请核对配置同步进程。' },
  pinned: { label: '固定版本', tone: 'unknown', guidance: '当前配置符合固定版本，自动更新暂不跟随远端发布。' },
  unobserved: { label: '尚未取得完整配置观测', tone: 'unknown', guidance: '请等待配置同步与观察器报告；旧版报告不包含这些字段。' },
};

export function NewsletterConfigView({ config, now }: { config: NewsletterConfigSync | null | undefined; now: number }) {
  const state = STATES[configState(config, now)];
  const identity = (value: string | null | undefined) => <code>{value ?? '暂无观测'}</code>;
  return (
    <div className="newsletter-config">
      <h3>内容配置</h3>
      <p className={`state ${state.tone}`}><span aria-hidden="true">{SHAPES[state.tone]} </span>{state.label}</p>
      <p className="muted">{state.guidance}</p>
      <dl className="compare">
        <div className="compare-row"><dt>配置版本</dt><dd><span className="side">生效</span>{identity(config?.active_revision)}</dd><dd><span className="side">上次检查目标</span>{identity(config?.wanted_revision)}</dd></div>
        <div className="compare-row"><dt>配置摘要</dt><dd><span className="side">生效</span>{identity(config?.active_digest)}</dd><dd><span className="side">上次检查目标</span>{identity(config?.wanted_digest)}</dd></div>
        <div className="compare-row"><dt>上次检查目标提交</dt><dd>{identity(config?.wanted_commit)}</dd></div>
        <div className="compare-row"><dt>固定摘要</dt><dd>{config?.pinned_digest ? identity(config.pinned_digest) : '无固定记录'}</dd></div>
        <div className="compare-row"><dt>最近检查</dt><dd><time dateTime={config?.last_attempt_time ?? undefined}>{time(config?.last_attempt_time)}</time></dd></div>
        <div className="compare-row"><dt>最近成功检查</dt><dd><time dateTime={config?.last_success_time ?? undefined}>{time(config?.last_success_time)}</time></dd></div>
        <div className="compare-row"><dt>错误码</dt><dd>{config?.error ? <code>{config.error}</code> : '无错误记录'}</dd></div>
      </dl>
    </div>
  );
}

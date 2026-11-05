import { describe, expect, it } from 'vitest';
import {
  accessScope,
  budgetSeconds,
  callState,
  configState,
  count,
  daysBetween,
  deliveryState,
  dependency,
  dependencyState,
  disposition,
  drainState,
  dropReason,
  duration,
  EDITION_DELIVERY,
  editionKind,
  editorialLimit,
  editorialOrder,
  failureKind,
  hostOf,
  httpsUrl,
  idOf,
  issueDate,
  leadStage,
  microUsd,
  month,
  nodeName,
  nodeNameById,
  nodeState,
  personalState,
  purpose,
  REFERENCE_ORDER,
  referenceStage,
  replicaState,
  replicaTarget,
  runState,
  seconds,
  sectionKind,
  SHAPES,
  short,
  sourceCode,
  sourceKind,
  stopReason,
  stripDay,
  time,
  trigger,
  UNKNOWN_CATEGORIES,
  webUrl,
  wholeSeconds,
} from './format.ts';

describe('the vocabulary', () => {
  it('shows a code it does not know as it is, with ▲, never as healthy', () => {
    expect(SHAPES).toEqual({ ok: '●', warn: '▲', bad: '■', unknown: '◆', none: '○' });
    expect(runState('brand_new')).toEqual({ label: 'brand_new', tone: 'warn' });
    expect(runState(undefined)).toEqual({ label: '无记录', tone: 'none' });
    expect(runState('queued')).toEqual({ label: '排队中', tone: 'unknown' });
    expect(runState('running')).toEqual({ label: '运行中', tone: 'unknown' });
    expect(runState('ready')).toEqual({ label: '已生成', tone: 'ok' });
    expect(runState('blocked')).toEqual({ label: '已停止', tone: 'bad' });
    expect(runState('failed')).toEqual({ label: '出错', tone: 'bad' });
    expect(deliveryState('brand_new')).toEqual({ label: 'brand_new', tone: 'warn' });
    expect(replicaState('brand_new')).toEqual({ label: 'brand_new', tone: 'warn' });
    expect(nodeName({ type: 'brand_new', node_id: 'custom' })).toBe('custom');
    expect(nodeName({ type: 'api_feed', node_id: 'custom' })).toBe('订阅源');
    expect(nodeName({ node_id: 'briefs' })).toBe('简讯');
    expect(nodeName({})).toBe('未命名节点');
    expect(nodeNameById('feeds')).toBe('订阅源');
    expect(nodeNameById('custom_id')).toBe('custom_id');
    expect(nodeNameById(undefined)).toBe('未命名节点');
  });

  it("uses Fleet's delivery words and EDITION_DELIVERY when an edition has no state", () => {
    expect(deliveryState('provider_accepted')).toEqual({ label: '邮件服务已接收', tone: 'ok' });
    expect(deliveryState('unknown')).toEqual({ label: '结果尚未确认', tone: 'unknown' });
    expect(deliveryState('rejected')).toEqual({ label: '邮件服务拒绝', tone: 'bad' });
    expect(deliveryState('not_requested')).toEqual({ label: '未投递', tone: 'warn' });
    expect(deliveryState('submitting')).toEqual({ label: '正在提交', tone: 'unknown' });
    expect(deliveryState('simulated')).toEqual({ label: '模拟投递，未发出邮件', tone: 'warn' });
    expect(deliveryState(undefined)).toEqual({ label: '无期刊', tone: 'none' });
    expect(deliveryState(undefined, EDITION_DELIVERY)).toEqual({ label: '状态未记录', tone: 'warn' });
  });

  it('maps node, failure, stop, trigger, purpose, call, dependency, replica, config and drain states', () => {
    expect(nodeState('succeeded')).toEqual({ label: '完成', tone: 'ok' });
    expect(nodeState('succeeded', true)).toEqual({ label: '部分失败', tone: 'warn' });
    expect(nodeState('failed', true)).toEqual({ label: '失败', tone: 'bad' });
    expect(nodeState('pending')).toEqual({ label: '未开始', tone: 'none' });
    expect(nodeState('running')).toEqual({ label: '运行中', tone: 'unknown' });
    expect(nodeState('skipped')).toEqual({ label: '跳过', tone: 'none' });
    expect(nodeState('unknown')).toEqual({ label: '待核对', tone: 'unknown' });
    expect(nodeState(undefined)).toEqual({ label: '无记录', tone: 'none' });

    expect(failureKind('node_budget')).toBe('超出节点预算');
    expect(failureKind('run_deadline')).toBe('超出运行期限');
    expect(failureKind('unknown_kind', 'err_code')).toBe('err_code');
    expect(failureKind('unknown_kind')).toBe('unknown_kind');
    expect(failureKind(undefined)).toBe('原因未记录');

    expect(stopReason('no_publishable_content')).toBe('没有可发布内容');
    expect(stopReason('workflow_storage')).toBe('Newsletter 存储出错');
    expect(stopReason('workflow_deadline')).toBe('超出运行期限');
    expect(stopReason('brand_new')).toBeNull();
    expect(stopReason(undefined)).toBeNull();

    expect(trigger('scheduled')).toBe('每日');
    expect(trigger('replay')).toBe('重放');
    expect(trigger('manual')).toBe('手动');
    expect(trigger('custom')).toBe('custom');
    expect(trigger(undefined)).toBe('未记录');

    expect(purpose('discovery')).toBe('搜集');
    expect(purpose('selection')).toBe('选题');
    expect(purpose('writer')).toBe('撰写');
    expect(purpose('reviewer')).toBe('审校');
    expect(purpose('repair_writer')).toBe('修订');
    expect(purpose('repair_reviewer')).toBe('复审');
    expect(purpose('custom')).toBe('custom');
    expect(purpose('')).toBeNull();
    expect(purpose(undefined)).toBeNull();

    expect(callState('running')).toEqual({ label: '进行中', tone: 'unknown' });
    expect(callState('completed')).toEqual({ label: '完成', tone: 'ok' });
    expect(callState('failed')).toEqual({ label: '失败', tone: 'bad' });
    expect(callState(undefined)).toEqual({ label: '无记录', tone: 'none' });

    expect(dependency('feeds')).toEqual({ name: '订阅源 HTTP', note: '研究员读取的订阅源' });
    expect(dependency('custom')).toEqual({ name: 'custom', note: '' });
    expect(dependency(undefined)).toEqual({ name: '未命名接口', note: '' });

    expect(dependencyState('ok', 0)).toEqual({ label: '没有调用', tone: 'none' });
    expect(dependencyState('ok', undefined)).toEqual({ label: '没有调用', tone: 'none' });
    expect(dependencyState('ok', 3)).toEqual({ label: '正常', tone: 'ok' });
    expect(dependencyState('attention', 1)).toEqual({ label: '需要关注', tone: 'warn' });
    expect(dependencyState('failed', 1)).toEqual({ label: '失败', tone: 'bad' });
    expect(dependencyState(undefined, 1)).toEqual({ label: '无记录', tone: 'none' });

    expect(replicaState('synced')).toEqual({ label: '已同步', tone: 'ok' });
    expect(replicaState('conflict')).toEqual({ label: '有冲突', tone: 'bad' });
    expect(replicaState(undefined)).toEqual({ label: '无记录', tone: 'none' });

    expect(configState('current').label).toBe('与上次检查目标一致');
    expect(configState('brand_new')).toEqual({ label: 'brand_new', tone: 'warn', guidance: '' });
    expect(configState(undefined)).toEqual({ label: '尚未取得完整配置观测', tone: 'warn', guidance: '' });

    expect(drainState('active')).toEqual({ label: '可接收', tone: 'ok' });
    expect(drainState('draining')).toEqual({ label: '排空中', tone: 'warn' });
    expect(drainState('frozen')).toEqual({ label: '已冻结', tone: 'warn' });
    expect(drainState(undefined)).toEqual({ label: '未知', tone: 'unknown' });

    expect(UNKNOWN_CATEGORIES.interrupted_activities).toBe('运行中断');
    expect(UNKNOWN_CATEGORIES.delivery).toBe('邮件投递');
  });

  it('maps edition, source, editorial and retrieval funnel labels', () => {
    expect(editionKind('daily')).toBe('日常');
    expect(editionKind('correction')).toBe('修订');
    expect(editionKind('test')).toBe('测试');
    expect(editionKind('custom')).toBe('custom');
    expect(editionKind('')).toBe('类型未记录');
    expect(editionKind(undefined)).toBe('类型未记录');

    expect(sectionKind('world')).toBe('世界简报');
    expect(sectionKind('ai_ml')).toBe('AI / ML 进展');
    expect(sectionKind('custom')).toBe('custom');
    expect(sectionKind(undefined)).toBe('栏目');

    expect(accessScope('metadata')).toBe('元数据');
    expect(accessScope('abstract')).toBe('摘要');
    expect(accessScope('full_text')).toBe('全文');
    expect(accessScope('dataset')).toBe('数据集');
    expect(accessScope('custom')).toBe('custom');
    expect(accessScope('')).toBeNull();
    expect(accessScope(undefined)).toBeNull();

    expect(personalState('current')).toEqual({ label: '已读取', tone: 'ok' });
    expect(personalState('empty')).toEqual({ label: '没有相关事项', tone: 'none' });
    expect(personalState('unavailable')).toEqual({ label: 'Todofy 没有可用回答', tone: 'warn' });
    expect(personalState('disabled')).toEqual({ label: '未启用', tone: 'none' });
    expect(personalState(undefined)).toEqual({ label: '无记录', tone: 'none' });

    expect(replicaTarget('editions')).toBe('简报库');
    expect(replicaTarget('materials')).toBe('材料库');
    expect(replicaTarget('custom')).toBe('custom');
    expect(replicaTarget(undefined)).toBe('全部');

    expect(sourceCode('ok')).toEqual({ label: '正常', tone: 'ok' });
    expect(sourceCode('timeout')).toEqual({ label: '超时', tone: 'bad' });
    expect(sourceCode('unsafe_address')).toEqual({ label: '地址不安全', tone: 'bad' });
    expect(sourceCode(undefined)).toEqual({ label: '无记录', tone: 'none' });

    expect(sourceKind('feed')).toBe('RSS');
    expect(sourceKind('arxiv')).toBe('arXiv');
    expect(sourceKind('crossref')).toBe('Crossref');
    expect(sourceKind('hf_daily')).toBe('HF 日报');
    expect(sourceKind('current_events')).toBe('参照');
    expect(sourceKind('custom')).toBe('custom');
    expect(sourceKind(undefined)).toBe('来源');

    expect(editorialLimit('max_public_items')).toBe('每期条目上限');
    expect(editorialLimit('other_limit')).toBe('other_limit');
    expect(
      editorialOrder([
        ['z_extra', 1],
        ['max_deep', 2],
        ['a_extra', 3],
        ['max_public_items', 4],
      ]),
    ).toEqual([
      ['max_public_items', 4],
      ['max_deep', 2],
      ['a_extra', 3],
      ['z_extra', 1],
    ]);

    expect(dropReason('history')).toBe('已见过');
    expect(dropReason('duplicate')).toBe('重复');
    expect(dropReason('research_cap')).toBe('研究名额已满');
    expect(dropReason('pool_cap')).toBe('候选池已满');
    expect(dropReason('custom')).toBe('custom');
    expect(dropReason(undefined)).toBe('原因未记录');

    expect(disposition('deep')).toBe('深读');
    expect(disposition('brief')).toBe('简讯');
    expect(disposition('watch')).toBe('观察');
    expect(disposition('deferred')).toBe('暂缓');
    expect(disposition('custom')).toBe('custom');
    expect(disposition('')).toBeNull();
    expect(disposition(undefined)).toBeNull();

    expect(leadStage('published', 'brief')).toEqual({ label: '已刊 · 简讯', tone: 'ok' });
    expect(leadStage('published')).toEqual({ label: '已刊', tone: 'ok' });
    expect(leadStage('selected', 'brief')).toEqual({ label: '入选未刊', tone: 'unknown' });
    expect(leadStage(undefined)).toEqual({ label: '无记录', tone: 'none' });

    expect(referenceStage('published')).toEqual({ label: '已刊', tone: 'ok' });
    expect(referenceStage('dropped')).toEqual({ label: '入池被丢', tone: 'warn' });
    expect(referenceStage(undefined)).toEqual({ label: '无记录', tone: 'none' });
    expect(REFERENCE_ORDER).toEqual([
      'published',
      'selected',
      'pooled',
      'dropped',
      'pending',
      'previous',
      'cut',
      'unseen',
      'uncertain',
    ]);
  });
});

describe('dates and numbers', () => {
  it('reads an issue date as the service calendar day, never shifted', () => {
    expect(issueDate('2026-10-28')).toBe('10月28日');
    expect(issueDate('2026-10-28', true)).toBe('10月28日 周三');
    expect(issueDate(undefined)).toBe('日期未记录');
    expect(stripDay('2026-10-29')).toEqual({ day: '29', weekday: '四' });
    expect(stripDay(undefined)).toEqual({ day: '?', weekday: '' });
    expect(stripDay('garbage')).toEqual({ day: '?', weekday: '' });
    expect(month('2026-10')).toBe('2026年10月');
    expect(month('garbage')).toBe('garbage');
    expect(month(undefined)).toBe('');
    expect(issueDate('garbage')).toBe('garbage');
  });

  it('formats timestamps, elapsed seconds, budget seconds, microUsd, ids and day spans', () => {
    expect(time(undefined)).toBe('未记录');
    expect(time('')).toBe('未记录');
    expect(time('not-a-date')).toBe('未记录');
    expect(time('2026-10-28T14:05:09Z')).toMatch(/\d{2}:\d{2}/);
    expect(time('2026-10-28T14:05:09Z', true)).toMatch(/\d+\/\d+\s+\d{2}:\d{2}/);
    expect(time('2026-10-28T14:05:09Z', false, true)).toMatch(/\d{2}:\d{2}:\d{2}/);

    expect(seconds('2026-10-28T14:00:00Z', '2026-10-28T14:02:30.500Z')).toBe(150.5);
    expect(seconds(undefined, '2026-10-28T14:02:30Z')).toBeUndefined();
    expect(seconds('2026-10-28T14:00:00Z', undefined)).toBeUndefined();
    expect(seconds('bad', '2026-10-28T14:02:30Z')).toBeUndefined();

    expect(wholeSeconds(161.25)).toBe('161 秒');
    expect(wholeSeconds(undefined)).toBe('未记录');
    expect(budgetSeconds(0.54)).toBe('0.5 秒');
    expect(budgetSeconds(161.2)).toBe('161 秒');

    expect(microUsd(undefined)).toBeNull();
    expect(microUsd(0)).toBe('$0.0000');
    expect(microUsd(5700)).toBe('$0.0057');
    expect(microUsd(10_000)).toBe('$0.01');
    expect(microUsd(123_456)).toBe('$0.12');

    expect(idOf('runs/00000000-0000-4000-8000-000000002800')).toBe('00000000-0000-4000-8000-000000002800');
    expect(idOf('plain')).toBe('plain');
    expect(idOf(undefined)).toBe('');

    expect(daysBetween('2026-10-24T10:00:00Z', '2026-10-29T15:00:00Z')).toBe(5);
    expect(daysBetween('2026-10-29T15:00:00Z', '2026-10-24T10:00:00Z')).toBe(0);
    expect(daysBetween(undefined, '2026-10-29T15:00:00Z')).toBeUndefined();
    expect(daysBetween('2026-10-24T10:00:00Z', 'bad')).toBeUndefined();
  });

  it('writes durations, counts and identities compactly', () => {
    expect(duration(0.4)).toBe('0.4 秒');
    expect(duration(58.6)).toBe('59 秒');
    expect(duration(88)).toBe('1 分 28 秒');
    expect(duration(120)).toBe('2 分');
    expect(duration(3600)).toBe('1 小时');
    expect(duration(5400)).toBe('1 小时 30 分');
    expect(duration(-1)).toBe('未记录');
    expect(duration(undefined)).toBe('未记录');
    expect(count(5400)).toBe('5,400');
    expect(count(10_000)).toBe('1 万');
    expect(count(218000)).toBe('21.8 万');
    expect(count(undefined)).toBe('未记录');
    expect(short('89abcdef0123456789abcdef0123456789abcdef')).toBe('89abcde');
    expect(short('packaged')).toBe('packaged');
    expect(short('')).toBe('未记录');
    expect(short(undefined)).toBe('未记录');
  });

  it('turns only http and https URLs into links, and validates httpsUrl and hostOf', () => {
    expect(webUrl('https://example.test/a')).toBe('https://example.test/a');
    expect(webUrl('http://example.test/b')).toBe('http://example.test/b');
    for (const value of ['javascript:alert(1)', 'data:text/html,x', 'notaurl', '', undefined]) {
      expect(webUrl(value)).toBeNull();
    }
    expect(httpsUrl('https://www.notion.so/page')).toBe('https://www.notion.so/page');
    expect(httpsUrl('http://www.notion.so/page')).toBeNull();
    expect(httpsUrl('javascript:alert(1)')).toBeNull();
    expect(httpsUrl(undefined)).toBeNull();

    expect(hostOf('https://sub.example.org:8443/path?a=1')).toBe('sub.example.org');
    expect(hostOf('http://example.org/a')).toBe('example.org');
    expect(hostOf('javascript:x')).toBeNull();
    expect(hostOf('notaurl')).toBeNull();
    expect(hostOf(undefined)).toBeNull();
  });
});

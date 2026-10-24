/** Synthetic reading-cadence cases for bounded Clef checks; no private mailbox content. */
export interface PriorityCase {
  readonly id: string;
  readonly expected: 'p1' | 'p2' | 'p3' | 'p4';
  readonly subject: string;
  readonly body: string;
  readonly receivedAt: number;
  readonly now: number;
}

export const PRIORITY_CASES: readonly PriorityCase[] = [
  {
    id: 'today-confirmation-en',
    expected: 'p1',
    subject: 'Please confirm the revised appointment by noon today',
    body: 'Your appointment moved to 14:00 today, October 21. Reply by 12:00 Pacific today to keep the slot; otherwise it will be released. Scheduling details are at appointments.example.org.',
    receivedAt: Date.parse('2026-10-21T09:40:00-07:00'),
    now: Date.parse('2026-10-21T10:00:00-07:00'),
  },
  {
    id: 'tomorrow-project-zh',
    expected: 'p1',
    subject: '明早提交前需要你确认最终版本',
    body: '我们明天（10月22日）上午九点提交项目材料。请今天下午五点前回复附件中的两个问题，你的确认是提交的必要条件。时间均为洛杉矶时间。',
    receivedAt: Date.parse('2026-10-21T09:15:00-07:00'),
    now: Date.parse('2026-10-21T10:00:00-07:00'),
  },
  {
    id: 'friday-monday-deadline-en',
    expected: 'p1',
    subject: 'Monday morning cutoff for your required submission',
    body: 'The completed form must arrive by Monday, October 26 at 09:00 Pacific. Submission is required to retain your reserved place. You still need to review and sign it; the office cannot extend this cutoff.',
    receivedAt: Date.parse('2026-10-23T16:30:00-07:00'),
    now: Date.parse('2026-10-23T17:00:00-07:00'),
  },
  {
    id: 'missing-deadline-zh',
    expected: 'p1',
    subject: '申请需要补充材料，截止时间请登录查看',
    body: '你的申请缺少一项必交材料，未补齐将无法继续办理。此通知没有列出缺少的材料或截止时间，请登录 portal.example.net 查看当前要求。',
    receivedAt: Date.parse('2026-10-21T09:50:00-07:00'),
    now: Date.parse('2026-10-21T10:00:00-07:00'),
  },
  {
    id: 'next-week-review-en',
    expected: 'p2',
    subject: 'Please review next week\'s planning document',
    body: 'Please add your comments to the planning document by Wednesday, October 28 at 17:00 Pacific. We will incorporate them on Thursday. There is no meeting or intermediate approval before that deadline.',
    receivedAt: Date.parse('2026-10-21T08:30:00-07:00'),
    now: Date.parse('2026-10-21T10:00:00-07:00'),
  },
  {
    id: 'friday-next-week-form-zh',
    expected: 'p2',
    subject: '请在下周五前确认下个月的排班',
    body: '下个月的排班草稿已准备好，请在10月30日周五下午五点前确认或提出修改。确认前不会安排任何班次，本周末及下周一都没有需要你参与的事项。时间为洛杉矶时间。',
    receivedAt: Date.parse('2026-10-23T16:00:00-07:00'),
    now: Date.parse('2026-10-23T17:00:00-07:00'),
  },
  {
    id: 'important-policy-review-en',
    expected: 'p2',
    subject: 'Review the new coverage terms before next month\'s selection',
    body: 'Your coverage options change on November 1. Please review the attached terms and select your option by October 30 at 17:00 Pacific. Your current coverage remains active through the end of October; no payment or response is due this week.',
    receivedAt: Date.parse('2026-10-21T09:00:00-07:00'),
    now: Date.parse('2026-10-21T10:00:00-07:00'),
  },
  {
    id: 'technical-reading-en',
    expected: 'p3',
    subject: 'A practical guide to debugging database query plans',
    body: 'This month\'s tutorial explains how to read query plans, with a worked example and exercises at learning.example.org. It is background reading for your interests, with no required assignment, registration or scheduled event.',
    receivedAt: Date.parse('2026-10-21T08:00:00-07:00'),
    now: Date.parse('2026-10-21T10:00:00-07:00'),
  },
  {
    id: 'longform-reading-zh',
    expected: 'p3',
    subject: '城市步行历史：本期长文与地图',
    body: '本期是一篇关于老城区街道演变的长文，附历史地图对照和参考书目。内容与你订阅的历史阅读主题有关，文章会长期保留，不需要回复或报名。全文在 history.example.net。',
    receivedAt: Date.parse('2026-10-21T07:45:00-07:00'),
    now: Date.parse('2026-10-21T10:00:00-07:00'),
  },
  {
    id: 'friday-reading-en',
    expected: 'p3',
    subject: 'The weekend essay: how public libraries choose books',
    body: 'A detailed interview about library acquisitions and local history collections, a topic you follow. Read whenever you have time; the article and audio remain available. There is no event, offer or requested response.',
    receivedAt: Date.parse('2026-10-23T16:45:00-07:00'),
    now: Date.parse('2026-10-23T17:00:00-07:00'),
  },
  {
    id: 'saturday-reading-zh',
    expected: 'p3',
    subject: '周末阅读：开源编译器的错误信息设计',
    body: '这是一篇与你学习编译器有关的深度文章，包含源码片段和设计讨论。周六或周日空闲时阅读即可，之后也能随时查阅。没有课程作业、截止日期或需要处理的请求。',
    receivedAt: Date.parse('2026-10-24T09:30:00-07:00'),
    now: Date.parse('2026-10-24T10:00:00-07:00'),
  },
  {
    id: 'routine-delivery-en',
    expected: 'p4',
    subject: 'Your parcel was delivered',
    body: 'The parcel was delivered to your designated parcel locker at 09:15 today. This is an automated receipt for your records. No response, payment or collection deadline is required.',
    receivedAt: Date.parse('2026-10-21T09:16:00-07:00'),
    now: Date.parse('2026-10-21T10:00:00-07:00'),
  },
  {
    id: 'optional-sale-countdown-zh',
    expected: 'p4',
    subject: '最后半小时：会员商城限时折扣',
    body: '任选笔记本享折扣，活动于今天上午10:30结束。仅为可选促销，没有订单、欠款或必须完成的操作。不购买不会影响任何现有服务。商城为 offers.example.org。',
    receivedAt: Date.parse('2026-10-21T09:55:00-07:00'),
    now: Date.parse('2026-10-21T10:00:00-07:00'),
  },
  {
    id: 'routine-build-fyi-en',
    expected: 'p4',
    subject: 'Automated build completed successfully',
    body: 'The scheduled documentation build completed successfully. This notification is for information only. No errors, deployment approval or follow-up action were reported.',
    receivedAt: Date.parse('2026-10-21T09:20:00-07:00'),
    now: Date.parse('2026-10-21T10:00:00-07:00'),
  },
  {
    id: 'expired-optional-event-zh',
    expected: 'p4',
    subject: '10月10日线上公开讲座邀请',
    body: '欢迎自愿报名10月10日下午两点的公开讲座，报名于当日中午截止。没有报名义务、费用、作业或后续事项，讲座不提供回放。此活动已经结束。',
    receivedAt: Date.parse('2026-10-05T09:00:00-07:00'),
    now: Date.parse('2026-10-21T10:00:00-07:00'),
  },
  {
    id: 'stale-unresolved-obligation-en',
    expected: 'p1',
    subject: 'Your required payment is overdue and remains unresolved',
    body: 'The payment was due October 20 at 17:00 Pacific and has not been received. The obligation remains active. Please arrange payment now to prevent further late fees; the account will be restricted tomorrow if it remains unpaid.',
    receivedAt: Date.parse('2026-10-20T18:00:00-07:00'),
    now: Date.parse('2026-10-21T10:00:00-07:00'),
  },
];

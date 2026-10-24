/** The owner's fixed Gmail priorities, in their daily reading order. */
export const PRIORITIES = [
  { id: 'p1', title: 'P1', policy: '现在处理或拿不准 · 留在收件箱', description: '需要尽快处理的邮件，以及模型拿不准优先级的邮件。打上 P1 标签并留在收件箱。' },
  { id: 'p2', title: 'P2', policy: '2–3 天内处理 · 自动归档', description: '有重要信息或需要后续处理，但可以安全等两三天再看。打上 P2 标签并移出收件箱。' },
  { id: 'p3', title: 'P3', policy: '周末阅读 · 自动归档', description: '值得集中阅读的长文、教程、分析或订阅内容，没有必须完成的事务；周五和周末也按自选阅读判断。打上 P3 标签并移出收件箱。' },
  { id: 'p4', title: 'P4', policy: '低价值或仅供参考 · 自动归档', description: '普通通知、成功确认、回执或促销，没有重要跟进或实质阅读内容。可选优惠的倒计时不会使它变紧急。打上 P4 标签并移出收件箱。' },
] as const

/** The owner's fixed Gmail priorities, in their daily reading order. */
export const PRIORITIES = [
  { id: 'p1', title: 'P1', policy: '现在处理或拿不准 · 留在收件箱', description: '需要尽快处理的邮件，以及模型拿不准优先级的邮件。打上 P1 标签并留在收件箱。' },
  { id: 'p2', title: 'P2', policy: '2–3 天内处理 · 自动归档', description: '需要在 2–3 天内处理的邮件。打上 P2 标签并移出收件箱，之后从 P2 查看。' },
  { id: 'p3', title: 'P3', policy: '周末处理 · 自动归档', description: '可以等到周末集中处理的邮件。打上 P3 标签并移出收件箱，之后从 P3 查看。' },
  { id: 'p4', title: 'P4', policy: '低价值或仅供参考 · 自动归档', description: '低价值、无需处理或仅供参考的邮件。打上 P4 标签并移出收件箱，之后从 P4 查看。' },
] as const

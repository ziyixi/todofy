/** The four Gmail queues; the prompt editor holds the current personal exceptions. */
export const PRIORITIES = [
  { id: 'p1', title: 'P1', policy: '下次看收件箱就应看到 · 留在收件箱', description: '需要及时查看的邮件，例如即将发生的既定安排、有时限的必要回复，或个人规则指定当天阅读的内容。紧张措辞、信息不全或模型拿不准，本身不足以选择 P1。打上 P1 标签并留在收件箱。' },
  { id: 'p2', title: 'P2', policy: '两三天内值得看 · 自动归档', description: '值得回复的真人联系、职业机会、需要跟进的问题或已安排事项的实质变化，可以等两三天再看。打上 P2 标签并移出收件箱。' },
  { id: 'p3', title: 'P3', policy: '周末集中看 · 自动归档', description: '与个人生活或账户有关、值得定期核对的汇总和报告，以及为本人整理或有明确兴趣线索的阅读内容。通用行业资讯、专业主题或长篇幅本身不足以加入阅读队列。打上 P3 标签并移出收件箱。' },
  { id: 'p4', title: 'P4', policy: '保留备查 · 自动归档', description: '无需主动阅读的促销、产品功能推广、泛化教程和没有后续事项的自动技术状态。可选优惠倒计时不构成义务；个人规则可另行指定需要查看的内容。打上 P4 标签并移出收件箱。' },
] as const

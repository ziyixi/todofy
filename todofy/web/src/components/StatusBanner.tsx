import { CirclePause, Coins, Wrench } from 'lucide-react'
import type { ReactNode } from 'react'
import type { ServiceStatus } from '../api/types'

export type NoticeKind = 'maintenance' | 'processing_paused' | 'todoist_paused' | 'gemini_budget'

export interface Notice {
  kind: NoticeKind
  title: string
  consequence: string
}

/** The four abnormal states, each with one sentence on what it means for incoming mail. */
export function bannerNotices(overview: ServiceStatus): Notice[] {
  const notices: Notice[] = []
  const { switches, gemini } = overview
  if (switches?.maintenanceMode) {
    notices.push({
      kind: 'maintenance',
      title: '维护模式',
      consequence: 'Mail Hero 的投递会收到 503 并稍后重投，后台处理已停止，页面上的操作暂不可用。',
    })
  }
  if (switches?.processingPaused) {
    notices.push({
      kind: 'processing_paused',
      title: '处理已暂停',
      consequence: '新邮件照常入账，但不会生成摘要、建任务或发每日提醒；日报仍按时计算。恢复后按到达顺序继续。',
    })
  }
  if (switches?.forcePauseTodoist) {
    notices.push({
      kind: 'todoist_paused',
      title: '任务写入已暂停',
      consequence: '摘要照常生成；提醒、回顾、快照和任务意图暂停写入 Tasks，解除后恢复。',
    })
  }
  if (gemini && gemini.tokenBudget > 0 && gemini.usedTokens + gemini.reservedTokens >= gemini.tokenBudget) {
    notices.push({
      kind: 'gemini_budget',
      title: '今日 Gemini 预算已用完',
      consequence: '新的摘要推迟到 UTC 次日预算恢复后继续，事件不会丢弃。',
    })
  }
  return notices
}

const ICONS: Record<NoticeKind, ReactNode> = {
  maintenance: <Wrench size={18} aria-hidden="true" />,
  processing_paused: <CirclePause size={18} aria-hidden="true" />,
  todoist_paused: <CirclePause size={18} aria-hidden="true" />,
  gemini_budget: <Coins size={18} aria-hidden="true" />,
}

const SEVERE = new Set<NoticeKind>(['maintenance'])

export function StatusBanner({ overview }: { overview: ServiceStatus | undefined }) {
  if (!overview) return null
  const notices = bannerNotices(overview)
  if (notices.length === 0) return null
  return (
    <div className="status-banner" role="status" aria-label="运行异常">
      {notices.map((notice) => (
        <p key={notice.kind} className={`notice tone-${SEVERE.has(notice.kind) ? 'danger' : 'warn'}`}>
          {ICONS[notice.kind]}
          <span>
            <strong>{notice.title}</strong>
            {notice.consequence}
          </span>
        </p>
      ))}
    </div>
  )
}

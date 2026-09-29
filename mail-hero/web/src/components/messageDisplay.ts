import type { MessageSummary } from '../api/types'

const parseNotices = {
  pending: {
    subject: '（主题待解析）', sender: '发件人待解析', title: '正文尚未解析',
    detail: '原件已保存，正在等待后台解析。自动投递需等待解析成功。',
  },
  parsing: {
    subject: '（正在解析主题）', sender: '正在解析发件人', title: '正在提取正文',
    detail: '后台正在提取邮件内容。自动投递需等待解析成功。',
  },
  failed: {
    subject: '（主题解析未完成）', sender: '发件人解析未完成', title: '正文解析未完成',
    detail: '邮件解析失败，请查看详情中的错误信息。自动投递需等待解析成功。',
  },
}

export function messageParseNotice(message: MessageSummary) {
  return message.content_deleted_at || message.parse_state === 'ready' ? null : parseNotices[message.parse_state]
}

export function messageSubject(message: MessageSummary): string {
  return message.subject || messageParseNotice(message)?.subject || '（无主题）'
}

export function messageSender(message: MessageSummary): string {
  return message.from || messageParseNotice(message)?.sender || '未知发件人'
}

/** The selected classifier's status, shared by settings and overview. */
import { ClassificationProvider, type ServiceStatus } from '@ziyixi/proto/mailsort/ui/v2/status_pb'
import { el } from '../dom.ts'
import { classificationProvider, classificationProviderName, classifierErrorMessage, relative, when } from '../format.ts'

export function classifierDetails(status: ServiceStatus | null, now: number, selected = classificationProvider(status?.classifier?.provider)): HTMLElement {
  const current = status?.classifier
  const classifier = current !== undefined && classificationProvider(current.provider) === selected ? current : undefined
  const legacy = selected === ClassificationProvider.CLAUDE && current === undefined ? status?.claudeBudget : undefined
  const model = classifier?.model || legacy?.model || (selected === ClassificationProvider.CLAUDE && current === undefined ? status?.decisionModel : undefined) || '模型未提供'
  const effort = classifier?.effort || legacy?.effort || 'effort 未提供'
  const error = classifier?.lastErrorCode ?? legacy?.lastErrorCode ?? ''
  const next = classifier?.nextBatchTime ?? legacy?.nextBatchTime
  return el(
    'div',
    {},
    el('p', { class: 'hint' }, `${classificationProviderName(selected)} · ${model} · ${effort}`),
    el('p', { class: classifier?.configured === false ? 'hint warn' : 'hint' }, classifier === undefined ? '配置状态未提供，请刷新或等待服务更新。' : classifier.configured ? '已配置' : '尚未配置，下一批无法分类'),
    selected === ClassificationProvider.CODEX ? el('p', { class: 'hint' }, '使用 Codex 订阅额度，不计入 Claude API 月费用。') : null,
    el('p', { class: 'hint' }, next === undefined ? '下批判断时间尚未提供' : `下批判断最早在 ${relative(next, now)}（${when(next)}）。日常新邮件自动分类通常约每小时一批。`),
    classifier?.lastSuccessTime === undefined ? null : el('p', { class: 'meta' }, `最近成功 ${when(classifier.lastSuccessTime)}`),
    error === '' ? null : el('p', { class: 'hint warn' }, `最近一次请求：${classifierErrorMessage(selected, error)}`),
  )
}

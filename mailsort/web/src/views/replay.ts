/** Read-only results from the retired model evaluation. */
import type { Label } from '@ziyixi/proto/mailsort/ui/v2/label_pb'
import { ReplayEvaluation_State, type ReplayEvaluation } from '@ziyixi/proto/mailsort/ui/v2/replay_pb'
import { ApiError, api, errorMessage } from '../api.ts'
import { card, kpi, meter } from '../components.ts'
import { button, el, fill } from '../dom.ts'
import { labelText, when } from '../format.ts'

function results(replay: ReplayEvaluation, labels: readonly Label[]): HTMLElement[] {
  const processed = replay.evaluatedCount + replay.skippedCount
  const matched = replay.autoMatchCount + replay.noLabelMatchCount
  const mismatchCount = replay.autoCount + replay.noLabelCount - matched
  const running = replay.state === ReplayEvaluation_State.RUNNING
  const line = replay.totalCount === 0
    ? '历史检查没有已确认样本'
    : `${running ? '旧检查未完成，已停止' : '已完成'}：${String(processed)} / ${String(replay.totalCount)} 封`
  return [
    el('p', { class: 'hint', role: 'status' }, line),
    ...(replay.totalCount === 0 ? [] : [
      meter(processed, replay.totalCount, '回放进度'),
      el('div', { class: 'kpis replay-counts' }, kpi('样本', replay.totalCount), kpi('已判断', replay.evaluatedCount), kpi('与回答一致', matched), kpi('不一致', mismatchCount), kpi('拿不准', replay.unsureCount), kpi('无法读取', replay.skippedCount)),
      el('p', { class: 'hint' }, '一致与不一致只统计有把握的判断；拿不准和无法读取单独列出。'),
    ]),
    ...(replay.mismatches.length === 0 ? [] : [el('ul', { class: 'replay-mismatches', 'aria-label': '不一致的分级' }, ...replay.mismatches.map((item) => el('li', {}, `${labelText(item.decidedLabel, labels)} → 你的回答：${labelText(item.ownerLabel, labels)}（${String(item.mailCount)} 封）`)))]),
    (replay.reasonCounts['model_unavailable'] ?? 0) > 0 ? el('p', { class: 'hint warn' }, `${String(replay.reasonCounts['model_unavailable'])} 封因模型未能回答而记为拿不准`) : null,
    el('p', { class: 'meta' }, `开始 ${when(replay.createTime)}${replay.completeTime === undefined ? '' : ` · 完成 ${when(replay.completeTime)}`}`),
  ].filter((node): node is HTMLElement => node !== null)
}

export async function replayCard(labels: readonly Label[]): Promise<HTMLElement> {
  const box = card('历史效果检查', '', el('p', { class: 'hint' }, '这是旧模型的检查结果，不代表当前 Claude 的效果。当前分级只用固定提示词，不再学习例子或运行旧回放。'))
  const content = el('div', { class: 'replay-results' })
  const feedback = el('p', { class: 'hint warn', role: 'status', hidden: true })
  const refresh = button('刷新历史记录', () => void load())
  let busy = false

  const load = async () => {
    if (busy) return
    busy = true
    refresh.disabled = true
    feedback.hidden = true
    try {
      const replay = await api.getReplayEvaluation({ name: 'replayEvaluation' }).catch((error: unknown) => {
        if (error instanceof ApiError && error.reason === 'NOT_FOUND') return null
        throw error
      })
      fill(content, ...(replay === null ? [el('p', { class: 'hint' }, '没有历史检查记录')] : results(replay, labels)))
    } catch (error) {
      content.replaceChildren()
      feedback.textContent = errorMessage(error)
      feedback.hidden = false
    }
    busy = false
    refresh.disabled = false
  }

  box.append(content, feedback, el('div', { class: 'actions' }, refresh))
  await load()
  return box
}

/**
 * 准确率 (`/accuracy`): per label, the confirmations and corrections, the precision's Wilson 95 % lower bound against the
 * target (a live label falls back to suggestions when its bound drops below it), and the last week's decisions.
 */
import { api } from '../api.ts'
import { el, fill } from '../dom.ts'
import { labelText, percent } from '../format.ts'
import type { ViewContext } from '../app.ts'
import { allLabels, frame } from './common.ts'

export async function renderAccuracy(ctx: ViewContext): Promise<void> {
  await frame(ctx.main, '准确率', async (body) => {
    const [report, labels] = await Promise.all([api.getAccuracyReport({ name: 'accuracyReport' }), allLabels()])
    const rows = report.labels.map((row) => {
      const live = labels.find((label) => label.name === row.label)?.live === true
      const ready = row.precisionLowerBound >= report.precisionTarget
      return el(
        'tr',
        {},
        el('th', { scope: 'row' }, labelText(row.label, labels), live ? el('span', { class: 'chip ok' }, '正式') : null),
        el('td', {}, String(row.confirmedCount)),
        el('td', {}, String(row.correctedCount)),
        el('td', { class: ready ? 'ok' : 'warn' }, percent(row.precisionLowerBound)),
        el('td', {}, `${String(row.appliedCount)}/${String(row.decidedCount)}`),
      )
    })
    fill(
      body,
      el('p', { class: 'hint' }, `近 7 天判断 ${String(report.decidedCount)} 封，拿不准 ${String(report.unsureCount)} 封，覆盖率 ${percent(report.coverage)}。精确率下界达到 ${percent(report.precisionTarget)} 的标签适合打开“正式打”。`),
      el(
        'table',
        { class: 'table' },
        el('thead', {}, el('tr', {}, el('th', {}, '标签'), el('th', {}, '确认'), el('th', {}, '纠正'), el('th', {}, '精确率下界'), el('th', {}, '已打/判断（7 天）'))),
        el('tbody', {}, ...rows),
      ),
    )
  })
}

/**
 * 流程 (`/flow`): how mail moved through the pipeline over today, the last 7 or the last 30 UTC days (GetMailFlow): the
 * Sankey diagram (flowchart.ts), then a table per label with a bar of its written mail: how many were written, by a
 * rule or by the model, kept in the inbox or archived, only suggested, and later corrected. A label's name opens its
 * 操作记录.
 */
import { api } from '../api.ts'
import { button, el, fill } from '../dom.ts'
import { flowGraph, sankeyChart, share, type FlowGraph } from '../flowchart.ts'
import type { ViewContext } from '../app.ts'
import { allLabels, frame } from './common.ts'

export const RANGES: readonly (readonly [string, string])[] = [
  ['today', '今天'],
  ['last-7-days', '7 天'],
  ['last-30-days', '30 天'],
]

/** The 操作记录 of one label (the ledger's label filter). */
export function ledgerPath(label: string): string {
  return `/ledger?label=${encodeURIComponent(label)}`
}

function breakdownTable(graph: FlowGraph, go: (path: string) => void): HTMLElement {
  if (graph.breakdown.length === 0) return el('p', { class: 'empty' }, '这段时间没有打上或建议任何标签。')
  const most = Math.max(1, ...graph.breakdown.map((row) => row.written + row.suggested))
  const head = el('tr', {}, ...['标签', '合计', '规则', '模型', '留在收件箱', '归档', '仅建议', '被纠正'].map((name) => el('th', { scope: 'col' }, name)))
  const body = graph.breakdown.map((row) => {
    const link = el('a', { href: ledgerPath(row.label) }, row.name)
    link.addEventListener('click', (event) => {
      event.preventDefault()
      go(ledgerPath(row.label))
    })
    const bar = el('span', { class: 'flow-bar', 'aria-hidden': 'true' })
    bar.style.width = `${String(Math.round(((row.written + row.suggested) / most) * 100))}%`
    bar.style.background = row.slot === 0 ? 'var(--muted)' : `var(--series-${String(row.slot)})`
    const total = row.written + row.suggested
    return el(
      'tr',
      {},
      el('th', { scope: 'row' }, link, el('span', { class: 'flow-bar-track' }, bar)),
      el('td', {}, `${String(total)}`, el('span', { class: 'muted' }, ` ${share(total, graph.total)}`)),
      el('td', {}, String(row.byRule)),
      el('td', {}, String(row.byModel)),
      el('td', {}, String(row.kept)),
      el('td', {}, String(row.archived)),
      el('td', {}, String(row.suggested)),
      el('td', { class: row.corrected > 0 ? 'warn' : '' }, String(row.corrected)),
    )
  })
  return el('div', { class: 'table-scroll' }, el('table', { class: 'flow-table' }, el('thead', {}, head), el('tbody', {}, ...body)))
}

export async function renderFlow(ctx: ViewContext): Promise<void> {
  let range = new URLSearchParams(window.location.search).get('range') ?? 'today'
  if (!RANGES.some(([id]) => id === range)) range = 'today'
  const reload: () => Promise<void> = await frame(ctx.main, '流程', async (body) => {
    const [flow, labels] = await Promise.all([api.getMailFlow({ name: `mailFlows/${range}` }), allLabels()])
    const graph = flowGraph(flow.counts, labels)
    const picker = el(
      'div',
      { class: 'row', role: 'group', 'aria-label': '时间范围' },
      ...RANGES.map(([id, name]) =>
        button(
          name,
          () => {
            range = id
            window.history.replaceState(null, '', `/flow?range=${id}`)
            void reload()
          },
          { class: 'small', 'aria-pressed': id === range ? 'true' : 'false' },
        ),
      ),
    )
    fill(
      body,
      picker,
      el('p', { class: 'hint' }, `共 ${String(graph.total)} 封（按 UTC 日计）。线的粗细是邮件数；悬停或聚焦看具体数字，点标签看它的操作记录。延后的邮件之后判断时会再计入一次。`),
      sankeyChart(graph, { onLabel: (label) => ctx.go(ledgerPath(label)) }),
      el('h2', {}, '按标签'),
      breakdownTable(graph, ctx.go),
    )
  })
}

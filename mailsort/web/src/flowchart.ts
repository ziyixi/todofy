/** The mail flow as a Sankey chart, with fixed P1-P4 outcomes and readable historical counters. */
import { sankey, sankeyLeft, sankeyLinkHorizontal, type SankeyLink, type SankeyNode } from 'd3-sankey'
import { MailFlow_Outcome, MailFlow_Stage, type MailFlow_Count } from '@ziyixi/proto/mailsort/ui/v2/flow_pb'
import type { Label } from '@ziyixi/proto/mailsort/ui/v2/label_pb'
import { ClassificationProvider } from '@ziyixi/proto/mailsort/ui/v2/status_pb'
import { el } from './dom.ts'
import { PRIORITIES } from './priorities.ts'

/** The categorical slots of styles.css (--series-1 to --series-8). */
const SERIES = 8

export type NodeKind = 'source' | 'stage' | 'terminal' | 'label' | 'none' | 'unsure' | 'suggested'

export interface FlowNodeData {
  readonly id: string
  readonly name: string
  readonly kind: NodeKind
  /** The color slot (1-8), 0 for gray. */
  readonly slot: number
  /** The full label name used by the legend. */
  readonly group?: string
  /** Extra lines for the tooltip (the skip reasons, what an outcome means). */
  readonly detail?: readonly string[]
}

export interface FlowLinkData {
  readonly source: string
  readonly target: string
  readonly value: number
}

export interface FlowGraph {
  /** Mails that entered the pipeline (corrections are not mails). */
  readonly total: number
  readonly nodes: readonly FlowNodeData[]
  readonly links: readonly FlowLinkData[]
  /** Labels in color order, for the legend. */
  readonly groups: readonly { readonly name: string; readonly slot: number }[]
}

const STAGES: readonly (readonly [MailFlow_Stage, string, string])[] = [
  [MailFlow_Stage.SKIPPED, 'skipped', '跳过'],
  [MailFlow_Stage.CLAUDE, 'claude', 'Claude Opus 5.5'],
  [MailFlow_Stage.CODEX, 'codex', 'VPS Codex'],
  [MailFlow_Stage.CLEF, 'clef', '历史 Clef 27B'],
  [MailFlow_Stage.CLEF_FLASH, 'clef-flash', '历史 Clef-flash'],
  [MailFlow_Stage.NO_MODEL, 'no_model', '历史未调用模型'],
  [MailFlow_Stage.DEFERRED, 'deferred', '等待判断'],
]

const SKIP_REASONS: Readonly<Record<number, string>> = {
  [MailFlow_Outcome.NOT_INBOX]: '已发送、草稿或垃圾邮件',
  [MailFlow_Outcome.THREAD_SORTED]: '对话已分拣',
  [MailFlow_Outcome.BEFORE_INSTALL]: '安装前的历史邮件',
  [MailFlow_Outcome.UNREADABLE]: '无法读取',
}

/** The outcomes without a label, in the diagram's order (under the labels). */
const OUTCOMES: readonly FlowNodeData[] = [
  { id: 'none', name: '旧记录：未分级', kind: 'none', slot: 0, detail: ['旧分类流程中未分到标签的邮件，留在收件箱'] },
  { id: 'unsure_shown', name: '旧记录：待确认', kind: 'unsure', slot: 0, detail: ['旧分类流程留下的确认记录，邮件留在收件箱'] },
  { id: 'unsure', name: '旧记录：未确认', kind: 'unsure', slot: 0, detail: ['旧分类流程中尚未确认的邮件，留在收件箱'] },
  { id: 'suggested', name: '影子建议（未写入）', kind: 'suggested', slot: 0, detail: ['分级仅作记录：影子模式，或未完成 Gmail 写入'] },
]

/**
 * The color slot of every label (1 to SERIES, 0 for gray), so that a group keeps its color whatever the range
 * shows and gray is left for real overflow:
 * - each group has a home slot in the labels' order, enabled labels' groups first (a store can have ten groups or
 *   more, so a disabled group should not take a hue from one that sorts mail); the first SERIES groups keep their home
 *   slot in every range, so a range or filter never repaints them;
 * - a group past the palette that the range shows borrows the first slot whose home group the range does not show
 *   (in the labels' order), so with at most SERIES groups in a range none is gray;
 * - only when the range shows more than SERIES groups do the later ones go gray (the legend says so).
 */
export function groupSlots(labels: readonly Label[], shown: ReadonlySet<string>): Map<string, number> {
  const order: string[] = []
  for (const label of [...labels.filter((item) => item.enabled), ...labels.filter((item) => !item.enabled)]) {
    const group = label.displayName
    if (!order.includes(group)) order.push(group)
  }
  const slots = new Map<string, number>()
  order.forEach((group, index) => slots.set(group, index < SERIES ? index + 1 : 0))
  // Slots free in this range: their home group shows nothing here.
  const free = order.slice(0, SERIES).flatMap((group, index) => (shown.has(group) ? [] : [index + 1]))
  for (const group of order.slice(SERIES)) if (shown.has(group)) slots.set(group, free.shift() ?? 0)
  return slots
}

/** The graph of one MailFlow's counters (corrections are not mails, so not in it). `labels` give names, order and groups. */
export function flowGraph(counts: readonly MailFlow_Count[], labels: readonly Label[]): FlowGraph {
  const byName = new Map(labels.map((label) => [label.name, label]))
  const nameOf = (label: string) => byName.get(label)?.displayName ?? '历史分级'
  const groupOf = (label: string) => byName.get(label)?.displayName ?? ''
  // Filled in once the counters are read (groupSlots below).
  let groupSlot = new Map<string, number>()
  const slotOf = (label: string) => groupSlot.get(groupOf(label)) ?? 0

  const links = new Map<string, number>()
  const add = (source: string, target: string, value: number) => {
    const key = `${source}\u0000${target}`
    links.set(key, (links.get(key) ?? 0) + value)
  }
  const skipped = new Map<string, number>()
  let total = 0
  for (const count of counts) {
    const n = count.mailCount
    if (n <= 0) continue
    const stage = STAGES.find(([value]) => value === count.stage)?.[1]
    if (stage === undefined) continue
    if (count.outcome === MailFlow_Outcome.CORRECTED) continue
    total += n
    add('new', stage, n)
    if (stage === 'skipped') {
      const reason = SKIP_REASONS[count.outcome] ?? '其他'
      skipped.set(reason, (skipped.get(reason) ?? 0) + n)
      continue
    }
    if (stage === 'deferred') continue
    if (count.outcome === MailFlow_Outcome.ARCHIVED || count.outcome === MailFlow_Outcome.KEPT_IN_INBOX) {
      add(stage, `label:${count.label}`, n)
    } else if (count.outcome === MailFlow_Outcome.SUGGESTED) {
      add(stage, 'suggested', n)
    } else if (count.outcome === MailFlow_Outcome.UNSURE_SHOWN) {
      add(stage, 'unsure_shown', n)
    } else if (count.outcome === MailFlow_Outcome.UNSURE) {
      add(stage, 'unsure', n)
    } else if (count.outcome === MailFlow_Outcome.NO_LABEL) {
      add(stage, 'none', n)
    }
  }

  const used = new Set([...links.keys()].flatMap((key) => key.split('\u0000')))
  const shownGroups = new Set([...used].filter((id) => id.startsWith('label:')).map((id) => groupOf(id.slice('label:'.length))))
  groupSlot = groupSlots(labels, shownGroups)
  const nodes: FlowNodeData[] = []
  if (used.has('new')) nodes.push({ id: 'new', name: '新邮件', kind: 'source', slot: 0 })
  for (const [, id, name] of STAGES) {
    if (!used.has(id)) continue
    const terminal = id === 'skipped' || id === 'deferred'
    nodes.push({
      id,
      name,
      kind: terminal ? 'terminal' : 'stage',
      slot: 0,
      ...(id === 'skipped' ? { detail: [...skipped].map(([reason, n]) => `${reason} ${String(n)}`) } : {}),
      ...(id === 'deferred' ? { detail: ['等待模型批次、额度恢复或重试；成功判断后计入模型步骤'] } : {}),
    })
  }
  // Label nodes in the labels' order (deleted labels last), then the outcomes without a label.
  const order = (label: string) => {
    const index = labels.findIndex((item) => item.name === label)
    return index < 0 ? labels.length : index
  }
  const labelIds = [...used].filter((id) => id.startsWith('label:')).map((id) => id.slice('label:'.length))
  labelIds.sort((a, b) => order(a) - order(b) || (a < b ? -1 : 1))
  for (const label of labelIds) nodes.push({ id: `label:${label}`, name: nameOf(label), kind: 'label', slot: slotOf(label), group: groupOf(label), detail: [PRIORITIES.find((priority) => label === `labels/${priority.id}`)?.policy ?? '历史分级记录'] })
  for (const node of OUTCOMES) if (used.has(node.id)) nodes.push(node)

  // In color order (home slots first), the legend's order.
  const groups = [...groupSlot.entries()].map(([name, slot]) => ({ name, slot }))
  return {
    total,
    nodes,
    links: [...links.entries()].map(([key, value]) => {
      const [source = '', target = ''] = key.split('\u0000')
      return { source, target, value }
    }),
    groups,
  }
}

/** An empty day still shows the four priorities, with zero counts. */
export function skeletonGraph(provider: ClassificationProvider = ClassificationProvider.CLAUDE): FlowGraph {
  const model = provider === ClassificationProvider.CODEX ? 'codex' : 'claude'
  const currentStages = STAGES.filter(([, id]) => id === 'skipped' || id === model || id === 'deferred')
  const stage = ([, id, name]: (typeof STAGES)[number]): FlowNodeData => ({ id, name, kind: id === 'skipped' || id === 'deferred' ? 'terminal' : 'stage', slot: 0 })
  const ranks: FlowNodeData[] = PRIORITIES.map((priority, index) => ({ id: `label:labels/${priority.id}`, name: priority.title, kind: 'label', slot: index + 1, group: priority.title, detail: [priority.policy] }))
  return {
    total: 0,
    nodes: [{ id: 'new', name: '新邮件', kind: 'source', slot: 0 }, ...currentStages.map(stage), ...ranks, ...OUTCOMES.filter((node) => node.id === 'suggested')],
    links: [
      ...currentStages.map(([, id]) => ({ source: 'new', target: id, value: 0 })),
      ...ranks.map((rank) => ({ source: model, target: rank.id, value: 0 })),
      { source: model, target: 'suggested', value: 0 },
    ],
    groups: PRIORITIES.map((priority, index) => ({ name: priority.title, slot: index + 1 })),
  }
}

const SVG = 'http://www.w3.org/2000/svg'

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attributes: Readonly<Record<string, string | number>> = {}, text?: string): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG, tag)
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value))
  if (text !== undefined) node.textContent = text
  return node
}

/** The share of `n` in `total`, `12%` (or `<1%`). */
export function share(n: number, total: number): string {
  if (total <= 0) return '0%'
  const percent = (n / total) * 100
  return percent > 0 && percent < 1 ? '<1%' : `${String(Math.round(percent))}%`
}

/** `value` within [min, max]; min when the range is empty (a tip wider than its box). */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max))
}

/** A node's fill: its group's slot, the neutral ink for the pipeline's own nodes. */
function fillOf(node: FlowNodeData): string {
  if (node.kind === 'label') return node.slot === 0 ? 'var(--muted)' : `var(--series-${String(node.slot)})`
  if (node.kind === 'unsure') return 'var(--warn)'
  return 'var(--flow-node)'
}

type Node = SankeyNode<FlowNodeData, FlowLinkData>
type Link = SankeyLink<FlowNodeData, FlowLinkData>

/**
 * The diagram of `graph`: an SVG in a horizontally scrollable box, with its tooltip. A graph without mail is drawn as
 * the skeleton (skeletonGraph): laid out as if each path carried one mail, then drawn with hairline links, muted
 * nodes and every count 0.
 */
export function sankeyChart(graph: FlowGraph, provider: ClassificationProvider = ClassificationProvider.CLAUDE): HTMLElement {
  const zero = graph.total === 0
  const drawn = zero ? skeletonGraph(provider) : graph
  const box = el('div', { class: 'flow-chart' })
  const scroll = el('div', { class: 'flow-scroll' })
  const tip = el('div', { class: 'flow-tip', role: 'status', hidden: true })
  box.append(scroll, tip)
  // The drawing's own coordinates: wide enough for three columns and their names. The SVG has no fixed size and
  // scales to its box (styles.css .flow-svg); below its minimum width, on a phone, the box scrolls sideways instead.
  const width = 720
  const rightNodes = drawn.nodes.filter((node) => node.kind === 'label' || node.kind === 'none' || node.kind === 'unsure' || node.kind === 'suggested').length
  // Each right-hand node gets room for its name even at one mail (12 px text, at least 14 px apart).
  const height = Math.max(260, 30 * rightNodes + 60)
  const margin = { left: 6, right: 170, top: 8, bottom: 8 }
  const layout = sankey<FlowNodeData, FlowLinkData>()
    .nodeId((node) => node.id)
    .nodeAlign(sankeyLeft)
    .nodeWidth(10)
    .nodePadding(16)
    // Keep the given order (stages, then labels by the labels' order) instead of d3's own.
    .nodeSort((a, b) => drawn.nodes.findIndex((node) => node.id === a.id) - drawn.nodes.findIndex((node) => node.id === b.id))
    .extent([
      [margin.left, margin.top],
      [width - margin.right, height - margin.bottom],
    ])
  const { nodes, links } = layout({ nodes: drawn.nodes.map((node) => ({ ...node })), links: drawn.links.map((link) => ({ ...link, value: zero ? 1 : link.value })) })

  // role=group, not img: an image's children are presentational, and the nodes are focusable images that a screen
  // reader must be able to reach.
  const title = zero ? '邮件流程：还没有邮件' : `邮件流程：共 ${String(graph.total)} 封`
  const chart = svg('svg', { viewBox: `0 0 ${String(width)} ${String(height)}`, preserveAspectRatio: 'xMinYMin meet', class: 'flow-svg', role: 'group', 'aria-label': title })
  chart.append(svg('title', {}, title))
  const show = (text: readonly string[], event?: { clientX: number; clientY: number }) => {
    tip.replaceChildren(...text.map((line, index) => (index === 0 ? el('strong', {}, line) : el('span', {}, line))))
    tip.hidden = false
    if (event !== undefined) {
      // Kept inside the chart's box by the tip's measured size (it grows to 16rem), flipped above the pointer near
      // the bottom: a tip past the box's edge would make a phone's page scroll sideways.
      const area = box.getBoundingClientRect()
      const x = event.clientX - area.left + 12
      const y = event.clientY - area.top + 12
      tip.style.left = `${String(clamp(x, 0, area.width - tip.offsetWidth))}px`
      tip.style.top = `${String(y + tip.offsetHeight > area.height ? Math.max(0, y - 24 - tip.offsetHeight) : y)}px`
    } else {
      tip.style.left = '0px'
      tip.style.top = '0px'
    }
  }
  const hide = () => {
    tip.hidden = true
  }
  const hover = (target: SVGElement, lines: readonly string[]) => {
    target.addEventListener('pointerenter', (event) => {
      show(lines, event)
    })
    target.addEventListener('pointermove', (event) => {
      show(lines, event)
    })
    target.addEventListener('pointerleave', hide)
  }
  const amount = (value: number) => (zero ? '0 封' : `${String(value)} 封 · 占全部 ${share(value, graph.total)}`)
  const nodeOf = (end: Link['source']) => end as Node
  const linkGroup = svg('g', { class: 'flow-links', fill: 'none' })
  const path = sankeyLinkHorizontal<FlowNodeData, FlowLinkData>()
  for (const link of links) {
    const source = nodeOf(link.source)
    const target = nodeOf(link.target)
    const d = path(link) ?? ''
    const stroke = zero ? 'var(--flow-zero)' : target.kind === 'label' ? fillOf(target) : target.kind === 'unsure' ? 'var(--warn)' : 'var(--flow-link)'
    const shape = svg('path', { d, stroke, 'stroke-width': zero ? 1 : Math.max(1, link.width ?? 1), class: `flow-link${zero ? ' zero' : ''}${target.kind === 'suggested' ? ' dashed' : ''}` })
    hover(shape, [`${source.name} → ${target.name}`, amount(link.value)])
    linkGroup.append(shape)
  }
  chart.append(linkGroup)

  const nodeGroup = svg('g', { class: 'flow-nodes' })
  for (const node of nodes) {
    const x0 = node.x0 ?? 0
    const x1 = node.x1 ?? 0
    const y0 = node.y0 ?? 0
    const y1 = node.y1 ?? 0
    const value = zero ? 0 : (node.value ?? 0)
    const lines = [node.name, amount(value), ...(zero ? [] : (node.detail ?? []))]
    const group = svg('g', {
      class: `flow-node kind-${node.kind}${zero ? ' zero' : ''}`,
      // The skeleton's nodes all say 0: named, but not nine Tab stops.
      tabindex: zero ? -1 : 0,
      role: 'img',
      'aria-label': zero ? `${node.name}：0 封` : `${node.name}：${String(value)} 封，占 ${share(value, graph.total)}`,
    })
    group.append(svg('rect', { x: x0, y: y0, width: Math.max(1, x1 - x0), height: Math.max(1, y1 - y0), rx: 2, fill: zero ? 'var(--flow-zero)' : fillOf(node) }))
    // Every node's name and count right of it (a halo in the surface color keeps it readable over the links).
    const text = svg('text', { x: x1 + 6, y: (y0 + y1) / 2, dy: '0.35em', class: 'flow-text' })
    text.append(svg('tspan', {}, node.name), svg('tspan', { class: 'flow-count', dx: 6 }, String(value)))
    group.append(text)
    hover(group, lines)
    group.addEventListener('focus', () => {
      show(lines)
    })
    group.addEventListener('blur', hide)
    nodeGroup.append(group)
  }
  chart.append(nodeGroup)
  scroll.append(chart)
  // The legend names the groups this day shows (every label node is also named in the diagram itself).
  const shown = new Set(drawn.nodes.filter((node) => node.kind === 'label').map((node) => node.group))
  const groups = drawn.groups.filter((group) => shown.has(group.name))
  if (groups.length > 0) {
    box.append(
      el(
        'ul',
        { class: 'flow-legend', 'aria-label': '分级颜色' },
        ...groups.map((group) => {
          const swatch = el('span', { class: 'swatch' })
          swatch.style.background = group.slot === 0 ? 'var(--muted)' : `var(--series-${String(group.slot)})`
          return el('li', {}, swatch, group.slot === 0 ? `${group.name}（灰色：标签超过八种颜色）` : group.name)
        }),
      ),
    )
  }
  return box
}

/**
 * Lookups over the public registry (GetRegistry, `GET /api/v1/registry`). The UI never hard-codes an entry, a
 * Worker or a flow: names, order, groups and links all come from the registry the Worker serves.
 */
import type { Flow as FlowDef, GuardView, RegistryEntry, Registry, StorageKind, Stage as StageDef, Target } from '../../../worker/src/api-types.ts'
import { routeHash } from '../router'
import { PLATFORM_SOURCES } from './labels'

export type Reg = Registry

export function entryOf(reg: Reg, id: string | null | undefined): RegistryEntry | undefined {
  return id ? reg.entries.find((entry) => entry.id === id) : undefined
}

/** Display name of an entry id or a platform source (dashboard, cloudflare); unknown ids stay raw. */
export function nameOf(reg: Reg, id: string): string {
  return entryOf(reg, id)?.name ?? (Object.hasOwn(PLATFORM_SOURCES, id) ? (PLATFORM_SOURCES[id] as string) : id)
}

export function flowOf(reg: Reg, id: string | null | undefined): FlowDef | undefined {
  return id ? reg.flows.find((flow) => flow.id === id) : undefined
}

export function stageOf(flow: FlowDef | undefined, id: string | null | undefined): StageDef | undefined {
  return id ? flow?.stages.find((stage) => stage.id === id) : undefined
}

export function resourceOf(reg: Reg, id: string | null | undefined) {
  return id ? reg.resources.find((resource) => resource.id === id) : undefined
}

/**
 * How an unregistered resource is shown after 未登记: an opaque D1/DO ID by its first 8 characters, an
 * R2 bucket by its (non-secret) name in full, so buckets sharing a prefix stay distinguishable.
 */
export function unregisteredId(kind: StorageKind, id: string): string {
  return kind === 'r2' ? id : id.slice(0, 8)
}

/** The one wording of an unregistered resource, in the resource table and the quota breakdowns alike. */
export function unregisteredLabel(kind: StorageKind, id: string): string {
  return `未登记 · ${unregisteredId(kind, id)}`
}

/** Usage measured without its resource dimension (R2 operations without a bucket, like the table). */
export function unclassifiedLabel(kind: StorageKind): string {
  return kind === 'r2' ? '未归类操作' : '未归类'
}

export function workerOf(reg: Reg, script: string) {
  return reg.workers.find((worker) => worker.script === script)
}

/** The scripts a stage runs on: its `workers`, or every Worker of its entry. */
export function stageScripts(reg: Reg, stage: StageDef): readonly string[] {
  if (stage.entry === null) return []
  return stage.workers ?? entryOf(reg, stage.entry)?.scripts ?? []
}

/** Groups sorted by order; `hidden` launcher entries have no tile. */
export function sortedByOrder<T extends { readonly order: number }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => a.order - b.order)
}

/** Flows an entry takes part in, business-group order. */
export function flowsOfEntry(reg: Reg, entry: string): FlowDef[] {
  const groupOrder = (flow: FlowDef) => reg.flow_groups.find((group) => group.id === flow.group)?.order ?? 99
  return [...reg.flows]
    .sort((a, b) => groupOrder(a) - groupOrder(b) || a.order - b.order)
    .filter((flow) => flow.stages.some((stage) => stage.entry === entry))
}

/** The hash an attention item links to. */
export function targetHash(target: Target): string {
  switch (target.view) {
    case 'flows':
      if (!target.flow) return routeHash({ view: 'flows' })
      return routeHash(target.stage ? { view: 'flows', flow: target.flow, stage: target.stage } : { view: 'flows', flow: target.flow })
    case 'cloudflare':
      return routeHash(target.script ? { view: 'cloudflare', script: target.script } : { view: 'cloudflare' })
    case 'ops':
      return routeHash({ view: 'ops' })
    case 'home':
      return routeHash({ view: 'home' })
  }
}

/** "邮件 → 任务 › Todofy 摘要", "Mail Hero", "Worker todofy" or the source's name. */
export function targetLabel(reg: Reg, target: Target, source: string): string {
  const flow = flowOf(reg, target.flow)
  if (flow) {
    const stage = stageOf(flow, target.stage)
    return stage ? `${flow.name} › ${stage.name}` : flow.name
  }
  if (target.entry) return nameOf(reg, target.entry)
  if (target.script) return `Worker ${target.script}`
  return nameOf(reg, source)
}

/**
 * Where a background service's row leads inside this page: its Worker (it has one), else the first
 * flow it takes part in, else 操作与记录.
 */
export function entryPageHash(reg: Reg, entry: RegistryEntry): { hash: string; what: string } {
  const script = entry.scripts[0]
  if (script !== undefined) return { hash: routeHash({ view: 'cloudflare', script }), what: '查看 Cloudflare 中的 Worker' }
  const flow = flowsOfEntry(reg, entry.id)[0]
  if (flow) return { hash: routeHash({ view: 'flows', flow: flow.id }), what: '查看业务流程' }
  return { hash: routeHash({ view: 'ops' }), what: '查看操作与记录' }
}

/** The guarded entries in registry order (the keys of guard.apps), then any the registry lacks. */
export function guardedEntries(reg: Reg, guard: GuardView): string[] {
  const ids = Object.keys(guard.apps)
  const known = sortedByOrder(reg.entries.filter((entry) => ids.includes(entry.id))).map((entry) => entry.id)
  return [...known, ...ids.filter((id) => !known.includes(id))]
}

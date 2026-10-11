/** A private JSON plan is resolved to current label identities before the owner confirms it. */
import { create } from '@ziyixi/proto/protobuf'
import { LabelConsolidationGroupSchema, type LabelConsolidationGroup } from '@ziyixi/proto/mailsort/ui/v2/consolidation_pb'
import type { Label } from '@ziyixi/proto/mailsort/ui/v2/label_pb'
import { labelNameProblem } from './label-name.ts'

export function parseConsolidationPlan(text: string, labels: readonly Label[]): LabelConsolidationGroup[] {
  if (text.length > 32_768) throw new Error('计划最多 32768 个字符')
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new Error('计划必须是有效的 JSON 数组') }
  if (!Array.isArray(value) || value.length === 0 || value.length > 24) throw new Error('计划需要 1–24 组标签')
  const used = new Set<string>()
  const targets = new Set<string>()
  return value.map((entry: unknown) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('每组需要 sources、display_name 和可选 description')
    const item = entry as Record<string, unknown>
    if (Object.keys(item).some((key) => !['sources', 'display_name', 'description'].includes(key))) throw new Error('计划包含未知字段')
    if (!Array.isArray(item['sources']) || item['sources'].length === 0 || item['sources'].length > 24 || typeof item['display_name'] !== 'string') throw new Error('每组需要来源名称数组 sources 和英文 display_name')
    const displayName = item['display_name'].trim()
    const problem = labelNameProblem(item['display_name'])
    if (problem !== null) throw new Error(problem)
    if (targets.has(displayName.toLowerCase())) throw new Error('目标名称不能重复')
    targets.add(displayName.toLowerCase())
    const description = item['description']
    if (description !== undefined && (typeof description !== 'string' || [...description].length > 300)) throw new Error('说明最多 300 个字符')
    const sources = item['sources'].map((name: unknown) => {
      if (typeof name !== 'string') throw new Error('来源必须填写现有标签的完整名称')
      const matches = labels.filter((label) => label.displayName === name)
      if (matches.length !== 1) throw new Error('有来源名称不存在或不唯一，请核对完整名称并刷新标签')
      const label = matches[0]!
      if (used.has(label.name)) throw new Error('每个来源标签只能出现一次')
      used.add(label.name)
      if (used.size > 24) throw new Error('计划最多包含 24 个来源标签')
      return { label: label.name, etag: label.etag }
    })
    return create(LabelConsolidationGroupSchema, { sources, targetLabel: sources[0]!.label, displayName, ...(description === undefined ? {} : { description }) })
  })
}

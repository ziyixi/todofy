import type { AttentionItem, ShellFields } from '../../../worker/src/api-types.ts'
import { rollupAttention, sortAttention } from '../../../worker/src/attention-rollup.ts'

/** Apply the server-confirmed write; a newer cached occurrence must never be overwritten. */
export function applyAttentionResult<V extends ShellFields>(view: V, expectedEtag: string, answer: AttentionItem): V {
  const old = [...view.attention.items, ...(view.attention.dismissed_items ?? [])]
    .find(item => item.name === answer.name)
  if (!old || old.etag !== expectedEtag) return view
  const items = view.attention.items.filter(item => item.name !== answer.name)
  const dismissed = (view.attention.dismissed_items ?? []).filter(item => item.name !== answer.name)
  if (answer.dismissed_at) dismissed.push(answer)
  else items.push(answer)
  sortAttention(items)
  const level = rollupAttention(items)
  const badges = { home: 0, flows: 0, cloudflare: 0, ops: 0 }
  for (const item of items) badges[item.target.view]++
  return { ...view, attention: { ...view.attention, level, items, dismissed_items: dismissed }, badges }
}

import { applyAttentionResult } from './attention-cache'
import { GEMINI_ITEM, shell } from '../test/fixtures'
import { targetDismissed } from '../components/AttentionActions'
import type { ShellFields } from '../../../worker/src/api-types.ts'

const item = { ...GEMINI_ITEM, name: 'attentionItems/test', etag: 'old' }
const dismissed = { ...item, etag: 'saved', dismissed_at: '2026-10-03T00:00:00Z' }

it('applies the server response while preserving other alerts and raw facts', () => {
  const other = { ...item, name: 'attentionItems/other', code: 'new_failure' }
  const view: ShellFields & { fact: number } = { ...shell(), fact: 32, attention: { level: 'warning', items: [item, other], info: [], held: [] } }
  const saved = applyAttentionResult(view, 'old', dismissed)
  expect(saved.fact).toBe(32)
  expect(saved.attention.items).toEqual([other])
  expect(saved.attention.dismissed_items).toEqual([dismissed])
  expect(saved.badges.flows).toBe(1)
  expect(applyAttentionResult(saved, 'saved', { ...item, etag: 'restored' }).attention.items).toHaveLength(2)
})

it('never overwrites a newer cached occurrence with a delayed write response', () => {
  const view = { ...shell(), attention: { level: 'warning' as const, items: [{ ...item, etag: 'new-incident' }], info: [], held: [] } }
  expect(applyAttentionResult(view, 'old', dismissed)).toBe(view)
})

it('a same-source alert outside the flow prevents its dismissal label from hiding the new problem', () => {
  const attention = { level: 'warning' as const, items: [], info: [], held: [], dismissed_items: [dismissed] }
  expect(targetDismissed(attention, { flow: 'mail-to-task' })).toBe(true)
  const outage = { ...item, code: 'unreachable', target: { view: 'home' as const, entry: 'todofy' } }
  expect(targetDismissed({ ...attention, items: [outage] }, { flow: 'mail-to-task' })).toBe(false)
})

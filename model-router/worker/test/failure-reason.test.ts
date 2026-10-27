import { expect, it } from 'vitest'
import { startHarness } from './runtime-harness.ts'

it('preserves the safe executor error reason instead of replacing it with generic unavailability', async () => {
  const h = await startHarness()
  try {
    h.failNextGeneration('ACCESS_KEYS_UNAVAILABLE')
    const answer = await h.models.generate({ model: 'gpt-6.1-sol', input: 'Synthetic diagnostic' })
    expect(answer.error).toMatchObject({ code: 14, reason: 'ACCESS_KEYS_UNAVAILABLE' })
    expect((await h.owner.getRequest({ name: answer.name })).generation?.error?.reason).toBe('ACCESS_KEYS_UNAVAILABLE')
  } finally { await h.dispose() }
}, 30000)

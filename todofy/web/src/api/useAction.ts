import { useRef } from 'react'
import { actionId } from './client'

/**
 * One action_request_id per distinct request: resending the identical body (after a network
 * failure, say) reuses the id so the Worker replays the stored outcome instead of acting twice;
 * any change to the body gets a fresh id, because the same id with a different body is a 409.
 * `forget()` drops the id after a definite failure the Worker stored (e.g. a 429 or 503 of a
 * recompute), which would otherwise be replayed on every retry from the same dialog.
 */
export function useActionId(): { idFor: (request: unknown) => string; forget: () => void } {
  const last = useRef<{ key: string; id: string } | null>(null)
  return {
    idFor: (request) => {
      const key = JSON.stringify(request)
      if (last.current?.key !== key) last.current = { key, id: actionId() }
      return last.current.id
    },
    forget: () => {
      last.current = null
    },
  }
}

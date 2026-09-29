import { useRef } from 'react'
import { actionId } from './client'

/**
 * One action_request_id per distinct request: resending the identical body (after a network
 * failure, say) reuses the id so the Worker replays the stored outcome instead of acting twice;
 * any change to the body gets a fresh id, because the same id with a different body is a 409.
 */
export function useActionId(): (request: unknown) => string {
  const last = useRef<{ key: string; id: string } | null>(null)
  return (request) => {
    const key = JSON.stringify(request)
    if (last.current?.key !== key) last.current = { key, id: actionId() }
    return last.current.id
  }
}

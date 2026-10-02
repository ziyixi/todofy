import { useRef } from 'react'
import { newRequestId } from './client'

/**
 * One request_id (AIP-155) per distinct request: resending the identical request (after a network failure, an
 * UNAVAILABLE or a RATE_LIMITED, say) reuses the ID, so TodofyCore applies it once and answers as before; any change
 * to the request gets a fresh ID, because the same ID with a different request is REQUEST_ID_REUSED.
 */
export function useRequestId(): { idFor: (request: unknown) => string } {
  const last = useRef<{ key: string; id: string } | null>(null)
  return {
    idFor: (request) => {
      const key = JSON.stringify(request)
      if (last.current?.key !== key) last.current = { key, id: newRequestId() }
      return last.current.id
    },
  }
}

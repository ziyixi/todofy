// The owner API (mailhero.ui.v2) as the tests call it: raw HTTP in the wire JSON profile, with the CSRF token and the
// same-origin Origin the UI sends, through any `fetcher` (handleAPI with a test env, or a Miniflare's dispatchFetch).
// Bodies and answers are the wire's own JSON (snake_case, lower-case enum names), so a test reads what the UI reads.

/** The API's path prefix. */
export const V2 = '/api/v2'

/** The last segment of a resource name (`messages/<id>` -> `<id>`). */
export const idOf = name => name.slice(name.lastIndexOf('/') + 1)

/** The ErrorInfo reason of an error body (undefined for none). */
export const reasonOf = data => data?.error?.details?.find(detail => detail['@type'] === 'type.googleapis.com/google.rpc.ErrorInfo')?.reason

/** An AIP-160 quoted literal or value. */
export const quote = text => `"${String(text).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`

/** A query string of the defined parameters ('' for none). */
export function query(parameters) {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(parameters)) if (value !== undefined && value !== null && value !== '') search.set(key, String(value))
  const text = search.toString()
  return text === '' ? '' : `?${text}`
}

/**
 * A session: fetches the CSRF token from `${origin}/api/csrf` (with `headers`, e.g. an Access JWT) and answers
 * `call(method, path, body?, extraHeaders?)` -> {response, status, data} for `${origin}/api/v2${path}`.
 */
export async function ownerSession(fetcher, { origin = 'http://127.0.0.1:8787', headers = {} } = {}) {
  const csrf = await fetcher(new Request(`${origin}/api/csrf`, { headers }))
  if (csrf.status !== 200) throw new Error(`csrf: ${csrf.status} ${await csrf.text()}`)
  const { token } = await csrf.json()
  const cookie = csrf.headers.get('set-cookie').split(';')[0]
  return async function call(method, path, body, extra = {}) {
    const response = await fetcher(new Request(`${origin}${V2}${path}`, {
      method,
      headers: { ...headers, Cookie: cookie, Origin: origin, 'X-CSRF-Token': token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    }))
    const text = await response.text()
    let data
    try { data = JSON.parse(text) } catch { data = text }
    return { response, status: response.status, data }
  }
}

/** A webhook target as tests create it: the CreateEndpoint body of a Bearer target on consumer.example.org. */
export function endpointBody(fields = {}) {
  return { display_name: 'Consumer', uri: 'https://consumer.example.org/hooks/mail', auth_type: 'bearer', credential: 'test-secret', ...fields }
}

/** Creates a target (CreateEndpoint) and answers its wire Endpoint with `id` (its UUID); fails the test otherwise. */
export async function createEndpoint(call, fields = {}, requestId = crypto.randomUUID()) {
  const result = await call('POST', `/endpoints${query({ request_id: requestId })}`, endpointBody(fields))
  if (result.status !== 200) throw new Error(`CreateEndpoint: ${result.status} ${JSON.stringify(result.data)}`)
  return { ...result.data, id: idOf(result.data.name) }
}

/** SendMessage of message `id` to target `endpointID`: the call's result (`data.delivery` on success). */
export function sendMessage(call, id, endpointID, requestId = crypto.randomUUID()) {
  return call('POST', `/messages/${id}:send`, { endpoint: `endpoints/${endpointID}`, request_id: requestId })
}

import { expect, it, vi } from 'vitest'
import { executorClient, finalResponse } from '../src/executor.ts'

function stream(parts: string[]) {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of parts) controller.enqueue(new TextEncoder().encode(part))
        controller.close()
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  )
}

it('reduces private heartbeat frames to one final JSON response', async () => {
  const result = await finalResponse(
    stream([
      'event: ready\ndata: {}\n\n',
      'event: heartbeat\ndata: {}\n\n',
      'event: result\ndata: {"output":"合成结果"}\n\n',
    ]),
  )
  expect(result.headers.get('content-type')).toContain('application/json')
  expect(await result.json()).toEqual({ output: '合成结果' })
})

it('accepts SSE CRLF boundaries split between network chunks', async () => {
  const result = await finalResponse(stream(['event: result\r', '\ndata: {"output":"synthetic"}\r', '\n\r', '\n']))
  expect(await result.json()).toEqual({ output: 'synthetic' })
})

it('converts an SSE error event frame into a 503 JSON error response', async () => {
  const result = await finalResponse(
    stream([
      'event: ready\ndata: {}\n\n',
      'event: error\ndata: {"error":{"code":503,"status":"UNAVAILABLE","message":"synthetic"}}\n\n',
    ]),
  )
  expect(result.status).toBe(503)
  expect(result.headers.get('content-type')).toContain('application/json')
  expect(await result.json()).toEqual({ error: { code: 503, status: 'UNAVAILABLE', message: 'synthetic' } })
})

it('rejects unknown SSE events and streams without a body or exceeding 16 MiB', async () => {
  await expect(finalResponse(stream(['event: unexpected\ndata: {}\n\n']))).rejects.toMatchObject({
    reason: 'MODEL_EXECUTOR_INVALID_RESPONSE',
  })
  await expect(
    finalResponse(new Response(null, { status: 200, headers: { 'content-type': 'text/event-stream' } })),
  ).rejects.toMatchObject({
    reason: 'MODEL_EXECUTOR_INVALID_RESPONSE',
  })
  const oversized = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(16 * 1024 * 1024 + 1).fill(65))
        controller.close()
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  )
  await expect(finalResponse(oversized)).rejects.toMatchObject({
    reason: 'MODEL_EXECUTOR_INVALID_RESPONSE',
  })
})

it('treats a stream ending without its final receipt as an unknown execution', async () => {
  await expect(finalResponse(stream(['event: ready\ndata: {}\n\n']))).rejects.toMatchObject({
    reason: 'MODEL_EXECUTOR_INTERRUPTED',
  })
})

it('requires executor configuration and maps network failures to MODEL_EXECUTOR_UNAVAILABLE', async () => {
  type ExecutorEnv = Parameters<typeof executorClient>[0]
  expect(() => executorClient({} as ExecutorEnv)).toThrowError(
    expect.objectContaining({ reason: 'MODEL_NOT_CONFIGURED' }),
  )
  const client = executorClient(
    {
      CODEX_EXECUTOR_ORIGIN: 'https://executor.example.test',
      CODEX_ACCESS_CLIENT_ID: 'synthetic-id',
      CODEX_ACCESS_CLIENT_SECRET: 'synthetic-secret',
    } as ExecutorEnv,
    undefined,
    vi.fn<typeof fetch>().mockRejectedValue(new Error('network down')),
  )
  await expect(client.generate({ model: 'gpt-6.1-sol', input: 'synthetic' })).rejects.toMatchObject({
    reason: 'MODEL_EXECUTOR_UNAVAILABLE',
  })
})

import { expect, it } from 'vitest'
import { finalResponse } from '../src/executor.ts'

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

it('treats a stream ending without its final receipt as an unknown execution', async () => {
  await expect(finalResponse(stream(['event: ready\ndata: {}\n\n']))).rejects.toMatchObject({
    reason: 'MODEL_EXECUTOR_INTERRUPTED',
  })
})

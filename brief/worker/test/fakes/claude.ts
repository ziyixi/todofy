/**
 * A fake Claude API (the Messages API's streaming wire, design §17): SSE answers with thinking omitted, pings, text in
 * chunks, a refusal before or during output, a server-side fallback before or during output, a mid-stream
 * `overloaded_error`, a stall, and every 4xx class as a JSON error. The real SDK reads these answers through an injected
 * fetch (the unit tests) or Miniflare's outbound service (the workerd suite); no key and no network are involved.
 * All content is synthetic.
 */

export interface FakeUsage {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly cache_creation_input_tokens?: number;
  readonly cache_read_input_tokens?: number;
  readonly iterations?: readonly Record<string, unknown>[];
}

export type FakeBlock = { readonly type: 'thinking' } | { readonly type: 'text'; readonly text: string } | { readonly type: 'fallback'; readonly from: string; readonly to: string };

export interface FakeMessage {
  readonly model?: string;
  readonly blocks: readonly FakeBlock[];
  readonly stop?: 'end_turn' | 'max_tokens' | 'refusal';
  readonly category?: string | null;
  readonly usage?: FakeUsage;
  /** An `error` event (overloaded) after this many blocks instead of the end. */
  readonly errorAfterBlocks?: number;
  /** Stop sending after this many blocks (no end): a stall. */
  readonly stallAfterBlocks?: number;
  /** Pings between the events. */
  readonly pings?: boolean;
}

function event(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** The SSE events of a message, as text chunks. */
export function sseEvents(message: FakeMessage): { chunks: string[]; stall: boolean } {
  const model = message.model ?? 'claude-opus-5-5';
  const usage = message.usage ?? {};
  const chunks: string[] = [
    event('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_synthetic',
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: usage.input_tokens ?? 1000, output_tokens: 1, cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0, cache_read_input_tokens: usage.cache_read_input_tokens ?? 0 },
      },
    }),
  ];
  const ping = (): void => {
    if (message.pings === true) chunks.push(event('ping', { type: 'ping' }));
  };
  for (const [index, block] of message.blocks.entries()) {
    if (message.errorAfterBlocks === index) {
      chunks.push(event('error', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }));
      return { chunks, stall: false };
    }
    if (message.stallAfterBlocks === index) return { chunks, stall: true };
    ping();
    if (block.type === 'thinking') {
      chunks.push(event('content_block_start', { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } }));
      chunks.push(event('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: 'c2lnbmF0dXJl' } }));
    } else if (block.type === 'fallback') {
      chunks.push(event('content_block_start', { type: 'content_block_start', index, content_block: { type: 'fallback', from: { model: block.from }, to: { model: block.to }, trigger: { type: 'refusal', category: 'cyber' } } }));
    } else {
      chunks.push(event('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }));
      // Text in a few chunks, as a stream would deliver it.
      const size = Math.max(1, Math.ceil(block.text.length / 3));
      for (let at = 0; at < block.text.length; at += size) {
        chunks.push(event('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text.slice(at, at + size) } }));
        ping();
      }
    }
    chunks.push(event('content_block_stop', { type: 'content_block_stop', index }));
  }
  if (message.errorAfterBlocks === message.blocks.length) {
    chunks.push(event('error', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }));
    return { chunks, stall: false };
  }
  if (message.stallAfterBlocks === message.blocks.length) return { chunks, stall: true };
  const stop = message.stop ?? 'end_turn';
  chunks.push(
    event('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stop, stop_sequence: null, stop_details: stop === 'refusal' ? { type: 'refusal', category: message.category ?? null, explanation: null } : null },
      usage: { output_tokens: usage.output_tokens ?? 500, ...(usage.iterations === undefined ? {} : { iterations: usage.iterations }) },
    }),
  );
  chunks.push(event('message_stop', { type: 'message_stop' }));
  return { chunks, stall: false };
}

/** A 200 SSE answer of a message (a stall keeps the stream open until the request is aborted). */
export function sseResponse(message: FakeMessage, signal?: AbortSignal): Response {
  const { chunks, stall } = sseEvents(message);
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      if (!stall) {
        controller.close();
        return;
      }
      signal?.addEventListener('abort', () => {
        try {
          controller.error(new Error('aborted'));
        } catch {
          // Already closed.
        }
      });
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream', 'request-id': 'req_synthetic' } });
}

/** An API error before the stream (the JSON error body). */
export function apiError(status: number, type: string): Response {
  return Response.json({ type: 'error', error: { type, message: 'synthetic error message that must never be logged' } }, { status, headers: { 'request-id': 'req_synthetic_error' } });
}

/** A text answer of JSON (the usual structured output), with a thinking block first. */
export function jsonAnswer(value: unknown, model = 'claude-opus-5-5', usage: FakeUsage = {}): FakeMessage {
  return { model, blocks: [{ type: 'thinking' }, { type: 'text', text: JSON.stringify(value) }], usage, pings: true };
}

export interface RecordedCall {
  readonly url: string;
  readonly body: Record<string, unknown>;
  readonly headers: Record<string, string>;
}

/**
 * A fetch that answers `https://api.anthropic.com/v1/messages` with the responder's answer for each request (its
 * parsed body), and records every call.
 */
export function fakeClaudeFetch(respond: (body: Record<string, unknown>, call: number) => Response | ((signal: AbortSignal | undefined) => Response)): { fetch: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const body = await request.json<Record<string, unknown>>();
    calls.push({ url: request.url, body, headers: Object.fromEntries(request.headers.entries()) });
    const answer = respond(body, calls.length);
    return typeof answer === 'function' ? answer(init?.signal ?? request.signal) : answer;
  }) as typeof fetch;
  return { fetch: fetchFn, calls };
}

/** Which step a request is, read from its system block (the fake's routing for the workerd suite). */
export function stepOf(body: Record<string, unknown>): 'gate' | 'pick' | 'write' | 'repair' | 'deep_pick' | 'deep_read' | 'entail' | 'unknown' {
  const system = typeof body['system'] === 'string' ? body['system'] : JSON.stringify(body['system'] ?? '');
  if (system.includes('# 初筛的输出')) return 'gate';
  if (system.includes('# 挑选的输出')) return 'pick';
  if (system.includes('# 深读挑选的输出')) return 'deep_pick';
  if (system.includes('# 修订')) return 'repair';
  if (system.includes('# 输出规则（深读）')) return 'deep_read';
  if (system.includes('# 输出规则')) return 'write';
  if (system.includes('verdict')) return 'entail';
  return 'unknown';
}

/** Shared replies and generated-client transport for the source-owned MCP tools. */
import { ProtocolError, type CallToolResult } from '@modelcontextprotocol/server';
import { RpcStatusError, type HttpSend } from '@ziyixi/proto/http-client';

export function bindingTransport(binding: Fetcher, origin: string): HttpSend {
  return call => binding.fetch(new Request(`${origin}${call.url}`, {
    method: call.httpMethod,
    ...(call.body === undefined ? {} : { body: call.body, headers: { 'content-type': 'application/json' } }),
  }));
}

const REASON_MESSAGES: Readonly<Record<string, string>> = {
  ETAG_MISMATCH: 'The source changed. Read its current state and review the requested change before retrying.',
  NOT_FOUND: 'The requested record is no longer available.',
  QUERY_NOT_SEARCHABLE: 'Use a searchable phrase; one Chinese, Japanese or Korean character alone is not enough.',
  SEARCH_OVER_BUDGET: 'Recall has reached its daily read budget. Search is available after the next UTC midnight.',
  MAINTENANCE: 'The source is under maintenance. Repeat the request later; keep the same request_id for a collection.',
  UNAVAILABLE: 'The source is temporarily unavailable. Repeat the request later; keep the same request_id for a collection.',
};

export async function answer(source: 'MAIL' | 'RECALL' | 'HOME' | 'WATCH', action: () => Promise<Record<string, unknown>>, collect = false): Promise<CallToolResult> {
  try {
    const result = await action();
    return { structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] };
  } catch (error) {
    if (error instanceof ProtocolError) throw error;
    const code = error instanceof RpcStatusError ? error.status.reason ?? error.status.status ?? `${source}_REQUEST_FAILED`
      : collect ? 'MAIL_COLLECTION_UNCONFIRMED' : `${source}_UNAVAILABLE`;
    const sourceMessage = code === 'ETAG_MISMATCH' && source === 'MAIL'
      ? 'The Mail entry changed. Read mail_list again and review the requested collection before retrying.' : REASON_MESSAGES[code];
    const message = error instanceof RpcStatusError ? sourceMessage ?? error.status.message
      : collect ? 'Could not confirm the Mail collection. Retry with the same request_id, etag and input.'
        : 'Could not read the source. Try the same read again later.';
    const result = { error: { code, message } };
    return { isError: true, structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] };
  }
}


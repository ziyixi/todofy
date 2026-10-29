/**
 * Newsletter's golden answers (contracts/newsletter-ui-v1/fixtures, synthetic) served through a stubbed fetch, so
 * the pages read them through the real client and codec, and a render helper with a fresh query cache.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi } from 'vitest';
import { App } from '../App.tsx';

const FIXTURES = join(import.meta.dirname, '..', '..', '..', '..', 'contracts', 'newsletter-ui-v1', 'fixtures');

export const BLOCKED_RUN = 'runs/00000000-0000-4000-8000-000000002800';
export const READY_RUN = 'runs/00000000-0000-4000-8000-000000002700';
export const LATEST_RUN = 'runs/00000000-0000-4000-8000-000000002900';

export function fixture<T = Record<string, unknown>>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8')) as T;
}

/** The selection call of the 10-28 run: in flight when the node ran out of its budget (synthetic). */
export const TIMED_OUT_CALLS = {
  model_calls: [{
    name: `${BLOCKED_RUN}/modelCalls/00000000-0000-4000-8000-000000007803`,
    node_id: 'selection', purpose: 'selection', requested_model: 'gpt-6.1-sol', state: 'failed', failure_code: 'timeout',
    partial: true, turn_count: 1, completed_turn_count: 0, input_tokens: 8000, start_time: '2026-10-28T14:05:01Z',
    end_time: '2026-10-28T14:07:41.300Z', update_time: '2026-10-28T14:07:41.300Z',
    conversation: 'conversations/00000000-0000-4000-8000-000000008803',
  }],
};

/** A JSON body, or a factory of the whole Response (a Status error). */
export type Answer = unknown;

/** Default answers by API path; a test overrides any of them. */
export function world(overrides: Record<string, Answer> = {}): Record<string, Answer> {
  return {
    '/api/v1/overview': fixture('overview'),
    '/api/v1/runs': fixture('runs'),
    [`/api/v1/${BLOCKED_RUN}`]: fixture('run-blocked-selection-timeout'),
    [`/api/v1/${READY_RUN}`]: fixture('run-ready'),
    [`/api/v1/${LATEST_RUN}`]: fixture('run-ready'),
    [`/api/v1/${BLOCKED_RUN}/modelCalls`]: TIMED_OUT_CALLS,
    [`/api/v1/${READY_RUN}/modelCalls`]: fixture('model-calls'),
    ...overrides,
  };
}

/** Stubs fetch with `answers` (JSON bodies, or a Response factory) and records each requested URL. */
export function serve(answers: Record<string, Answer>): string[] {
  const requested: string[] = [];
  vi.stubGlobal('fetch', (input: string) => {
    requested.push(input);
    const answer = answers[new URL(input, 'https://news.example.test').pathname];
    if (typeof answer === 'function') return Promise.resolve((answer as () => Response)());
    if (answer === undefined) {
      return Promise.resolve(Response.json({ error: { code: 404, message: '', status: 'NOT_FOUND' } }, { status: 404 }));
    }
    return Promise.resolve(Response.json(answer));
  });
  return requested;
}

/** Renders the console at `hash` with a fresh cache and no retries. */
export function show(hash = '#/'): void {
  window.location.hash = hash;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><App /></QueryClientProvider>);
}

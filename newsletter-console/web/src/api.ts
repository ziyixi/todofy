import { queryOptions } from '@tanstack/react-query';
import { NewsletterUiService } from '@ziyixi/proto/newsletter/ui/v1/newsletter_ui_service_pb';
import { ListModelCallsResponseSchema, ListRunsResponseSchema } from '@ziyixi/proto/newsletter/ui/v1/newsletter_ui_service_pb';
import { OverviewSchema } from '@ziyixi/proto/newsletter/ui/v1/overview_pb';
import { RunSchema } from '@ziyixi/proto/newsletter/ui/v1/run_pb';
import type { ListModelCallsResponse, ListRunsResponse } from '@ziyixi/proto/newsletter/ui/v1/newsletter_ui_service_wire';
import type { Overview } from '@ziyixi/proto/newsletter/ui/v1/overview_wire';
import type { Run } from '@ziyixi/proto/newsletter/ui/v1/run_wire';
import { createHttpClient } from '@ziyixi/proto/http-client';
import { toWire } from '@ziyixi/proto/wire-json';

export const client = createHttpClient(NewsletterUiService, (call) => fetch(call.url, { method: call.httpMethod, body: call.body, credentials: 'same-origin', redirect: 'error' }));

/**
 * The reads the pages make, as wire JSON (snake_case fields, enum names): the client reads each answer leniently into
 * its message, and the pages read the wire shape, as Fleet's do.
 */
export const read = {
  overview: async (): Promise<Overview> => toWire(OverviewSchema, await client.getOverview({ name: 'overview' })),
  runs: async (monthValue: string): Promise<ListRunsResponse> =>
    toWire(ListRunsResponseSchema, await client.listRuns({ month: monthValue })),
  run: async (name: string): Promise<Run> => toWire(RunSchema, await client.getRun({ name })),
  modelCalls: async (parent: string): Promise<ListModelCallsResponse> =>
    toWire(ListModelCallsResponseSchema, await client.listModelCalls({ parent, pageSize: 200 })),
};

/** While a run is queued or running, every page that shows it reads it again this often, until it ends. */
export const RUNNING_REFETCH_MS = 30_000;

/** One run's read, the same wherever it is shown (the overview's flow and the run's page share it). */
export const runQuery = (name: string) => queryOptions({
  queryKey: ['run', name],
  queryFn: () => read.run(name),
  refetchInterval: (query) => (query.state.data?.state === 'running' || query.state.data?.state === 'queued' ? RUNNING_REFETCH_MS : false),
});

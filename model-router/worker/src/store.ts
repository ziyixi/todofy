import { create } from '@ziyixi/proto/protobuf';
import { timestampFromDate, timestampDate, type Timestamp } from '@ziyixi/proto/protobuf/wkt';
import { fromWire, toWire } from '@ziyixi/proto/wire-json';
import {
  GenerateRequestSchema,
  GenerationSchema,
  ObservationsSchema,
  type GenerateRequest,
} from '@ziyixi/proto/modelrouter/inference/v1/inference_pb';
import {
  RequestRecordSchema,
  ListRequestsResponseSchema,
  UsageBucketSchema,
  UsageSummarySchema,
  type RequestRecord,
  type ListRequestsRequest,
  type GetUsageRequest,
} from '@ziyixi/proto/modelrouter/inference/v1/console_pb';
import { providerFor } from './catalog.ts';
import type { Env } from './types.ts';
import { Code, RpcError, invalid } from './errors.ts';

export const DAY = 86_400_000;
export const CONTENT_DAYS = 7;
export const METADATA_DAYS = 90;
export function timestamp(ms: number): Timestamp {
  return timestampFromDate(new Date(ms));
}
export function millis(value: Timestamp | undefined): number {
  return value ? timestampDate(value).getTime() : 0;
}
export interface RequestRow {
  id: string;
  app: string;
  model: string;
  state: string;
  started_ms: number;
  completed_ms: number | null;
  body_key: string;
  content_expire_ms: number;
  generation_json: string;
}
interface RequestBody {
  request?: unknown;
  // Bodies written before the invocation API was simplified remain readable for their original lifetime.
  config?: { model?: string; parameters?: object };
  input?: string;
  output: string;
  observations?: unknown;
}
function metadata(value: RequestRecord): string {
  return JSON.stringify(toWire(RequestRecordSchema, {
    ...value,
    request: undefined,
    generation: value.generation && {
      ...value.generation,
      output: '',
      observations: value.generation.observations && { ...value.generation.observations, openedUrls: [] },
    },
  }));
}
function record(row: RequestRow): RequestRecord {
  const raw = JSON.parse(row.generation_json) as Record<string, unknown>;
  if (raw.generation) return fromWire(RequestRecordSchema, raw).message;
  const generation = fromWire(GenerationSchema, { ...raw, model: row.model }).message;
  return create(RequestRecordSchema, {
    generation,
    app: row.app,
    provider: providerFor(row.model),
    reportedModel: typeof raw.reported_model === 'string' ? raw.reported_model : '',
    state: row.state,
    startedAt: timestamp(row.started_ms),
    ...(row.completed_ms ? { completedAt: timestamp(row.completed_ms) } : {}),
    durationMs: row.completed_ms ? row.completed_ms - row.started_ms : 0,
    contentExpireTime: timestamp(row.content_expire_ms),
    contentAvailable: raw.content_unavailable !== true,
  });
}
export class Store {
  readonly env: Env;
  constructor(env: Env) {
    this.env = env;
  }

  async start(value: RequestRecord, request: GenerateRequest): Promise<void> {
    const generation = value.generation!;
    const id = generation.name.slice('requests/'.length);
    const key = `requests/${value.app}/${id}.json`;
    await this.env.REQUEST_BODIES.put(key, JSON.stringify({ request: toWire(GenerateRequestSchema, request), output: '' }), {
      httpMetadata: { contentType: 'application/json' },
    });
    // input_hash is an unused legacy column; no caller supplies a replay identity anymore.
    await this.env.DB.prepare('INSERT INTO requests (id,app,model,state,started_ms,body_key,content_expire_ms,input_hash,generation_json) VALUES (?,?,?,?,?,?,?,\'\',?)')
      .bind(
        id,
        value.app,
        generation.model,
        value.state,
        millis(value.startedAt),
        key,
        millis(value.contentExpireTime),
        metadata(value),
      )
      .run();
  }
  async finish(value: RequestRecord, request: GenerateRequest): Promise<void> {
    const generation = value.generation!;
    const id = generation.name.slice('requests/'.length);
    try {
      await this.env.REQUEST_BODIES.put(`requests/${value.app}/${id}.json`, JSON.stringify({
        request: toWire(GenerateRequestSchema, request),
        output: generation.output,
        ...(generation.observations ? { observations: toWire(ObservationsSchema, generation.observations) } : {}),
      }), { httpMetadata: { contentType: 'application/json' } });
    } catch {
      value = { ...value, contentAvailable: false };
    }
    await this.env.DB.prepare('UPDATE requests SET model = ?, state = ?, completed_ms = ?, generation_json = ? WHERE id = ?')
      .bind(generation.model, value.state, millis(value.completedAt), metadata(value), id)
      .run();
  }
  async detail(id: string): Promise<RequestRecord> {
    const row = await this.env.DB.prepare('SELECT * FROM requests WHERE id = ?').bind(id).first<RequestRow>();
    if (!row) throw new RpcError(Code.NOT_FOUND, 'REQUEST_NOT_FOUND', 'Request metadata is no longer available.');
    const value = record(row);
    const object = row.content_expire_ms > Date.now() && value.contentAvailable
      ? await this.env.REQUEST_BODIES.get(row.body_key) : null;
    if (!object) return { ...value, contentAvailable: false };
    const body = await object.json<RequestBody>();
    const original = body.request ?? {
      ...body.config,
      ...body.config?.parameters,
      model: body.config?.model ?? row.model,
      input: body.input ?? '',
    };
    return {
      ...value,
      request: fromWire(GenerateRequestSchema, original).message,
      generation: value.generation && {
        ...value.generation,
        output: body.output,
        ...(body.observations ? { observations: fromWire(ObservationsSchema, body.observations).message } : {}),
      },
      contentAvailable: true,
    };
  }
  async list(query: ListRequestsRequest) {
    const size = query.pageSize || 20;
    if (!Number.isInteger(size) || size < 1 || size > 100)
      invalid('INVALID_PAGE_SIZE', 'Page size must be between 1 and 100.');
    const where = ['started_ms >= ?'];
    const values: (string | number)[] = [Math.max(Date.now() - METADATA_DAYS * DAY, millis(query.fromTime))];
    if (query.toTime) {
      where.push('started_ms < ?');
      values.push(millis(query.toTime));
    }
    for (const [column, value] of [['app', query.app], ['model', query.model], ['state', query.state]]) {
      if (value) {
        where.push(`${column} = ?`);
        values.push(value);
      }
    }
    if (query.pageToken) {
      let cursor: { time: number; id: string };
      try {
        cursor = JSON.parse(atob(query.pageToken)) as { time: number; id: string };
      } catch {
        invalid('INVALID_PAGE_TOKEN', 'Reload the request list.');
      }
      if (!Number.isSafeInteger(cursor.time) || typeof cursor.id !== 'string')
        invalid('INVALID_PAGE_TOKEN', 'Reload the request list.');
      where.push('(started_ms < ? OR (started_ms = ? AND id < ?))');
      values.push(cursor.time, cursor.time, cursor.id);
    }
    const result = await this.env.DB.prepare(`SELECT * FROM requests WHERE ${where.join(' AND ')} ORDER BY started_ms DESC,id DESC LIMIT ?`)
      .bind(...values, size + 1)
      .all<RequestRow>();
    const rows = result.results.slice(0, size);
    const last = rows.at(-1);
    return create(ListRequestsResponseSchema, {
      requests: rows.map((row) => ({ ...record(row), contentAvailable: false })),
      nextPageToken: result.results.length > size && last
        ? btoa(JSON.stringify({ time: last.started_ms, id: last.id }))
        : '',
    });
  }
  async usage(query: GetUsageRequest) {
    const days = query.days || 7;
    if (!Number.isInteger(days) || days < 1 || days > METADATA_DAYS)
      invalid('INVALID_RANGE', 'Choose between 1 and 90 days.');
    const where = ['started_ms >= ?'];
    const values: (string | number)[] = [Math.floor(Date.now() / DAY) * DAY - (days - 1) * DAY];
    if (query.app) {
      where.push('app = ?');
      values.push(query.app);
    }
    if (query.model) {
      where.push('model = ?');
      values.push(query.model);
    }
    const unit = days === 1 ? 3_600_000 : DAY;
    const count = (key: string) => `sum(COALESCE(json_extract(result,'$.usage.${key}'),0))`;
    const tokenSums = ['input_tokens', 'output_tokens', 'cached_input_tokens', 'cache_write_tokens']
      .map((key) => `${count(key)} AS ${key}`)
      .join(',');
    interface Bucket {
      time: number;
      model: string;
      billing_kind: string;
      request_count: number;
      success_count: number;
      failure_count: number;
      input_tokens: number;
      output_tokens: number;
      cached_input_tokens: number;
      cache_write_tokens: number;
      estimated_cost_microusd: number | null;
      usage_available_count: number;
      cost_available_count: number;
    }
    const rows = await this.env.DB.prepare(`WITH selected AS (
      SELECT *, COALESCE(json_extract(generation_json,'$.generation'),generation_json) AS result FROM requests WHERE ${where.join(' AND ')}
    ) SELECT (started_ms / ${unit}) * ${unit} AS time, model,
      COALESCE(json_extract(result,'$.usage.billing_kind'),'') AS billing_kind,
      count(*) AS request_count, sum(state = 'succeeded') AS success_count,
      sum(state IN ('failed','cancelled','interrupted')) AS failure_count,
      ${tokenSums},
      CASE WHEN count(json_extract(result,'$.usage.estimated_cost_microusd')) > 0 THEN ${count('estimated_cost_microusd')} ELSE NULL END AS estimated_cost_microusd,
      count(json_extract(result,'$.usage.estimated_cost_microusd')) AS cost_available_count,
      ${count('available')} AS usage_available_count
      FROM selected GROUP BY time,model,billing_kind ORDER BY time,model,billing_kind`).bind(...values).all<Bucket>();
    return create(UsageSummarySchema, {
      buckets: rows.results.map((row) => create(UsageBucketSchema, {
        time: timestamp(row.time),
        model: row.model,
        provider: providerFor(row.model),
        billingKind: row.billing_kind,
        requestCount: row.request_count,
        successCount: row.success_count,
        failureCount: row.failure_count,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        cachedInputTokens: row.cached_input_tokens,
        cacheWriteTokens: row.cache_write_tokens,
        ...(row.estimated_cost_microusd !== null ? { estimatedCostMicrousd: row.estimated_cost_microusd } : {}),
        usageAvailableCount: row.usage_available_count,
        costAvailableCount: row.cost_available_count,
      })),
    });
  }
  async cleanup(now = Date.now()): Promise<void> {
    await this.env.DB.prepare('DELETE FROM requests WHERE id IN (SELECT id FROM requests WHERE started_ms < ? LIMIT 1000)')
      .bind(now - METADATA_DAYS * DAY)
      .run();
  }
}

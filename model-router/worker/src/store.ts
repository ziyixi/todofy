import { create } from '@ziyixi/proto/protobuf';
import { timestampFromDate, timestampDate, type Timestamp } from '@ziyixi/proto/protobuf/wkt';
import { fromWire, toWire } from '@ziyixi/proto/wire-json';
import {
  GenerateRequestSchema,
  GenerationSchema,
  ObservationsSchema,
  UsageSchema,
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
/** Longer than the longest 840-second turn; a row still running after this lost its invocation. */
export const STUCK_MS = 20 * 60_000;
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
  if (raw.generation) {
    const value = fromWire(RequestRecordSchema, raw).message;
    return { ...value, provider: value.provider === 'openai' && value.generation?.usage?.billingKind === 'subscription'
      ? 'codex' : providerFor(row.model) || value.provider };
  }
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
const HOUR_MS = 3_600_000;
const PRIVATE_DIRECT_LIMIT = 8;
const PRIVATE_ROLLUP_BATCH = 20;
const PRIVATE_ROLLUP_INTERVAL_MS = 10_000;

interface RollupEntry {
  readonly id: string;
  readonly app: string;
  readonly model: string;
  readonly state: string;
  readonly month: string;
  readonly hourMs: number;
  readonly expireMs: number;
  maxCompletedMs: number;
  pendingCalls: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  costMicrousd: number;
  lastFlushMs: number;
}

const privateRollups = new Map<string, RollupEntry>();
let privateCallCount = 0;

/** Unflushed in-memory OpenAI microusd buffered for private-app hourly D1 rollups in the active UTC month. */
export function pendingPrivateOpenAICost(monthSuffix: string): number {
  let sum = 0;
  for (const entry of privateRollups.values()) {
    if (entry.month === monthSuffix && entry.model.startsWith('openai/')) sum += entry.costMicrousd;
  }
  return sum;
}

export class Store {
  readonly env: Env;
  constructor(env: Env) {
    this.env = env;
  }

  async openaiMonthlyCost(now = Date.now()): Promise<number> {
    const date = new Date(now);
    const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
    const end = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
    return await this.env.DB.prepare(`SELECT COALESCE(sum(json_extract(
      COALESCE(json_extract(generation_json,'$.generation'),generation_json),
      '$.usage.estimated_cost_microusd')),0) AS cost
      FROM requests WHERE model GLOB 'openai/*' AND started_ms >= ? AND started_ms < ?`)
      .bind(start, end).first<number>('cost') ?? 0;
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
    try {
      await this.env.DB.prepare('UPDATE requests SET model = ?, state = ?, completed_ms = ?, generation_json = ? WHERE id = ?')
        .bind(generation.model, value.state, millis(value.completedAt), metadata(value), id)
        .run();
    } catch {
      // The caller still receives its result; the daily sweep marks the running row interrupted.
      console.warn('model_request_finish_unrecorded');
    }
  }
  async finishPrivate(value: RequestRecord): Promise<boolean> {
    const generation = value.generation!;
    const id = generation.name.slice('requests/'.length);
    const key = `requests/${value.app}/${id}.json`;
    const stored: RequestRecord = { ...value, contentAvailable: false };
    const startedMs = millis(stored.startedAt);
    const completedMs = millis(stored.completedAt) || Date.now();
    privateCallCount += 1;
    if (privateCallCount <= PRIVATE_DIRECT_LIMIT) {
      try {
        await this.env.DB.prepare('INSERT INTO requests (id,app,model,state,started_ms,completed_ms,body_key,content_expire_ms,input_hash,generation_json) VALUES (?,?,?,?,?,?,?,?,\'\',?)')
          .bind(id, stored.app, generation.model, stored.state, startedMs, completedMs, key, millis(stored.contentExpireTime), metadata(stored))
          .run();
        return true;
      } catch {
        console.warn('private_request_d1_quota');
        return false;
      }
    }

    const hourMs = Math.floor(startedMs / HOUR_MS) * HOUR_MS;
    const bucketKey = `${hourMs}:${generation.model}:${stored.state}`;
    const now = Date.now();
    const usage = generation.usage;
    let entry = privateRollups.get(bucketKey);
    if (!entry) {
      entry = {
        id: `private-rollup-${hourMs}-${generation.model.replaceAll('/', '_')}-${stored.state}`,
        app: stored.app,
        model: generation.model,
        state: stored.state,
        month: new Date(hourMs).toISOString().slice(0, 7),
        hourMs,
        expireMs: millis(stored.contentExpireTime),
        maxCompletedMs: completedMs,
        pendingCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        costMicrousd: 0,
        lastFlushMs: now,
      };
      privateRollups.set(bucketKey, entry);
    }
    entry.maxCompletedMs = Math.max(entry.maxCompletedMs, completedMs);
    entry.pendingCalls += 1;
    entry.inputTokens += usage?.inputTokens ?? 0;
    entry.outputTokens += usage?.outputTokens ?? 0;
    entry.cachedInputTokens += usage?.cachedInputTokens ?? 0;
    entry.cacheWriteTokens += usage?.cacheWriteTokens ?? 0;
    entry.costMicrousd += usage?.estimatedCostMicrousd ?? 0;

    if (entry.pendingCalls < PRIVATE_ROLLUP_BATCH && now - entry.lastFlushMs < PRIVATE_ROLLUP_INTERVAL_MS) {
      return true;
    }

    const seed = metadata(create(RequestRecordSchema, {
      ...stored,
      startedAt: timestamp(entry.hourMs),
      completedAt: timestamp(entry.maxCompletedMs),
      generation: {
        ...generation,
        name: `requests/${entry.id}`,
        output: '',
        usage: create(UsageSchema, {
          available: usage?.available ?? true,
          billingKind: usage?.billingKind ?? 'api',
          inputTokens: entry.inputTokens,
          outputTokens: entry.outputTokens,
          cachedInputTokens: entry.cachedInputTokens,
          cacheWriteTokens: entry.cacheWriteTokens,
          estimatedCostMicrousd: entry.costMicrousd,
        }),
      },
    }));
    const dInput = entry.inputTokens;
    const dOutput = entry.outputTokens;
    const dCached = entry.cachedInputTokens;
    const dCacheWrite = entry.cacheWriteTokens;
    const dCost = entry.costMicrousd;
    const dCompleted = entry.maxCompletedMs;
    const rollupId = entry.id;
    privateRollups.delete(bucketKey);

    try {
      await this.env.DB.prepare(
        `INSERT INTO requests (id,app,model,state,started_ms,completed_ms,body_key,content_expire_ms,input_hash,generation_json)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'',?9)
         ON CONFLICT(id) DO UPDATE SET
           completed_ms = MAX(COALESCE(requests.completed_ms, 0), excluded.completed_ms),
           generation_json = json_set(
             requests.generation_json,
             '$.generation.usage.input_tokens',
             COALESCE(json_extract(requests.generation_json, '$.generation.usage.input_tokens'), 0) + ?10,
             '$.generation.usage.output_tokens',
             COALESCE(json_extract(requests.generation_json, '$.generation.usage.output_tokens'), 0) + ?11,
             '$.generation.usage.cached_input_tokens',
             COALESCE(json_extract(requests.generation_json, '$.generation.usage.cached_input_tokens'), 0) + ?12,
             '$.generation.usage.cache_write_tokens',
             COALESCE(json_extract(requests.generation_json, '$.generation.usage.cache_write_tokens'), 0) + ?13,
             '$.generation.usage.estimated_cost_microusd',
             COALESCE(json_extract(requests.generation_json, '$.generation.usage.estimated_cost_microusd'), 0) + ?14
           )`,
      )
        .bind(
          rollupId, stored.app, generation.model, stored.state, hourMs, dCompleted,
          `requests/${stored.app}/${rollupId}.json`, entry.expireMs, seed,
          dInput, dOutput, dCached, dCacheWrite, dCost,
        )
        .run();
      return true;
    } catch {
      // Never drop a completed private extraction result if D1 usage logging fails.
      console.warn('private_request_d1_quota');
      return false;
    }
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
    // A deploy or reset can cut a call off before finish(); its result is unknown, never retried.
    await this.env.DB.prepare(`UPDATE requests SET state = 'interrupted', completed_ms = ?1,
      generation_json = json_set(generation_json, '$.state', 'interrupted', '$.completed_at', ?2)
      WHERE id IN (SELECT id FROM requests WHERE state = 'running' AND started_ms < ?3 LIMIT 1000)`)
      .bind(now, new Date(now).toISOString(), now - STUCK_MS)
      .run();
    await this.env.DB.prepare('DELETE FROM requests WHERE id IN (SELECT id FROM requests WHERE started_ms < ? LIMIT 1000)')
      .bind(now - METADATA_DAYS * DAY)
      .run();
  }
}

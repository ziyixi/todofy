import { create } from '@ziyixi/proto/protobuf';
import { timestampFromDate, timestampDate } from '@ziyixi/proto/protobuf/wkt';
import { fromWire, toWire } from '@ziyixi/proto/wire-json';
import {
  GenerationSchema,
  GenerationConfigSchema,
  ObservationsSchema,
  RequestRecordSchema,
  ListRequestsResponseSchema,
  UsageDaySchema,
  UsageSummarySchema,
  type Generation,
  type GenerationConfig,
  type ListRequestsRequest,
  type GetUsageRequest,
} from '@ziyixi/proto/modelrouter/inference/v1/inference_pb';
import type { Env } from './types.ts';
import { Code, RpcError, invalid } from './errors.ts';

export const DAY = 86_400_000;
export const CONTENT_DAYS = 7;
export const METADATA_DAYS = 90;
export const timestamp = (ms: number) => timestampFromDate(new Date(ms));
export const millis = (value: Generation['startedAt']) => (value ? timestampDate(value).getTime() : 0);
const wire = (value: Generation) =>
  JSON.stringify(
    toWire(GenerationSchema, {
      ...value,
      output: '',
      ...(value.observations ? { observations: { ...value.observations, openedUrls: [] } } : {}),
    }),
  );
export interface RequestRow {
  id: string;
  app: string;
  model: string;
  state: string;
  started_ms: number;
  completed_ms: number | null;
  body_key: string;
  content_expire_ms: number;
  input_hash: string;
  generation_json: string;
}
export interface ConversationRow {
  id: string;
  app: string;
  model: string;
  provider: string;
  state: string;
  config_key: string;
  history_key: string;
  expire_ms: number;
  created_ms: number;
}
export interface RequestBody {
  config: unknown;
  input: string;
  output: string;
  observations?: unknown;
}

export class Store {
  readonly env: Env;
  constructor(env: Env) {
    this.env = env;
  }

  async request(id: string): Promise<RequestRow | null> {
    return this.env.DB.prepare('SELECT * FROM requests WHERE id = ?').bind(id).first<RequestRow>();
  }
  async start(value: Generation, inputHash: string, config: GenerationConfig, input: string): Promise<void> {
    const id = value.name.slice('requests/'.length);
    const key = `requests/${value.app}/${id}.json`;
    await this.env.REQUEST_BODIES.put(
      key,
      JSON.stringify({ config: toWire(GenerationConfigSchema, config), input, output: '' }),
      { httpMetadata: { contentType: 'application/json' } },
    );
    await this.env.DB.prepare(
      'INSERT INTO requests (id,app,model,state,started_ms,body_key,content_expire_ms,input_hash,generation_json) VALUES (?,?,?,?,?,?,?,?,?)',
    )
      .bind(
        id,
        value.app,
        value.model,
        value.state,
        millis(value.startedAt),
        key,
        millis(value.contentExpireTime),
        inputHash,
        wire(value),
      )
      .run();
  }
  async finish(value: Generation, config: GenerationConfig, input: string): Promise<Generation> {
    const id = value.name.slice('requests/'.length);
    try {
      await this.env.REQUEST_BODIES.put(
        `requests/${value.app}/${id}.json`,
        JSON.stringify({
          config: toWire(GenerationConfigSchema, config),
          input,
          output: value.output,
          ...(value.observations ? { observations: toWire(ObservationsSchema, value.observations) } : {}),
        }),
        { httpMetadata: { contentType: 'application/json' } },
      );
    } catch {
      value = { ...value, contentUnavailable: true };
    }
    await this.env.DB.prepare('UPDATE requests SET state = ?, completed_ms = ?, generation_json = ? WHERE id = ?')
      .bind(value.state, millis(value.completedAt), wire(value), id)
      .run();
    return value;
  }
  async read(row: RequestRow, body = false): Promise<Generation> {
    const value = fromWire(GenerationSchema, JSON.parse(row.generation_json)).message;
    if (body && row.content_expire_ms > Date.now() && !value.contentUnavailable) {
      const saved = await this.env.REQUEST_BODIES.get(row.body_key);
      if (saved) {
        const body = await saved.json<RequestBody>();
        return {
          ...value,
          output: body.output,
          ...(body.observations ? { observations: fromWire(ObservationsSchema, body.observations).message } : {}),
        };
      }
      return { ...value, output: '', contentUnavailable: true };
    }
    return {
      ...value,
      output: '',
      contentUnavailable: value.contentUnavailable || row.content_expire_ms <= Date.now(),
    };
  }
  async detail(id: string) {
    const row = await this.request(id);
    if (!row) throw new RpcError(Code.NOT_FOUND, 'REQUEST_NOT_FOUND', 'Request metadata is no longer available.');
    const generation = await this.read(row);
    const object =
      row.content_expire_ms > Date.now() && !generation.contentUnavailable
        ? await this.env.REQUEST_BODIES.get(row.body_key)
        : null;
    if (!object) return create(RequestRecordSchema, { generation: { ...generation, contentUnavailable: true } });
    const body = await object.json<RequestBody>();
    return create(RequestRecordSchema, {
      generation: {
        ...generation,
        output: body.output,
        ...(body.observations ? { observations: fromWire(ObservationsSchema, body.observations).message } : {}),
      },
      config: fromWire(GenerationConfigSchema, body.config).message,
      input: body.input,
      contentAvailable: true,
    });
  }
  async list(query: ListRequestsRequest) {
    const size = query.pageSize || 20;
    if (!Number.isInteger(size) || size < 1 || size > 100)
      invalid('INVALID_PAGE_SIZE', 'Page size must be between 1 and 100.');
    const where: string[] = ['started_ms >= ?'];
    const values: (string | number)[] = [Math.max(Date.now() - METADATA_DAYS * DAY, millis(query.fromTime))];
    if (query.toTime) {
      where.push('started_ms < ?');
      values.push(millis(query.toTime));
    }
    for (const [column, value] of [
      ['app', query.app],
      ['model', query.model],
      ['state', query.state],
    ]) {
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
    const result = await this.env.DB.prepare(
      `SELECT * FROM requests WHERE ${where.join(' AND ')} ORDER BY started_ms DESC,id DESC LIMIT ?`,
    )
      .bind(...values, size + 1)
      .all<RequestRow>();
    const rows = result.results.slice(0, size);
    const last = rows.at(-1);
    return create(ListRequestsResponseSchema, {
      requests: await Promise.all(rows.map((row) => this.read(row))),
      nextPageToken:
        result.results.length > size && last ? btoa(JSON.stringify({ time: last.started_ms, id: last.id })) : '',
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
    const token = (key: string) => `sum(COALESCE(json_extract(generation_json,'$.usage.${key}'),0))`;
    interface Daily {
      day: string;
      request_count: number;
      success_count: number;
      failure_count: number;
      input_tokens: number;
      output_tokens: number;
      cached_input_tokens: number;
      cache_write_tokens: number;
      estimated_cost_microusd: number;
      subscription_request_count: number;
      usage_available_count: number;
      api_cost_available: number;
    }
    const rows = await this.env.DB.prepare(
      `SELECT strftime('%Y-%m-%d',started_ms/1000,'unixepoch') AS day, count(*) AS request_count,
      sum(state = 'succeeded') AS success_count, sum(state IN ('failed','cancelled','interrupted')) AS failure_count,
      ${['input_tokens', 'output_tokens', 'cached_input_tokens', 'cache_write_tokens', 'estimated_cost_microusd'].map((key) => `${token(key)} AS ${key}`).join(',')},
      sum(json_extract(generation_json,'$.usage.billing_kind') = 'subscription') AS subscription_request_count,
      sum(COALESCE(json_extract(generation_json,'$.usage.available'),0)) AS usage_available_count,
      max(json_type(generation_json,'$.usage.estimated_cost_microusd') IS NOT NULL) AS api_cost_available
      FROM requests WHERE ${where.join(' AND ')} GROUP BY day ORDER BY day`,
    )
      .bind(...values)
      .all<Daily>();
    const total = create(UsageSummarySchema);
    total.days = rows.results.map((row) =>
      create(UsageDaySchema, {
        day: row.day,
        requestCount: row.request_count,
        successCount: row.success_count,
        failureCount: row.failure_count,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        cachedInputTokens: row.cached_input_tokens,
        cacheWriteTokens: row.cache_write_tokens,
        estimatedCostMicrousd: row.estimated_cost_microusd,
        subscriptionRequestCount: row.subscription_request_count || 0,
      }),
    );
    for (const row of total.days)
      for (const key of [
        'requestCount',
        'successCount',
        'failureCount',
        'inputTokens',
        'outputTokens',
        'cachedInputTokens',
        'cacheWriteTokens',
        'estimatedCostMicrousd',
        'subscriptionRequestCount',
      ] as const)
        total[key] += row[key];
    total.usageAvailableCount = rows.results.reduce((sum, row) => sum + row.usage_available_count, 0);
    total.apiCostAvailable = rows.results.some((row) => row.api_cost_available === 1);
    return total;
  }
  async conversation(id: string): Promise<ConversationRow | null> {
    return this.env.DB.prepare('SELECT * FROM conversations WHERE id = ?').bind(id).first<ConversationRow>();
  }
  async cleanup(now = Date.now()): Promise<void> {
    // Bodies expire through the R2 lifecycle; one bounded daily SQL sweep retains 90-day metadata.
    await this.env.DB.batch([
      this.env.DB.prepare(
        'DELETE FROM requests WHERE id IN (SELECT id FROM requests WHERE started_ms < ? LIMIT 1000)',
      ).bind(now - METADATA_DAYS * DAY),
      this.env.DB.prepare(
        'DELETE FROM conversations WHERE id IN (SELECT id FROM conversations WHERE expire_ms < ? LIMIT 1000)',
      ).bind(now - DAY),
    ]);
  }
}

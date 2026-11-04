import { create, type MessageShape } from '@ziyixi/proto/protobuf';
import { EmptySchema, timestampFromDate } from '@ziyixi/proto/protobuf/wkt';
import { decodePageToken, encodePageToken, PageTokenError } from '@ziyixi/proto/page-token';
import type { ServiceHandlers } from '@ziyixi/proto/http-transcoder';
import { Code } from '@ziyixi/proto/rpc-status';
import { fieldRules, formatMatches } from '@ziyixi/proto/wire-json';
import { ClientSchema, Client_Access, SettingsSchema } from '@ziyixi/proto/storage/ui/v1/client_pb';
import { OverviewSchema, RequestFailureSchema, UsageCountSchema } from '@ziyixi/proto/storage/ui/v1/overview_pb';
import { ConnectDropboxResponseSchema, DisconnectDropboxResponseSchema, ListClientsResponseSchema, type StorageUiService } from '@ziyixi/proto/storage/ui/v1/storage_ui_service_pb';
import type { Dropbox, ProviderError } from './dropbox.ts';
import { MAX_CLIENTS } from './env.ts';
import { badRequest, failure } from './errors.ts';
import { digest, namespace, randomText } from './keys.ts';
import type { ClientRow, FailureRow, Store, UsageRow } from './store.ts';
import { DAY_MS, OPERATIONS, OUTCOMES, utcDay } from './usage.ts';

export interface OwnerContext {
  readonly store: Store;
  readonly dropbox: Dropbox;
  readonly redirectUri: string;
  /** Writes the pending in-memory counters, so an overview includes them. */
  readonly flushUsage: () => void;
  readonly buildSha: string;
  readonly stateSizeBytes: () => number;
}

const OVERVIEW_DAYS = 14;
const MAX_USAGE_COUNTS = fieldRules(OverviewSchema.field.usage).maxItems;

const timestamp = (milliseconds: number) => timestampFromDate(new Date(milliseconds));

function clientMessage(row: ClientRow, apiKey = ''): MessageShape<typeof ClientSchema> {
  return create(ClientSchema, {
    name: 'clients/' + row.id, label: row.label, namespace: row.namespace, access: row.access as Client_Access,
    createTime: timestamp(row.create_time), ...(apiKey === '' ? {} : { apiKey }),
    ...(row.last_use_time > 0 ? { lastUseTime: timestamp(row.last_use_time) } : {}),
  });
}

function settingsMessage(store: Store): MessageShape<typeof SettingsSchema> {
  const appKey = store.get('app_key');
  const failed = store.get('provider_error') as ProviderError | null;
  const connection = store.connection();
  const success = store.get('last_success');
  const writeSuccess = store.get('last_write_success');
  return create(SettingsSchema, {
    name: 'settings', connected: connection !== null, appKey: typeof appKey === 'string' ? appKey : '',
    ...(failed === null ? {} : { lastProviderError: failed.reason, lastProviderErrorTime: timestamp(failed.time) }),
    ...(connection?.connectTime === undefined ? {} : { connectTime: timestamp(connection.connectTime) }),
    ...(typeof success === 'number' && connection !== null ? { lastSuccessTime: timestamp(success) } : {}),
    ...(typeof writeSuccess === 'number' && connection !== null ? { lastWriteSuccessTime: timestamp(writeSuccess) } : {}),
  });
}

function usageMessage(row: UsageRow): MessageShape<typeof UsageCountSchema> | null {
  const operation = OPERATIONS.value(row.operation);
  const outcome = OUTCOMES.value(row.outcome);
  if (operation === undefined || outcome === undefined) return null;
  return create(UsageCountSchema, {
    day: row.day, client: 'clients/' + row.client_id, namespace: row.namespace, operation, outcome, requestCount: row.requests,
    objectCount: row.objects, uploadBytes: row.upload_bytes, downloadBytes: row.download_bytes, maxBatchObjectCount: row.max_batch,
  });
}

function failureMessage(row: FailureRow): MessageShape<typeof RequestFailureSchema> | null {
  const operation = OPERATIONS.value(row.operation);
  if (operation === undefined) return null;
  return create(RequestFailureSchema, {
    failureTime: timestamp(row.time), client: 'clients/' + row.client_id, namespace: row.namespace, operation,
    reason: row.reason, httpStatus: row.http_status, retryAfterSeconds: row.retry_after,
  });
}

function clientId(name: string): string {
  if (!/^clients\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(name)) badRequest();
  return name.slice('clients/'.length);
}

export const handlers: ServiceHandlers<typeof StorageUiService.method, OwnerContext> = {
  getSettings: (input, context) => {
    if (input.name !== 'settings') badRequest();
    return Promise.resolve(settingsMessage(context.store));
  },
  getOverview: (input, context) => {
    if (input.name !== 'overview') badRequest();
    context.flushUsage();
    const now = Date.now();
    const counts = context.store.usage(utcDay(now - (OVERVIEW_DAYS - 1) * DAY_MS), MAX_USAGE_COUNTS + 1);
    return Promise.resolve(create(OverviewSchema, {
      name: 'overview', generateTime: timestamp(now), settings: settingsMessage(context.store),
      clients: context.store.clients('', MAX_CLIENTS).map((row) => clientMessage(row)),
      usage: counts.slice(0, MAX_USAGE_COUNTS).map(usageMessage).filter((count) => count !== null),
      usageTruncated: counts.length > MAX_USAGE_COUNTS,
      recentFailures: context.store.failures().map(failureMessage).filter((failed) => failed !== null),
      buildSha: context.buildSha, stateSizeBytes: context.stateSizeBytes(),
    }));
  },
  listClients: (input, context) => {
    if (input.pageSize < 0) badRequest();
    const limit = Math.min(input.pageSize || 20, 64);
    let after = '';
    if (input.pageToken !== '') {
      try {
        const cursor = decodePageToken(input.pageToken, {});
        if (typeof cursor !== 'string' || !/^[0-9a-f-]{36}$/.test(cursor)) badRequest();
        after = cursor;
      } catch (error) {
        if (error instanceof PageTokenError) badRequest();
        throw error;
      }
    }
    const rows = context.store.clients(after, limit + 1);
    const page = rows.slice(0, limit);
    return Promise.resolve(create(ListClientsResponseSchema, {
      clients: page.map((row) => clientMessage(row)),
      nextPageToken: rows.length > limit ? encodePageToken(page[page.length - 1]?.id ?? '', {}) : '',
    }));
  },
  createClient: async (input, context) => {
    const value = input.client;
    if (value === undefined) badRequest();
    const label = value.label.trim();
    if (!formatMatches(ClientSchema.file, 'Label', label) || Array.from(label).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) badRequest();
    const clientNamespace = namespace(value.namespace);
    if (value.access !== Client_Access.READ_ONLY && value.access !== Client_Access.READ_WRITE) badRequest();
    const existing = context.store.client(input.requestId);
    if (existing !== null) {
      if (existing.revoked !== 0) throw failure(Code.NOT_FOUND, 'NOT_FOUND');
      if (existing.label !== label || existing.namespace !== clientNamespace || existing.access !== value.access) badRequest();
      return clientMessage(existing);
    }
    const apiKey = 'sto_' + randomText();
    const row: ClientRow = {
      id: input.requestId, label, namespace: clientNamespace, access: value.access,
      token_sha256: await digest(apiKey), create_time: Date.now(), revoked: 0, last_use_time: 0,
    };
    // No await separates the second replay check and insert in this object.
    const repeated = context.store.client(input.requestId);
    if (repeated !== null) {
      if (repeated.revoked !== 0 || repeated.label !== label || repeated.namespace !== clientNamespace || repeated.access !== value.access) badRequest();
      return clientMessage(repeated);
    }
    context.store.addClient(row);
    return clientMessage(row, apiKey);
  },
  deleteClient: (input, context) => {
    const id = clientId(input.name);
    const existing = context.store.client(id);
    if (existing === null || existing.revoked !== 0) throw failure(Code.NOT_FOUND, 'NOT_FOUND');
    context.store.revokeClient(id);
    return Promise.resolve(create(EmptySchema));
  },
  connectDropbox: async (input, context) => {
    if (input.name !== 'dropbox') badRequest();
    return create(ConnectDropboxResponseSchema, { authorizeUrl: await context.dropbox.connect(input.appKey, context.redirectUri) });
  },
  disconnectDropbox: async (input, context) => {
    if (input.name !== 'dropbox') badRequest();
    await context.dropbox.disconnect();
    return create(DisconnectDropboxResponseSchema);
  },
};

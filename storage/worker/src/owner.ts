import { create, type MessageShape } from '@ziyixi/proto/protobuf';
import { EmptySchema, timestampFromDate } from '@ziyixi/proto/protobuf/wkt';
import { decodePageToken, encodePageToken, PageTokenError } from '@ziyixi/proto/page-token';
import type { ServiceHandlers } from '@ziyixi/proto/http-transcoder';
import { Code } from '@ziyixi/proto/rpc-status';
import { formatMatches } from '@ziyixi/proto/wire-json';
import { ClientSchema, Client_Access, SettingsSchema } from '@ziyixi/proto/storage/ui/v1/client_pb';
import { ConnectDropboxResponseSchema, DisconnectDropboxResponseSchema, ListClientsResponseSchema, type StorageUiService } from '@ziyixi/proto/storage/ui/v1/storage_ui_service_pb';
import type { Dropbox } from './dropbox.ts';
import { badRequest, failure } from './errors.ts';
import { digest, namespace, randomText } from './keys.ts';
import type { ClientRow, Store } from './store.ts';

export interface OwnerContext {
  readonly store: Store;
  readonly dropbox: Dropbox;
  readonly redirectUri: string;
}

function clientMessage(row: ClientRow, apiKey = ''): MessageShape<typeof ClientSchema> {
  return create(ClientSchema, {
    name: 'clients/' + row.id, label: row.label, namespace: row.namespace, access: row.access as Client_Access,
    createTime: timestampFromDate(new Date(row.create_time)), ...(apiKey === '' ? {} : { apiKey }),
  });
}

function clientId(name: string): string {
  if (!/^clients\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(name)) badRequest();
  return name.slice('clients/'.length);
}

export const handlers: ServiceHandlers<typeof StorageUiService.method, OwnerContext> = {
  getSettings: (input, context) => {
    if (input.name !== 'settings') badRequest();
    const appKey = context.store.get('app_key');
    return Promise.resolve(create(SettingsSchema, { name: 'settings', connected: context.store.connection() !== null, appKey: typeof appKey === 'string' ? appKey : '' }));
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
      token_sha256: await digest(apiKey), create_time: Date.now(), revoked: 0,
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

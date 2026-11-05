import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { createMcpHandler, McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { afterEach } from 'vitest';
import type { WorkStorage } from '../src/work-store.ts';

const databases: DatabaseSync[] = [];
const handlers: ReturnType<typeof createMcpHandler>[] = [];

afterEach(async () => {
  await Promise.all(handlers.splice(0).map(handler => handler.close()));
  for (const database of databases.splice(0)) database.close();
});

export function uuid(value: number) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
}

export function createTestWorkStorage(): WorkStorage {
  const database = new DatabaseSync(':memory:');
  databases.push(database);
  const sql = {
    exec(query: string, ...bindings: SqlStorageValue[]) {
      if (query.trimStart().startsWith('CREATE')) {
        database.exec(query);
        return { toArray: () => [] };
      }
      const values = bindings.map(value => value instanceof ArrayBuffer ? new Uint8Array(value) : value) satisfies SQLInputValue[];
      const rows = database.prepare(query).all(...values);
      return { toArray: () => rows };
    },
  } as unknown as SqlStorage;
  let transaction = 0;
  return {
    sql,
    transactionSync<T>(action: () => T): T {
      const savepoint = `work_test_${String(++transaction)}`;
      database.exec(`SAVEPOINT ${savepoint}`);
      try {
        const result = action();
        database.exec(`RELEASE ${savepoint}`);
        return result;
      } catch (error) {
        database.exec(`ROLLBACK TO ${savepoint}`);
        database.exec(`RELEASE ${savepoint}`);
        throw error;
      }
    },
  };
}

export type ToolCallResponse = {
  result?: CallToolResult;
  error?: { code: number; message: string };
};

export function createToolCaller(name: string, register: (server: McpServer) => void) {
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name, version: '1.0.0' }, { capabilities: { tools: {} } });
    register(server);
    return server;
  }, { legacy: 'reject' });
  handlers.push(handler);
  return async (toolName: string, args: Record<string, unknown> = {}) => {
    const response = await handler.fetch(new Request('https://mcp.example.org/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': 'tools/call',
        'Mcp-Name': toolName,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: toolName,
          arguments: args,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': {},
            'io.modelcontextprotocol/clientInfo': { name: 'synthetic', version: '1' },
          },
        },
      }),
    }));
    return response.json<ToolCallResponse>();
  };
}

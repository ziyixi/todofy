import { ProtocolError, type CallToolResult, type McpServer } from '@modelcontextprotocol/server';
import {
  workCheckpointSchema, workContextSchema, workCreateSchema, workExportSchema, workGetSchema,
  workListSchema, workReportSchema,
} from './work-model.ts';
import type { WorkStore } from './work-store.ts';

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const write = { ...readOnly, readOnlyHint: false };

async function answer(action: () => Record<string, unknown> | Promise<Record<string, unknown>>): Promise<CallToolResult> {
  try {
    const result = await action();
    return { structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] };
  } catch (error) {
    if (error instanceof ProtocolError) throw error;
    throw new ProtocolError(-32603, 'Could not confirm the work-memory request. Retry a write with the same request_id and input.');
  }
}

/** Source refresh is optional; the store itself neither polls services nor runs executors. */
export function registerWorkTools(server: McpServer, work: WorkStore, beforeRead?: () => Promise<unknown>,
  beforeWatchLink?: () => Promise<void>): void {
  server.registerTool('work_context', {
    title: 'Read work context',
    description: 'Recover what to do after starting or resuming a conversation. Returns a small page of open work, prioritizing unhandled reports, due follow-ups and waiting work. review_at alone does not create a native schedule.',
    inputSchema: workContextSchema,
    annotations: readOnly,
  }, input => answer(async () => { const sources = await beforeRead?.(); return { ...work.context(input), ...(sources ? { sources } : {}) }; }));

  server.registerTool('work_list', {
    title: 'List work records',
    description: 'Read one page of work summaries, optionally filtered by native reference. Default state is open. Preserve selectors when following next_page_token.',
    inputSchema: workListSchema,
    annotations: readOnly,
  }, input => answer(() => work.list(input)));

  server.registerTool('work_get', {
    title: 'Read work and reports',
    description: 'Read the full checkpoint, native references, recent history and the oldest unhandled reports. Page both histories as needed. handled_through_candidate identifies the reports returned so far; reading alone does not acknowledge them.',
    inputSchema: workGetSchema,
    annotations: readOnly,
  }, input => answer(async () => { const sources = await beforeRead?.(); return { ...work.get(input), ...(sources ? { sources } : {}) }; }));

  server.registerTool('work_create', {
    title: 'Create work memory',
    description: 'Remember an owner-authorized objective, scope, completion criteria and next step. Keep full documents and execution output in native sources. Links default to references; owned is only for dedicated resources created for this work. Reuse request_id and identical input after an uncertain response.',
    inputSchema: workCreateSchema,
    annotations: write,
  }, input => answer(async () => {
    if (input.links.some(link => link.type === 'watch')) await beforeWatchLink?.();
    return work.create(input);
  }));

  server.registerTool('work_checkpoint', {
    title: 'Save work checkpoint',
    description: 'Silently save the next step and optional key fact or decision using the current etag. Acknowledge only reports actually handled, through handled_through_report_seq. This does not stop native resources or complete Tasks. Finish only after owned resources are confirmed stopped or completed. Reuse request_id and input for an exact retry.',
    inputSchema: workCheckpointSchema,
    annotations: write,
  }, input => answer(async () => {
    if (input.changes.links?.some(link => link.type === 'watch')) await beforeWatchLink?.();
    return work.checkpoint(input);
  }));

  server.registerTool('work_report', {
    title: 'Report external work progress',
    description: 'Report a relevant observation, question, blocker or result from an attached native source. Use a stable report_id for retries; conflicting payloads are rejected. This may notify the responsible Dot, and never marks work done. Use work_checkpoint for the Dot’s own notes to avoid notification loops.',
    inputSchema: workReportSchema,
    annotations: write,
  }, input => answer(() => work.report(input)));

  server.registerTool('work_export', {
    title: 'Export work memory',
    description: 'Read a paginated export of work records and meaningful entries, optionally for one work_id. Follow next_page_token through both sections. It excludes callback credentials, subscriptions and internal receipt fingerprints.',
    inputSchema: workExportSchema,
    annotations: readOnly,
  }, input => answer(() => work.export(input)));
}

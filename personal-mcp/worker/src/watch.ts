import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { fromWire, toWire } from '@ziyixi/proto/wire-json';
import { createHttpClient } from '@ziyixi/proto/http-client';
import {
  ListChangesResponseSchema, ListWatchesResponseSchema, PreviewWatchResponseSchema, UpdateWatchRequestSchema, WatchUiService,
} from '@ziyixi/proto/watch/ui/v1/watch_ui_service_pb';
import { WatchSchema, Watch_State } from '@ziyixi/proto/watch/ui/v1/watch_pb';
import { ChangeSchema, type Change } from '@ziyixi/proto/watch/ui/v1/change_pb';
import { answer, bindingTransport } from './source-tools.ts';
import { workIdSchema, workError } from './work-model.ts';
import type { WorkStore } from './work-store.ts';

export interface WatchToolEnv { WATCH: Fetcher }
export function createWatchClient(env: WatchToolEnv) {
  return createHttpClient(WatchUiService, bindingTransport(env.WATCH, 'https://watch.internal'));
}

const name = z.string().regex(/^watches\/[a-z][a-z0-9-]{0,39}$/);
const changeName = z.string().regex(/^watches\/[a-z][a-z0-9-]{0,39}\/changes\/[a-zA-Z0-9-]+$/);
const selector = z.string().min(1).max(200);
const source = z.union([
  z.strictObject({ html: z.strictObject({ include_selectors: z.array(selector).max(10).optional(),
    exclude_selectors: z.array(selector).max(10).optional(), keep_links: z.boolean().optional() }) }),
  z.strictObject({ feed: z.strictObject({ include_summaries: z.boolean().optional() }) }),
  z.strictObject({ json: z.strictObject({ path: z.string().max(300) }) }),
  z.strictObject({ embedded: z.strictObject({ kind: z.enum(['json_ld', 'next_data']), path: z.string().max(300).optional() }) }),
]);
const trigger = z.union([
  z.strictObject({ any_change: z.strictObject({ min_changed_lines: z.number().int().min(1).max(1000).default(1),
    min_changed_percent: z.number().min(0).max(100).default(0) }) }),
  z.strictObject({ text_appears: z.strictObject({ text: z.string().min(1).max(200) }) }),
  z.strictObject({ text_disappears: z.strictObject({ text: z.string().min(1).max(200) }) }),
  z.strictObject({ new_item: z.strictObject({ min_new_items: z.number().int().min(1).max(100).default(1) }) }),
  z.strictObject({ number: z.strictObject({ label: z.string().max(100).optional(),
    upper_threshold: z.number().optional(), lower_threshold: z.number().optional(),
    change_percent: z.number().min(0).max(10000).optional() }) }),
  z.strictObject({ availability: z.strictObject({ only_when_available: z.boolean().default(true) }) }),
]);
const settings = {
  display_name: z.string().trim().min(1).max(80), uri: z.url({ protocol: /^https$/ }).max(2048),
  intent: z.string().trim().min(1).max(200), source: source.optional(), trigger: trigger.optional(),
  check_interval_minutes: z.number().int().min(60).max(10080).optional(),
};
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const write = { ...readOnly, readOnlyHint: false };

function changeEvidence(change: Change) {
  return { ...toWire(ChangeSchema, change), before_context: change.beforeContext, after_context: change.afterContext,
    context_available: change.contextAvailable, context_truncated: change.contextTruncated };
}

export function registerWatchTools(server: McpServer, env: WatchToolEnv, work: WorkStore, beforeCreate: () => Promise<void>): void {
  const client = createWatchClient(env);

  server.registerTool('watch_list', {
    title: 'List watches', description: 'Read a page of existing watches. Attach an existing watch as a shared work link; preserve its notification settings and ownership.',
    inputSchema: z.strictObject({ filter: z.string().max(200).default(''), page_size: z.number().int().min(1).max(50).default(20),
      page_token: z.string().max(4096).default('') }), annotations: readOnly,
  }, input => answer('WATCH', async () => toWire(ListWatchesResponseSchema,
    await client.listWatches({ filter: input.filter, pageSize: input.page_size, pageToken: input.page_token }))));

  server.registerTool('watch_get', {
    title: 'Read watch', description: 'Read the source-owned settings, actual check times and health. Broken, paused and never checked do not mean no change.',
    inputSchema: z.strictObject({ name }), annotations: readOnly,
  }, input => answer('WATCH', async () => toWire(WatchSchema, await client.getWatch(input))));

  server.registerTool('watch_preview', {
    title: 'Preview a watch', description: 'Fetch and extract the selected region before creating a watch. If the requested condition is already true, act on that evidence now. Source robots rules, cached reads and fetch spacing still apply; no model is called.',
    inputSchema: z.strictObject({ ...settings, name: name.optional(), refresh: z.boolean().default(false) }), annotations: readOnly,
  }, input => answer('WATCH', async () => {
    const { refresh, ...config } = input;
    return toWire(PreviewWatchResponseSchema, await client.previewWatch({
      watch: fromWire(WatchSchema, config, { strict: true }).message, refresh,
    }));
  }));

  server.registerTool('watch_create', {
    title: 'Create a watch for work', description: 'Create a dedicated HTTP watch and attach it to an open work record. Preview first. It checks with existing free deterministic rules; Dots judges relevance from frozen evidence. Notifications go only through work.attention, never create Tasks. Retry with the same request_id and settings.',
    inputSchema: z.strictObject({ work_id: workIdSchema, request_id: z.uuid(), ...settings }), annotations: write,
  }, input => answer('WATCH', async () => {
    let current = work.get({ work_id: input.work_id }).work;
    if (!['active', 'waiting'].includes(current.state)) workError('WORK_CLOSED', 'Create watches only for open work.');
    const expectedName = `watches/w-${input.request_id}`;
    if (current.links.length >= 32 && !current.links.some(link => link.type === 'watch' && link.ref === expectedName))
      workError('WORK_LINK_LIMIT', 'This work already has 32 links. Review them before creating another watch.');
    await beforeCreate();
    const { work_id, request_id, ...config } = input;
    const saved = await client.createWatch({ requestId: request_id, watchId: `w-${request_id}`,
      watch: fromWire(WatchSchema, { ...config, notify_policy: 'none' }, { strict: true }).message });
    current = work.get({ work_id }).work;
    if (!current.links.some(link => link.type === 'watch' && link.ref === saved.name)) {
      try {
        work.checkpoint({ work_id, request_id, etag: current.etag, changes: {
          links: [...current.links, { type: 'watch', ref: saved.name, label: saved.displayName, owned: true }],
        } });
      } catch {
        // If the work closed while the source request ran, stop only this newly created dedicated watch.
        await client.pauseWatch({ name: saved.name, requestId: crypto.randomUUID() });
        workError('WATCH_LINK_FAILED', `Could not attach ${saved.name}. Its pause was requested; read watch_get to confirm before continuing.`);
      }
    }
    return { watch: toWire(WatchSchema, saved), work_id, linked: true };
  }));

  server.registerTool('watch_update', {
    title: 'Update watch', description: 'Change only the supplied settings using the current watch etag. Existing notification policy and unrelated settings are preserved. Source changes follow Watch’s native baseline rules; intent changes alone do not reset the comparison.',
    inputSchema: z.strictObject({ name, request_id: z.uuid(), etag: z.string().min(1).max(100),
      changes: z.strictObject(settings).partial().refine(value => Object.keys(value).length > 0, 'Supply at least one setting.') }), annotations: write,
  }, input => answer('WATCH', async () => toWire(WatchSchema, await client.updateWatch(
    fromWire(UpdateWatchRequestSchema, {
      watch: { ...input.changes, name: input.name, etag: input.etag },
      update_mask: [...Object.keys(input.changes), 'etag'].join(','), request_id: input.request_id,
    }, { strict: true, partial: 'watch' }).message,
  ))));

  server.registerTool('watch_control', {
    title: 'Control watch', description: 'Pause, resume or request a source check. Pause dedicated watches before ending their work; only confirmed source state updates the owned link. Shared watches remain shared. Check respects source spacing and is not proof of a successful fetch.',
    inputSchema: z.strictObject({ name, action: z.enum(['pause', 'resume', 'check']), request_id: z.uuid(),
      etag: z.string().min(1).max(100).optional() })
      .refine(input => input.action === 'check' || !!input.etag, 'Pause and resume require the current etag.'), annotations: write,
  }, input => answer('WATCH', async () => {
    const request = { name: input.name, requestId: input.request_id, etag: input.etag ?? '' };
    const receipt = input.action === 'pause' ? await client.pauseWatch(request)
      : input.action === 'resume' ? await client.resumeWatch(request) : await client.checkWatch(request);
    // Mutation receipts are frozen for retries. Observe the current resource before recording that it is stopped.
    const saved = input.action === 'check' ? receipt : await client.getWatch({ name: input.name });
    if (input.action === 'pause' && saved.state !== Watch_State.PAUSED
      || input.action === 'resume' && saved.state !== Watch_State.ACTIVE)
      workError('WATCH_STATE_UNCONFIRMED', 'The source did not confirm the requested state. Read watch_get before continuing.');
    if (input.action !== 'check') for (const workId of work.linkedWorkIds('watch', saved.name)) {
      const current = work.get({ work_id: workId }).work;
      const owned = current.links.find(link => link.type === 'watch' && link.ref === saved.name && link.owned);
      if (!owned) continue;
      const stopped = input.action === 'pause';
      const links = current.links.map(link => link === owned ? { ...link,
        stop_state: stopped ? 'stopped' as const : 'unconfirmed' as const,
        observed_at: stopped ? new Date().toISOString() : null,
        observation: stopped ? 'Watch PauseWatch confirmed the paused state.' : '',
      } : link);
      if (owned.stop_state === (stopped ? 'stopped' : 'unconfirmed')) continue;
      work.checkpoint({ work_id: workId, request_id: crypto.randomUUID(), etag: current.etag, changes: { links } });
    }
    return toWire(WatchSchema, saved);
  }));

  server.registerTool('watch_changes', {
    title: 'Read watch change evidence', description: 'Read one change by name, or one page of changes for a watch. Compare before_context and after_context with the work goal. Save relevant/irrelevant/uncertain and the reason in a work_checkpoint watch_review entry. Missing or truncated evidence can require an uncertain verdict; do not add automatic ignore rules.',
    inputSchema: z.strictObject({ name: changeName.optional(), parent: z.union([name, z.literal('watches/-')]).default('watches/-'),
      page_size: z.number().int().min(1).max(50).default(20), page_token: z.string().max(4096).default('') }), annotations: readOnly,
  }, input => answer('WATCH', async () => {
    if (input.name) {
      return changeEvidence(await client.getChange({ name: input.name }));
    }
    const page = await client.listChanges({ parent: input.parent, pageSize: input.page_size, pageToken: input.page_token });
    return { ...toWire(ListChangesResponseSchema, page), changes: page.changes.map(changeEvidence) };
  }));
}

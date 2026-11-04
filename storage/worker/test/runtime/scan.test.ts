import { afterEach, expect, it } from 'vitest';
import { harness } from './harness.ts';

interface Totals { readonly object_count?: number; readonly total_bytes?: number; readonly recent_object_count?: number; readonly recent_bytes?: number }
interface Scan extends Totals {
  readonly state: string; readonly start_time: string; readonly end_time?: string; readonly page_count?: number; readonly run_count?: number;
  readonly namespaces?: readonly (Totals & { readonly namespace: string; readonly folders?: readonly (Totals & { readonly folder?: string })[] })[];
}
interface Overview { readonly settings: { readonly last_provider_error?: string }; readonly object_scan?: Scan }

let current: Awaited<ReturnType<typeof harness>> | undefined;
afterEach(async () => { await current?.dispose(); current = undefined; });

it('counts every namespace in a Durable Object alarm and changes no file', async () => {
  current = await harness();
  await current.connect();
  const recent = new Date().toISOString();
  let total = 0;
  let sealed = 0;
  for (let index = 0; index < 2400; index++) {
    const block = index % 3 === 0;
    const path = '/namespaces/alpha/' + (block ? 'blocks/sealed/' : 'tables/') + String(index).padStart(5, '0');
    current.provider.files.set(path, { bytes: new Uint8Array(index % 7), revision: 'rev' + String(index), ...(block ? { modified: recent } : {}) });
    total += index % 7;
    if (block) sealed += index % 7;
  }
  current.provider.files.set('/namespaces/beta/one.bin', { bytes: new Uint8Array(9), revision: 'revb' });
  const before = current.provider.calls.length;

  const started = await current.owner('objectScan:start', 'POST', {});
  expect(started.status).toBe(200);
  expect(await started.json<Scan>()).toMatchObject({ state: 'running' });
  let overview: Overview | undefined;
  for (let attempt = 0; attempt < 200; attempt++) {
    overview = await (await current.owner('overview')).json<Overview>();
    if (overview.object_scan?.state !== 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  expect(overview?.object_scan).toMatchObject({ state: 'succeeded', page_count: 3, run_count: 1, object_count: 2401, total_bytes: total + 9 });
  expect(overview?.object_scan?.namespaces).toEqual([
    {
      namespace: 'alpha', object_count: 2400, total_bytes: total, recent_object_count: 800, recent_bytes: sealed, folders: [
        { folder: 'tables', object_count: 1600, total_bytes: total - sealed },
        { folder: 'blocks', object_count: 800, total_bytes: sealed, recent_object_count: 800, recent_bytes: sealed },
      ],
    },
    { namespace: 'beta', object_count: 1, total_bytes: 9, folders: [{ object_count: 1, total_bytes: 9 }] },
  ]);
  // Only listings: the scan never writes, moves or deletes a file.
  expect(current.provider.calls.slice(before).map((call) => call.path)).toEqual(['/2/files/list_folder', '/2/files/list_folder/continue', '/2/files/list_folder/continue']);
  expect(current.provider.files.size).toBe(2401);
  expect(overview?.settings.last_provider_error).toBeUndefined();
  // A scan needs the connection.
  expect((await current.owner('dropbox:disconnect', 'POST', {})).status).toBe(200);
  expect((await current.owner('objectScan:start', 'POST', {})).status).toBe(400);
});

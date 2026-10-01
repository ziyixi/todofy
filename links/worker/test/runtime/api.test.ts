/**
 * The owner API (LinksUiService, src/api.ts and store.ts) in workerd with real D1: create, get, list with filters and
 * page tokens, update with masks and etags, soft delete with undelete and the lazy purge, revisions and rollback,
 * request_id replays, import and export, the store's bound, and the transport's edges (CSRF, Status errors).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createLink, op, reasonOf, startHarness, type Harness, type WireLink } from './harness.ts';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.dispose();
});
beforeEach(async () => {
  await h.reset();
});

interface ListAnswer {
  links?: WireLink[];
  next_page_token?: string;
}

const keys = (answer: ListAnswer) => (answer.links ?? []).map((link) => link.name);

describe('create and get', () => {
  it('stores the key in lower case with the defaults, as revision 1', async () => {
    const created = await createLink(h, 'GitHub', { target: 'https://github.com', tags: ['Dev', 'git'] });
    expect(created).toMatchObject({ name: 'links/github', target: 'https://github.com/', path_mode: 'exact', visibility: 'private', tags: ['dev', 'git'], revision_id: '1' });
    expect(created.etag).toMatch(/^[0-9a-f]{16}$/);
    const got = await h.get<WireLink>('/_/api/v1/links/GITHUB');
    expect(got.status).toBe(200);
    expect(got.body).toEqual(created);
    expect(await h.sql('SELECT key, revision FROM link_revisions')).toEqual([{ key: 'github', revision: 1 }]);
  });

  it('refuses invalid and reserved keys, bad targets and bad values', async () => {
    const create = (key: string, link: unknown) => h.mutate('POST', `/_/api/v1/links?link_id=${encodeURIComponent(key)}`, link);
    expect(reasonOf((await create('-x', { target: 'https://a.example/' })).body)).toBe('INVALID_KEY');
    expect(reasonOf((await create('api', { target: 'https://a.example/' })).body)).toBe('RESERVED_KEY');
    expect(reasonOf((await create('ok', { target: 'http://a.example/' })).body)).toBe('INVALID_TARGET');
    expect(reasonOf((await create('ok', { target: 'https://s.example.com/x' })).body)).toBe('INVALID_TARGET');
    expect(reasonOf((await create('ok', { target: 'https://a.example/', path_mode: 'template' })).body)).toBe('INVALID_TARGET');
    expect(reasonOf((await create('ok', { target: 'https://a.example/', tags: ['bad tag'] })).body)).toBe('BAD_REQUEST');
    expect(reasonOf((await create('ok', { target: 'https://a.example/', description: 'x'.repeat(501) })).body)).toBe('BAD_REQUEST');
    expect(reasonOf((await create('ok', { target: 'https://a.example/', colour: 'red' })).body)).toBe('BAD_REQUEST');
    expect(reasonOf((await create('ok', {})).body)).toBe('BAD_REQUEST');
    expect(await h.sql('SELECT key FROM links')).toEqual([]);
  });

  it('answers LINK_EXISTS with the link that holds the key, live or deleted', async () => {
    const first = await createLink(h, 'a', { target: 'https://a.example/' });
    const again = await h.mutate('POST', '/_/api/v1/links?link_id=A', { target: 'https://b.example/' });
    expect(again.status).toBe(409);
    expect(reasonOf(again.body)).toBe('LINK_EXISTS');
    expect(JSON.stringify(again.body)).toContain('"type.googleapis.com/links.ui.v1.Link"');
    await h.mutate('DELETE', `/_/api/v1/links/a?etag=${first.etag ?? ''}`);
    const deleted = await h.mutate('POST', '/_/api/v1/links?link_id=a', { target: 'https://b.example/' });
    expect(reasonOf(deleted.body)).toBe('LINK_EXISTS');
    expect(JSON.stringify(deleted.body)).toContain('"delete_time"');
  });

  it('answers NOT_FOUND for a key no link holds', async () => {
    expect(reasonOf((await h.get('/_/api/v1/links/nope')).body)).toBe('NOT_FOUND');
    expect(reasonOf((await h.get('/_/api/v1/links/api')).body)).toBe('NOT_FOUND');
    expect(reasonOf((await h.get('/_/api/v1/links/a_b')).body)).toBe('INVALID_KEY');
  });
});

describe('list', () => {
  it('pages in key order with tokens bound to the filter, and filters by literals', async () => {
    for (const key of ['c', 'a', 'b', 'd']) await createLink(h, key, { target: `https://${key}.example/`, description: key === 'b' ? 'The Docs' : '' , tags: key === 'd' ? ['docs'] : [] });
    const first = await h.get<ListAnswer>('/_/api/v1/links?page_size=2');
    expect(keys(first.body)).toEqual(['links/a', 'links/b']);
    const token = first.body.next_page_token ?? '';
    expect(token).not.toBe('');
    const second = await h.get<ListAnswer>(`/_/api/v1/links?page_size=2&page_token=${token}`);
    expect(keys(second.body)).toEqual(['links/c', 'links/d']);
    expect(second.body.next_page_token).toBeUndefined();
    expect(reasonOf((await h.get(`/_/api/v1/links?page_token=${token}&filter=docs`)).body)).toBe('BAD_REQUEST');
    expect(keys((await h.get<ListAnswer>(`/_/api/v1/links?filter=${encodeURIComponent('DOCS')}`)).body)).toEqual(['links/b', 'links/d']);
    expect(keys((await h.get<ListAnswer>(`/_/api/v1/links?filter=${encodeURIComponent('"c.example"')}`)).body)).toEqual(['links/c']);
    expect(reasonOf((await h.get(`/_/api/v1/links?filter=${encodeURIComponent('a OR b')}`)).body)).toBe('BAD_REQUEST');
    expect(reasonOf((await h.get('/_/api/v1/links?page_size=-1')).body)).toBe('BAD_REQUEST');
  });

  it('lists deleted links only with show_deleted, and purges them once due', async () => {
    const link = await createLink(h, 'a', { target: 'https://a.example/' });
    await createLink(h, 'b', { target: 'https://b.example/' });
    const deleted = await h.mutate<WireLink>('DELETE', `/_/api/v1/links/a?etag=${link.etag ?? ''}`);
    expect(deleted.body.delete_time).toBeDefined();
    expect(Date.parse(deleted.body.purge_time ?? '') - Date.parse(deleted.body.delete_time ?? '')).toBe(30 * 86_400_000);
    expect(keys((await h.get<ListAnswer>('/_/api/v1/links')).body)).toEqual(['links/b']);
    expect(keys((await h.get<ListAnswer>('/_/api/v1/links?show_deleted=true')).body)).toEqual(['links/a', 'links/b']);
    // Thirty days later (the purge time moved into the past): the next list purges it and its revisions.
    await h.sql('UPDATE links SET purge_time = ? WHERE key = ?', Date.now() - 1, 'a');
    expect(reasonOf((await h.get('/_/api/v1/links/a')).body)).toBe('NOT_FOUND');
    expect(keys((await h.get<ListAnswer>('/_/api/v1/links?show_deleted=true')).body)).toEqual(['links/b']);
    expect(await h.sql('SELECT key FROM links')).toEqual([{ key: 'b' }]);
    expect(await h.sql('SELECT key FROM link_revisions')).toEqual([{ key: 'b' }]);
    // The key is free again.
    await createLink(h, 'a', { target: 'https://a2.example/' });
  });
});

describe('update', () => {
  it('replaces the masked fields only, as a new revision, and checks the etag', async () => {
    const link = await createLink(h, 'a', { target: 'https://a.example/', description: 'one', visibility: 'public' });
    const updated = await h.mutate<WireLink>('PATCH', '/_/api/v1/links/a?update_mask=description', { description: 'two', target: 'https://ignored.example/' });
    expect(updated.body).toMatchObject({ target: 'https://a.example/', description: 'two', visibility: 'public', revision_id: '2' });
    expect(updated.body.etag).not.toBe(link.etag);
    const stale = await h.mutate('PATCH', '/_/api/v1/links/a', { target: 'https://b.example/', etag: link.etag });
    expect(stale.status).toBe(409);
    expect(reasonOf(stale.body)).toBe('ETAG_MISMATCH');
    expect(JSON.stringify(stale.body)).toContain('"description":"two"');
    // A full replacement with the current etag: unset fields go back to their defaults.
    const full = await h.mutate<WireLink>('PATCH', '/_/api/v1/links/a', { target: 'https://b.example/', etag: updated.body.etag });
    expect(full.body).toMatchObject({ target: 'https://b.example/', visibility: 'private', revision_id: '3' });
    expect(full.body.description).toBeUndefined();
  });

  it('writes nothing when nothing changes, and checks the target against the new mode', async () => {
    const link = await createLink(h, 'a', { target: 'https://a.example/' });
    const same = await h.mutate<WireLink>('PATCH', '/_/api/v1/links/a?update_mask=target', { target: 'https://a.example' });
    expect(same.body.etag).toBe(link.etag);
    expect(same.body.revision_id).toBe('1');
    expect(reasonOf((await h.mutate('PATCH', '/_/api/v1/links/a?update_mask=path_mode', { path_mode: 'template' })).body)).toBe('INVALID_TARGET');
    expect(reasonOf((await h.mutate('PATCH', '/_/api/v1/links/a?update_mask=colour', {})).body)).toBe('BAD_REQUEST');
    expect(reasonOf((await h.mutate('PATCH', '/_/api/v1/links/nope', { target: 'https://a.example/' })).body)).toBe('NOT_FOUND');
  });

  it('refuses to change a deleted link', async () => {
    const link = await createLink(h, 'a', { target: 'https://a.example/' });
    await h.mutate('DELETE', `/_/api/v1/links/a?etag=${link.etag ?? ''}`);
    const patched = await h.mutate('PATCH', '/_/api/v1/links/a', { target: 'https://b.example/' });
    expect([patched.status, reasonOf(patched.body)]).toEqual([400, 'LINK_DELETED']);
    // AIP-164: deleting a deleted resource is NOT_FOUND (no allow_missing); the deleted link comes as a detail.
    const again = await h.mutate('DELETE', '/_/api/v1/links/a');
    expect([again.status, reasonOf(again.body)]).toEqual([404, 'NOT_FOUND']);
    expect(JSON.stringify(again.body)).toContain('"delete_time"');
    const rolled = await h.mutate('POST', '/_/api/v1/links/a:rollback', { revision_id: '1' });
    expect([rolled.status, reasonOf(rolled.body)]).toEqual([400, 'LINK_DELETED']);
  });
});

describe('delete, undelete, revisions and rollback (the launcher undo)', () => {
  it('undoes a delete with UndeleteLink', async () => {
    const link = await createLink(h, 'a', { target: 'https://a.example/', visibility: 'public' });
    expect(reasonOf((await h.mutate('DELETE', '/_/api/v1/links/a?etag=0000000000000000')).body)).toBe('ETAG_MISMATCH');
    const deleted = await h.mutate<WireLink>('DELETE', `/_/api/v1/links/a?etag=${link.etag ?? ''}`);
    expect((await h.fetch('/a')).headers.get('location')).toBe('/_/k/a');
    expect(reasonOf((await h.mutate('POST', '/_/api/v1/links/b:undelete', {})).body)).toBe('NOT_FOUND');
    const restored = await h.mutate<WireLink>('POST', '/_/api/v1/links/a:undelete', { etag: deleted.body.etag });
    expect(restored.status).toBe(200);
    expect(restored.body.delete_time).toBeUndefined();
    expect(restored.body.revision_id).toBe('1');
    expect((await h.fetch('/a')).headers.get('location')).toBe('https://a.example/');
    // AIP-164: undeleting a resource that is not deleted is ALREADY_EXISTS (409).
    const live = await h.mutate('POST', '/_/api/v1/links/a:undelete', {});
    expect([live.status, reasonOf(live.body)]).toEqual([409, 'NOT_DELETED']);
    expect(JSON.stringify(live.body)).toContain('"type.googleapis.com/links.ui.v1.Link"');
  });

  it('keeps the last 20 revisions newest first and rolls back to one as a new revision', async () => {
    await createLink(h, 'a', { target: 'https://example.com/0' });
    for (let n = 1; n <= 22; n += 1) await h.mutate('PATCH', '/_/api/v1/links/a?update_mask=target', { target: `https://example.com/${String(n)}` });
    const page = await h.get<ListAnswer & { links: WireLink[] }>('/_/api/v1/links/a:listRevisions?page_size=5');
    expect(page.body.links.map((link) => [link.revision_id, link.target])).toEqual([
      ['23', 'https://example.com/22'],
      ['22', 'https://example.com/21'],
      ['21', 'https://example.com/20'],
      ['20', 'https://example.com/19'],
      ['19', 'https://example.com/18'],
    ]);
    const rest = await h.get<ListAnswer & { links: WireLink[] }>(`/_/api/v1/links/a:listRevisions?page_token=${page.body.next_page_token ?? ''}`);
    expect(rest.body.links.map((link) => link.revision_id)).toEqual(Array.from({ length: 15 }, (_, i) => String(18 - i)));
    expect(rest.body.next_page_token).toBeUndefined();
    expect(reasonOf((await h.mutate('POST', '/_/api/v1/links/a:rollback', { revision_id: '3' })).body)).toBe('REVISION_NOT_FOUND');
    expect(reasonOf((await h.mutate('POST', '/_/api/v1/links/a:rollback', { revision_id: 'x' })).body)).toBe('REVISION_NOT_FOUND');
    const rolled = await h.mutate<WireLink>('POST', '/_/api/v1/links/a:rollback', { revision_id: '22' });
    expect(rolled.body).toMatchObject({ target: 'https://example.com/21', revision_id: '24' });
    expect((await h.sql<{ n: number }>("SELECT COUNT(*) AS n FROM link_revisions WHERE key = 'a'"))[0]?.n).toBe(20);
  });
});

describe('request IDs (AIP-155)', () => {
  it('answer a repeated mutation with its first response and change nothing', async () => {
    const id = op();
    const first = await h.mutate<WireLink>('POST', `/_/api/v1/links?link_id=a&request_id=${id}`, { target: 'https://a.example/' });
    const before = await h.snapshot();
    const again = await h.mutate<WireLink>('POST', `/_/api/v1/links?link_id=a&request_id=${id}`, { target: 'https://a.example/' });
    expect(again.status).toBe(200);
    expect(again.body).toEqual(first.body);
    expect(await h.snapshot()).toBe(before);
    const deleteId = op();
    const deleted = await h.mutate<WireLink>('DELETE', `/_/api/v1/links/a?request_id=${deleteId}`);
    const repeated = await h.mutate<WireLink>('DELETE', `/_/api/v1/links/a?request_id=${deleteId}`);
    expect(repeated.body).toEqual(deleted.body);
    expect(reasonOf((await h.mutate('POST', '/_/api/v1/links?link_id=b&request_id=not-a-uuid', { target: 'https://a.example/' })).body)).toBe('BAD_REQUEST');
  });

  it('are forgotten after a day, by the next write', async () => {
    const id = op();
    await h.mutate('POST', `/_/api/v1/links?link_id=a&request_id=${id}`, { target: 'https://a.example/' });
    await h.sql('UPDATE request_log SET create_time = ?', Date.now() - 86_400_001);
    await createLink(h, 'b', { target: 'https://b.example/' });
    expect(await h.sql('SELECT request_id FROM request_log')).toHaveLength(1);
  });
});

describe('import and export', () => {
  it('round-trips every live link as JSON Lines', async () => {
    await createLink(h, 'a', { target: 'https://a.example/', visibility: 'public', tags: ['x'], expire_time: '2030-01-01T00:00:00Z' });
    await createLink(h, 'b', { target: 'https://b.example/{path}', path_mode: 'template', description: 'B' });
    const gone = await createLink(h, 'c', { target: 'https://c.example/' });
    await h.mutate('DELETE', `/_/api/v1/links/c?etag=${gone.etag ?? ''}`);
    const exported = await h.get<{ lines: string[] }>('/_/api/v1/links:export');
    expect(exported.body.lines).toHaveLength(2);
    // Pages, as the launcher reads them for a large store.
    const first = await h.get<{ lines: string[]; next_page_token: string }>('/_/api/v1/links:export?page_size=1');
    expect(first.body.lines).toHaveLength(1);
    const second = await h.get<{ lines: string[]; next_page_token?: string }>(`/_/api/v1/links:export?page_size=1&page_token=${first.body.next_page_token}`);
    expect(second.body.next_page_token).toBeUndefined();
    expect([...first.body.lines, ...second.body.lines]).toEqual(exported.body.lines);
    const content = exported.body.lines.map((line) => `${line}\n`).join('');
    const lines = exported.body.lines.map((line) => JSON.parse(line) as WireLink);
    expect(lines.map((link) => link.name)).toEqual(['links/a', 'links/b']);
    await h.reset();
    const imported = await h.mutate<{ created_count?: number; skipped_count?: number }>('POST', '/_/api/v1/links:import', { content, request_id: op() });
    expect(imported.body).toEqual({ created_count: 2 });
    const again = await h.get<{ lines: string[] }>('/_/api/v1/links:export');
    const strip = (all: string[]) => all.map((line) => {
      const { target, path_mode, visibility, description, tags, expire_time, name } = JSON.parse(line) as WireLink;
      return { name, target, path_mode, visibility, description, tags, expire_time };
    });
    expect(strip(again.body.lines)).toEqual(strip(exported.body.lines));
  });

  it('reports each skipped line, replaces only with overwrite, and refuses oversized requests', async () => {
    await createLink(h, 'live', { target: 'https://live.example/' });
    const gone = await createLink(h, 'gone', { target: 'https://gone.example/' });
    await h.mutate('DELETE', `/_/api/v1/links/gone?etag=${gone.etag ?? ''}`);
    const content = [
      '{"name":"links/new","target":"https://new.example/"}',
      '',
      'not json',
      '{"name":"links/live","target":"https://live2.example/"}',
      '{"name":"links/gone","target":"https://x.example/"}',
      '{"name":"links/bad_key","target":"https://x.example/"}',
      '{"name":"links/api","target":"https://x.example/"}',
      '{"name":"links/new","target":"https://dup.example/"}',
      '{"name":"links/http","target":"http://x.example/"}',
      '{"name":"links/odd","target":"https://x.example/","colour":"red"}',
    ].join('\n');
    const answer = await h.mutate<{ created_count?: number; replaced_count?: number; skipped_count: number; problems: { line_number: number; reason: string }[] }>(
      'POST',
      '/_/api/v1/links:import',
      { content },
    );
    expect(answer.body.created_count).toBe(1);
    expect(answer.body.problems).toEqual([
      { line_number: 3, reason: 'invalid_line' },
      { line_number: 4, reason: 'link_exists' },
      { line_number: 5, reason: 'link_deleted' },
      { line_number: 6, reason: 'invalid_key' },
      { line_number: 7, reason: 'reserved_key' },
      { line_number: 8, reason: 'duplicate_key' },
      { line_number: 9, reason: 'invalid_value' },
      { line_number: 10, reason: 'invalid_line' },
    ]);
    const overwrite = await h.mutate<{ replaced_count?: number }>('POST', '/_/api/v1/links:import', { content: '{"name":"links/live","target":"https://live2.example/"}', overwrite: true });
    expect(overwrite.body.replaced_count).toBe(1);
    const live = await h.get<WireLink>('/_/api/v1/links/live');
    expect(live.body).toMatchObject({ target: 'https://live2.example/', revision_id: '2' });
    expect(await h.sql("SELECT revision FROM link_revisions WHERE key = 'live' ORDER BY revision")).toEqual([{ revision: 1 }, { revision: 2 }]);
    const tooMany = Array.from({ length: 101 }, (_, n) => `{"name":"links/k${String(n)}","target":"https://x.example/"}`).join('\n');
    expect(reasonOf((await h.mutate('POST', '/_/api/v1/links:import', { content: tooMany })).body)).toBe('BAD_REQUEST');
  });
});

describe('the store bound', () => {
  it('refuses a new link once LINKS_MAX links (deleted ones included) exist', async () => {
    const rows = Array.from({ length: 1000 }, (_, n) => ({ k: `k${String(n)}` }));
    await h.sql(
      `INSERT INTO links (key, target, path_mode, visibility, description, tags, expire_time, create_time, update_time, delete_time, purge_time, revision, revision_time, etag)
       SELECT j.value->>'k', 'https://x.example/', 'exact', 'private', '', '[]', NULL, 0, 0, NULL, NULL, 1, 0, 'e' FROM json_each(?) AS j`,
      JSON.stringify(rows),
    );
    const full = await h.mutate('POST', '/_/api/v1/links?link_id=one-more', { target: 'https://x.example/' });
    expect(full.status).toBe(400);
    expect(reasonOf(full.body)).toBe('LINKS_FULL');
    const imported = await h.mutate<{ problems: { reason: string }[] }>('POST', '/_/api/v1/links:import', { content: '{"name":"links/one-more","target":"https://x.example/"}' });
    expect(imported.body.problems).toEqual([{ line_number: 1, reason: 'links_full' }]);
  });
});

describe('the transport', () => {
  it('needs the CSRF token and the same Origin for every mutation, checked before the body', async () => {
    const noToken = await h.fetch('/_/api/v1/links?link_id=a', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1' }, body: '{"target":"https://a.example/"}' });
    expect(noToken.status).toBe(403);
    expect(reasonOf(await noToken.json())).toBe('CSRF_FAILED');
    const csrf = await h.fetch('/_/api/csrf');
    const token = (await csrf.json<{ token: string }>()).token;
    const cookie = (csrf.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    expect(cookie).toMatch(/^links_csrf=/);
    const otherOrigin = await h.fetch('/_/api/v1/links?link_id=a', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example', 'x-csrf-token': token, cookie },
      body: '{"target":"https://a.example/"}',
    });
    expect(reasonOf(await otherOrigin.json())).toBe('CSRF_FAILED');
    expect(await h.sql('SELECT key FROM links')).toEqual([]);
  });

  it('answers Status errors with the Chinese copy, 405 with Allow, and logs only ID, status and reason', async () => {
    const lines = h.logs.length;
    const missing = await h.fetch('/_/api/v1/nothing');
    expect(missing.status).toBe(404);
    const body = await missing.json<{ error: { details: Record<string, string>[] } }>();
    expect(body.error.details).toContainEqual({ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'NOT_FOUND', domain: 's.ziyixi.science' });
    expect(body.error.details).toContainEqual({ '@type': 'type.googleapis.com/google.rpc.LocalizedMessage', locale: 'zh-CN', message: '找不到这个短链接' });
    const put = await h.fetch('/_/api/v1/links/a', { method: 'PUT' });
    expect(put.status).toBe(405);
    expect(put.headers.get('allow')).toBe('GET, HEAD, PATCH, DELETE, OPTIONS');
    await h.get('/_/api/v1/links/secret-key-name');
    const logged = h.logs.slice(lines);
    expect(logged.length).toBeGreaterThan(0);
    for (const line of logged) {
      expect(Object.keys(JSON.parse(line) as object).sort()).toEqual(['reason', 'request_id', 'status']);
      expect(line).not.toContain('secret-key-name');
    }
  });

  it('answers a failed D1 call UNAVAILABLE, never with what failed', async () => {
    await h.sql('ALTER TABLE links RENAME TO links_gone');
    try {
      const failed = await h.get('/_/api/v1/links');
      expect(failed.status).toBe(503);
      expect(reasonOf(failed.body)).toBe('UNAVAILABLE');
      expect(JSON.stringify(failed.body)).not.toContain('links_gone');
      const redirect = await h.fetch('/a');
      expect(redirect.status).toBe(503);
      expect(redirect.headers.get('retry-after')).toBe('5');
    } finally {
      await h.sql('ALTER TABLE links_gone RENAME TO links');
    }
  });
});

describe('the launcher pages', () => {
  it('serve the page at /_/ and for a key that does not resolve, and redirect a live one', async () => {
    await createLink(h, 'a', { target: 'https://a.example/', path_mode: 'append' });
    const page = await h.fetch('/_/');
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<div id="app">');
    expect(page.headers.get('cache-control')).toBe('private, no-store');
    expect(await (await h.fetch('/_/k/nope')).text()).toContain('<div id="app">');
    expect((await h.fetch('/_/k/a/x')).headers.get('location')).toBe('https://a.example/x');
    expect((await h.fetch('/_/k/A+')).status).toBe(200);
    expect(reasonOf(await (await h.fetch('/_/other')).json())).toBe('NOT_FOUND');
    expect((await h.fetch('/_/', { method: 'POST' })).status).toBe(405);
  });
});

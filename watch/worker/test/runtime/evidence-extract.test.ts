import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import type { CaptureDocument } from '../../src/evidence-extract.ts';

let mf: Miniflare;
beforeAll(async () => {
  const bundle = await build({
    ...(process.env.TEST_SRCDIR ? { nodePaths: [`${process.cwd()}/node_modules`] } : {}), entryPoints: ['test/stubs/evidence-probe.ts'], bundle: true, write: false, format: 'esm',
    platform: 'browser', target: 'es2024', mainFields: ['browser', 'module', 'main'], external: ['node:buffer'], logLevel: 'silent' });
  const script = bundle.outputFiles[0]?.text;
  if (!script) throw new Error('missing evidence test bundle');
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script, compatibilityDate: '2026-09-08',
    compatibilityFlags: ['nodejs_compat'], outboundService: () => new Response('synthetic_only', { status: 502 }) }));
});
afterAll(async () => { await mf.dispose(); });

const extract = async (input: unknown) => (await mf.dispatchFetch('https://probe.invalid/extract', { method: 'POST', body: JSON.stringify(input) })).json() as Promise<CaptureDocument>;
interface BrowserProbe {
  result: { kind: string; failure?: string; refusal?: { kind: string }; finalUrl?: string; evidence?: CaptureDocument; browserMs?: number };
  admitted: string[]; denied: string[]; gates: string[]; closed: boolean; viewport: unknown; screenshotOptions: unknown;
  launches: number;
  error?: string;
}
const render = async (input: unknown = {}) => (await mf.dispatchFetch('https://probe.invalid/browser', { method: 'POST', body: JSON.stringify(input) })).json() as Promise<BrowserProbe>;

describe('unmasked native page evidence', () => {
  it('keeps title, heading, list, table, relative links and metadata without script text', async () => {
    const result = await extract({ html: '<html><head><title>中文 &amp; release</title><meta name="description" content="A useful page"></head><body><h1>Version 123</h1><ul><li>One</li><li>Two</li></ul><table><tr><th>Name</th><th>Price</th></tr><tr><td>Tea</td><td>¥123.45</td></tr></table><a href="/details">Details</a><script>ignore_this()</script><img src="/photo.jpg" alt="Product"></body></html>' });
    expect(result.title).toBe('中文 & release');
    expect(result.markdown).toContain('# Version 123');
    expect(result.markdown).toContain('- One');
    expect(result.markdown).toContain('| Name | Price |');
    expect(result.markdown).toContain('| --- | --- |');
    expect(result.markdown).toContain('¥123.45');
    expect(result.markdown).toContain('[Details](https://page.example.com/details)');
    expect(result.markdown).toContain('![Product](https://page.example.com/photo.jpg)');
    expect(result.markdown).not.toContain('ignore_this');
    expect(result.links).toContainEqual({ text: 'Details', url: 'https://page.example.com/details' });
    expect(result.metadata).toContainEqual({ name: 'description', content: 'A useful page' });
    expect(result.errors).toEqual([]);
  });

  it('respects selected regions and excludes without masks or permanent ignore rules', async () => {
    const result = await extract({ html: '<html><body><p>Outside</p><nav><div id="chosen"><h2>Price 999</h2><p class="ad">Advertisement</p><p>10 minutes ago</p></div></nav></body></html>',
      source: { kind: 'html', include: ['#chosen'], exclude: ['.ad'], keepLinks: false, keepLandmarks: false } });
    expect(result.markdown).toContain('Price 999');
    expect(result.markdown).toContain('10 minutes ago');
    expect(result.markdown).not.toContain('Outside');
    expect(result.markdown).not.toContain('Advertisement');
  });

  it('keeps original Markdown and UTF-8 truncation boundaries', async () => {
    const markdown = '# 标题\n\n- **版本 123** [详情](/details)\n\n' + '汉😀'.repeat(100_000);
    const result = await extract({ html: markdown, contentType: 'text/markdown' });
    expect(result.markdown).toContain('- **版本 123**');
    expect(result.links).toContainEqual({ text: '详情', url: 'https://page.example.com/details' });
    expect(new TextEncoder().encode(result.markdown).length).toBeLessThanOrEqual(256 * 1024);
    expect(result.markdown).not.toContain('\uFFFD');
    expect(result.truncated).toBe(true);
  });

  it('marks oversized input and deep hostile HTML explicitly', async () => {
    const large = await extract({ html: 'x'.repeat(2 * 1024 * 1024 + 1) });
    expect(large.truncated).toBe(true);
    expect(large.errors.length).toBeGreaterThan(0);
    const deep = await extract({ html: '<div>'.repeat(1000) + 'secret' + '</div>'.repeat(1000) });
    expect(deep.truncated).toBe(true);
    expect(deep.errors.length).toBeGreaterThan(0);
  });

  it('handles an omitted head end tag, self-closed SVG and an unmatched selection', async () => {
    const omitted = await extract({ html: '<html><head><title>Example</title><body><h1>Visible</h1><svg><path d="M0 0"/></svg><p>Still visible</p></body></html>' });
    expect(omitted.markdown).toContain('Visible');
    expect(omitted.markdown).toContain('Still visible');
    expect(omitted.errors).toEqual([]);
    const missing = await extract({ html: '<html><body><p>Nothing selected</p></body></html>',
      source: { kind: 'html', include: ['#missing'], exclude: [], keepLinks: true, keepLandmarks: false } });
    expect(missing.errors).toContain('SELECTOR_MISS');
  });

  it('bounds malformed Markdown link scans and preserves selected JSON values', async () => {
    const broken = await extract({ html: ']('.repeat(100_000), contentType: 'text/markdown' });
    expect(broken.links).toEqual([]);
    expect(broken.truncated).toBe(false);
    const json = await extract({ html: '{"price":123,"other":999}', contentType: 'application/json', source: { kind: 'json', path: '$.price' } });
    expect(json.markdown).toBe('123');
    expect(json.errors).toEqual([]);
  });
});

describe('real renderer with injected browser primitives', () => {
  it('captures text and a JPEG in one page session, then closes it', async () => {
    const response = await render();
    expect(response.result.kind).toBe('rendered');
    expect(response.result.evidence?.markdown).toContain('Version 12');
    expect(response.result.evidence?.screenshot).toMatchObject({ width: 3, height: 2, mimeType: 'image/jpeg' });
    expect(response.closed).toBe(true);
    expect(response.viewport).toEqual({ width: 1280, height: 960, deviceScaleFactor: 1 });
    expect(response.screenshotOptions).toMatchObject({ type: 'jpeg', quality: 65, fullPage: false });
    expect(response.gates).toHaveLength(2);
  });

  it('gates every main navigation and refuses a robots-disallowed redirect before sending it', async () => {
    const first = 'https://page.example.com/article';
    const second = 'https://other.example.com/private';
    const response = await render({ urls: [first, second], denyUrl: second });
    expect(response.result).toMatchObject({ kind: 'refused', refusal: { kind: 'robots' } });
    expect(response.admitted).toEqual([first]);
    expect(response.denied).toEqual([second]);
    expect(response.gates).toEqual([`enter:${first}:0:`, `leave:${first}`, `enter:${second}:1:${first}`]);
    expect(response.closed).toBe(true);
    expect(response.result.browserMs).toBe(15_000);
  });

  it('accepts a fragment-only SPA navigation and keeps the actual captured URL', async () => {
    const documentUrl = 'https://page.example.com/article#/release';
    const response = await render({ documentUrl });
    expect(response.result.kind).toBe('rendered');
    expect(response.result.finalUrl).toBe(documentUrl);
    expect(response.result.evidence?.finalUrl).toBe(documentUrl);
    expect(response.admitted).toEqual(['https://page.example.com/article']);
    expect(response.gates).toHaveLength(2);
    expect((await render({ documentUrl: 'https://page.example.com/unapproved' })).result)
      .toMatchObject({ kind: 'failed', failure: 'REDIRECT_REFUSED' });
  });

  it('does not allocate or charge a browser when initial URL policy rejects it', async () => {
    const response = await render({ url: 'https://127.0.0.1/private' });
    expect(response.result).toMatchObject({ kind: 'failed', failure: 'REDIRECT_REFUSED', browserMs: 0 });
    expect(response.launches).toBe(0);
    expect(response.gates).toEqual([]);
  });

  it('rejects own-zone and IP subresources while letting safe images and fonts load', async () => {
    const response = await render({ assets: ['https://cdn.example.com/photo.jpg', 'https://cdn.example.com/font.woff2', 'data:image/png;base64,AA==', 'blob:https://page.example.com/synthetic', 'http://127.0.0.1/private', 'https://watch.ziyixi.science/private'] });
    expect(response.admitted).toContain('https://cdn.example.com/photo.jpg');
    expect(response.admitted).toContain('https://cdn.example.com/font.woff2');
    expect(response.admitted).toContain('data:image/png;base64,AA==');
    expect(response.admitted).toContain('blob:https://page.example.com/synthetic');
    expect(response.denied).toEqual(['http://127.0.0.1/private', 'https://watch.ziyixi.science/private']);
  });

  it('renders a public iframe while checking every frame destination against URL policy', async () => {
    const response = await render({ frames: ['https://embed.example.com/chart', 'https://embed.example.com/redirected-chart',
      'https://watch.ziyixi.science/private', 'https://127.0.0.1/private'] });
    expect(response.result.kind).toBe('rendered');
    expect(response.admitted).toContain('https://embed.example.com/chart');
    expect(response.admitted).toContain('https://embed.example.com/redirected-chart');
    expect(response.denied).toEqual(['https://watch.ziyixi.science/private', 'https://127.0.0.1/private']);
    expect(response.gates).toEqual(['enter:https://page.example.com/article:0:', 'leave:https://page.example.com/article']);
  });

  it('keeps text when screenshot capture fails or exceeds the image cap', async () => {
    for (const input of [{ screenshotError: true }, { screenshotLarge: true }]) {
      const response = await render(input);
      expect(response.result.kind).toBe('rendered');
      expect(response.result.evidence?.markdown).toContain('Version 12');
      expect(response.result.evidence?.screenshot).toBeNull();
      expect(response.result.evidence?.errors).toContain('screenshotError' in input ? 'screenshot_failed' : 'too_large');
    }
  });

  it('reports oversized HTML, quota and timeout explicitly', async () => {
    expect((await render({ contentLarge: true })).result).toMatchObject({ kind: 'failed', failure: 'TOO_LARGE' });
    expect((await render({ quota: true })).result.kind).toBe('quota');
    const timeout = await render({ timeout: true });
    expect(timeout.result).toMatchObject({ kind: 'failed', failure: 'TIMEOUT' });
    expect(timeout.closed).toBe(true);
    expect((await render({ protocolTimeout: true })).result).toMatchObject({ kind: 'failed', failure: 'TIMEOUT' });
    const stalledClose = await render({ timeout: true, closeStalls: true });
    expect(stalledClose.result).toMatchObject({ kind: 'failed', failure: 'TIMEOUT' });
    const activeTimeout = await render({ timeoutWithNavigation: true });
    expect(activeTimeout.result).toMatchObject({ kind: 'failed', failure: 'TIMEOUT', browserMs: 15_000 });
    expect(activeTimeout.gates).toEqual(['enter:https://page.example.com/article:0:', 'leave:https://page.example.com/article']);
  });

  it('returns metered time with storage gate failures and still releases and closes', async () => {
    for (const input of [{ gateError: true }, { gateLeaveError: true }]) {
      const response = await render(input);
      expect(response.result).toMatchObject({ kind: 'failed', browserMs: 15_000 });
      expect(response.error).toBe('synthetic_storage_failure');
      expect(response.closed).toBe(true);
    }
  });
});

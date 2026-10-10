// The self-update check (src/update.ts): only a matching pair of BUILD and manifest.json naming a version that is not
// the running one is a new build. A half-written folder, a disagreement or the folder missing mid-swap is not.
import { describe, expect, it } from 'vitest';
import { installedUpdate } from '../src/update.ts';
import { harness } from './fake-chrome.ts';

const RUNNING = '2026.1010.900';
const NEWER = '2026.1011.1405';
const manifest = (version: string) => JSON.stringify({ manifest_version: 3, name: 'recall', version });

describe('installedUpdate', () => {
  it('is the new version when BUILD and manifest.json both name it', async () => {
    const { browser, ctx } = await harness();
    browser.files.set('BUILD', `${NEWER}\n`);
    browser.files.set('manifest.json', manifest(NEWER));
    expect(await installedUpdate(ctx)).toBe(NEWER);
  });

  it('is nothing while the pair names the running version', async () => {
    const { browser, ctx } = await harness();
    browser.files.set('BUILD', `${RUNNING}\n`);
    browser.files.set('manifest.json', manifest(RUNNING));
    expect(await installedUpdate(ctx)).toBeNull();
  });

  it('is nothing for a half-written folder, a disagreement or a folder missing mid-swap', async () => {
    const cases: [string, Record<string, string>][] = [
      ['no BUILD yet (written last)', { 'manifest.json': manifest(NEWER) }],
      ['a half-written BUILD', { BUILD: '2026.1011.14', 'manifest.json': manifest(NEWER) }],
      ['an empty BUILD', { BUILD: '', 'manifest.json': manifest(NEWER) }],
      ['BUILD ahead of manifest.json', { BUILD: NEWER, 'manifest.json': manifest(RUNNING) }],
      ['a half-written manifest.json', { BUILD: NEWER, 'manifest.json': manifest(NEWER).slice(0, 20) }],
      ['a manifest without a version', { BUILD: NEWER, 'manifest.json': '{"name":"recall"}' }],
      ['a version Chrome refuses', { BUILD: '2026.0105.0903', 'manifest.json': manifest('2026.0105.0903') }],
      ['the folder missing (between the two renames)', {}],
    ];
    for (const [name, files] of cases) {
      const { browser, ctx } = await harness();
      for (const [file, text] of Object.entries(files)) browser.files.set(file, text);
      expect(await installedUpdate(ctx), name).toBeNull();
    }
  });

  it('reads both files from the extension\'s own folder, uncached', async () => {
    const { browser, ctx } = await harness();
    const seen: { url: string; init?: RequestInit }[] = [];
    browser.files.set('BUILD', NEWER);
    browser.files.set('manifest.json', manifest(NEWER));
    const fetch = ctx.fetch;
    const watched = {
      ...ctx,
      fetch: (input: string | URL | Request, init?: RequestInit) => {
        seen.push({ url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, ...(init === undefined ? {} : { init }) });
        return fetch(input, init);
      },
    };
    expect(await installedUpdate(watched)).toBe(NEWER);
    expect(seen.map((request) => [request.url, request.init?.cache])).toEqual([
      ['chrome-extension://kpehdcbafdhgghclgaeigokjoceemfhj/BUILD', 'no-store'],
      ['chrome-extension://kpehdcbafdhgghclgaeigokjoceemfhj/manifest.json', 'no-store'],
    ]);
  });
});

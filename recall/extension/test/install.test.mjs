// The build (scripts/build.mjs) and install-extension's swap (scripts/install.mjs) in temporary folders: what a build
// holds, the capture script's result as executeScript sees it, the zip, a first install, an update through two renames
// with BUILD written last, and the folders it refuses.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContext, runInContext, runInNewContext } from 'node:vm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildExtension } from '../scripts/build.mjs';
import { checkBuild, installExtension } from '../scripts/install.mjs';
import { readZip, writeZip } from '../scripts/zip.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'recall-extension-test-'));
let built;

beforeAll(async () => {
  built = await buildExtension({ dist: join(scratch, 'dist'), time: new Date('2026-01-05T09:03:00Z'), commit: 'abc1234def' });
}, 60_000);

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** A copy of the build, unpacked from its zip, with another version (a later build). */
function laterBuild(version) {
  const folder = mkdtempSync(join(scratch, 'later-'));
  for (const { name, data } of readZip(readFileSync(built.zip))) {
    mkdirSync(join(folder, name, '..'), { recursive: true });
    writeFileSync(join(folder, name), data);
  }
  const manifest = JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8'));
  writeFileSync(join(folder, 'manifest.json'), JSON.stringify({ ...manifest, version }));
  return folder;
}

describe('the build', () => {
  it('holds the extension\'s files, its version and commit, no BUILD and no protobuf code', () => {
    expect(built.version).toBe('2026.105.903');
    const files = readZip(readFileSync(built.zip)).map((file) => file.name);
    expect(files).toEqual(['NOTICE', 'capture.js', 'icons/128.png', 'icons/16.png', 'icons/32.png', 'icons/48.png', 'manifest.json', 'options.css', 'options.html', 'options.js', 'probe.js', 'sw.js']);
    const manifest = JSON.parse(readFileSync(join(built.folder, 'manifest.json'), 'utf8'));
    expect([manifest.version, manifest.version_name]).toEqual(['2026.105.903', 'abc1234']);
    expect(built.zip.endsWith('recall-extension-abc1234.zip')).toBe(true);
    for (const name of ['sw.js', 'options.js', 'capture.js']) {
      const code = readFileSync(join(built.folder, name), 'utf8');
      expect(code, name).not.toMatch(/@bufbuild|protobuf|^import /m);
      expect(code, name).not.toMatch(/https?:\/\/(?!recall\.ziyixi\.science)[a-z0-9.-]+\.(?:com|net|org|io|dev)\//i);
    }
  });

  it('makes capture.js a script whose last statement is the page\'s text, as executeScript answers it', () => {
    const code = readFileSync(join(built.folder, 'capture.js'), 'utf8');
    const document = {
      title: 'A page',
      location: { href: 'https://blog.example.com/a' },
      querySelectorAll: () => [],
      querySelector: (selector) => (selector === 'body' ? { innerText: '正文 text' } : null),
    };
    expect(runInNewContext(code, { document })).toEqual({
      build: '2026.105.903',
      url: 'https://blog.example.com/a',
      title: 'A page',
      description: '',
      text: '正文 text',
      textTruncated: false,
      hasPasswordField: false,
    });
  });

  it('reports visibility through callback-only MV2 messaging without throwing on a closed response port', async () => {
    const code = readFileSync(join(built.orionFolder, 'probe.js'), 'utf8');
    const documentEvents = new Map();
    const windowEvents = new Map();
    const messages = [];
    let lastErrorReads = 0;
    const runtime = {
      id: 'synthetic-extension',
      onMessage: { addListener() {}, removeListener() {} },
      get lastError() { lastErrorReads++; return { message: 'The message port closed before a response was received.' }; },
      sendMessage(message, callback) {
        messages.push(message);
        globalThis.queueMicrotask(() => callback?.());
        return undefined;
      },
    };
    const document = { visibilityState: 'visible', addEventListener: (name, listener) => documentEvents.set(name, listener) };
    const window = { addEventListener: (name, listener) => windowEvents.set(name, listener) };
    window.top = window;
    const result = runInNewContext(code, {
      document,
      window,
      location: { href: 'https://example.org/mobile' },
      crypto: { randomUUID: () => 'synthetic-document' },
      chrome: { runtime },
    });
    expect(result).toEqual({ documentId: 'synthetic-document', visible: true, url: 'https://example.org/mobile', build: built.version });
    expect(() => windowEvents.get('pagehide')()).not.toThrow();
    document.visibilityState = 'hidden';
    expect(() => documentEvents.get('visibilitychange')()).not.toThrow();
    document.visibilityState = 'visible';
    expect(() => windowEvents.get('pageshow')()).not.toThrow();
    await Promise.resolve();
    expect(messages.map(({ type, documentId, visible }) => ({ type, documentId, visible }))).toEqual([
      { type: 'page-visibility', documentId: 'synthetic-document', visible: false },
      { type: 'page-visibility', documentId: 'synthetic-document', visible: false },
      { type: 'page-visibility', documentId: 'synthetic-document', visible: true },
    ]);
    expect(lastErrorReads).toBe(3);
  });

  it('keeps the desktop probe reply independent of the mobile build marker', () => {
    const code = readFileSync(join(built.folder, 'probe.js'), 'utf8');
    const document = { visibilityState: 'visible', addEventListener() {} };
    const window = { addEventListener() {} };
    expect(runInNewContext(code, {
      document, window, location: { href: 'https://example.org/desktop' },
      crypto: { randomUUID: () => 'synthetic-document' },
    })).toEqual({ documentId: 'synthetic-document', visible: true, url: 'https://example.org/desktop' });
  });

  it('answers current top-frame DOM over messages even when the injection result is discarded', () => {
    const code = readFileSync(join(built.orionFolder, 'probe.js'), 'utf8');
    const listeners = new Set();
    const runtime = { id: 'synthetic-extension', onMessage: { addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn) } };
    let bodyText = 'First synthetic text';
    let bodyReads = 0;
    const body = { get innerText() { bodyReads++; return bodyText; } };
    const document = {
      title: 'A synthetic page', location: { href: 'https://example.org/mobile' }, visibilityState: 'visible',
      addEventListener() {}, querySelectorAll: () => [], querySelector: (selector) => selector === 'body' ? body : null,
    };
    const window = { addEventListener() {} };
    window.top = window;
    const context = createContext({ document, window, location: document.location, crypto: { randomUUID: () => 'synthetic-document' }, chrome: { runtime } });
    // No completion value crosses the native injection bridge. Only onMessage can answer the background.
    for (let i = 0; i < 10; i++) runInContext(code, context);
    expect(listeners.size).toBe(1);
    const replies = [];
    const message = (command, id = runtime.id) => listeners.values().next().value(typeof command === 'string' ? { type: command } : command, id === null ? {} : { id }, (reply) => replies.push(reply));
    message('recall-probe');
    expect(replies.at(-1)).toEqual({ documentId: 'synthetic-document', visible: true, url: document.location.href, build: built.version });
    // Native Orion delivers this internal message without MessageSender.id.
    message('recall-probe', null);
    expect(replies).toHaveLength(2);
    expect(replies.at(-1)).toEqual({ documentId: 'synthetic-document', visible: true, url: document.location.href, build: built.version });
    bodyText = 'Updated synthetic text';
    const capture = { type: 'recall-capture-current', expectedDocumentId: 'synthetic-document', url: document.location.href, build: built.version };
    message(capture);
    expect(replies.at(-1)).toMatchObject({ build: built.version, documentId: 'synthetic-document', text: bodyText });
    expect(bodyReads).toBe(1);
    const beforeLegacy = replies.length;
    message('recall-capture');
    expect(replies).toHaveLength(beforeLegacy);
    for (const mismatch of [{ expectedDocumentId: 'replaced-document' }, { url: 'https://example.org/account' }, { build: 'older-build' }]) {
      message({ ...capture, ...mismatch });
      expect(replies.at(-1)).toBeUndefined();
      expect(bodyReads).toBe(1);
    }
    document.visibilityState = 'hidden';
    message(capture);
    expect(replies.at(-1)).toBeUndefined();
    expect(bodyReads).toBe(1);
    message('recall-probe');
    expect(replies.at(-1).visible).toBe(false);
    const beforeIgnored = replies.length;
    message(capture, 'other-extension');
    message('unrelated');
    expect(replies).toHaveLength(beforeIgnored);
    message({ type: 'recall-diagnostic-context', runId: '00000000-0000-4000-8000-000000000001' });
    expect(replies).toHaveLength(beforeIgnored);
    listeners.clear();
    runInNewContext(code, { document, window: { top: window }, chrome: { runtime } });
    expect(listeners.size).toBe(0);
  });

  it('builds an Orion file ZIP from the same source with a nonpersistent plain background script', () => {
    const manifest = JSON.parse(readFileSync(join(built.orionFolder, 'manifest.json'), 'utf8'));
    expect(manifest.manifest_version).toBe(2);
    expect(manifest.key).toBe(JSON.parse(readFileSync(join(built.folder, 'manifest.json'), 'utf8')).key);
    expect(manifest.background).toEqual({ scripts: ['sw.js'], persistent: false });
    expect(manifest.permissions).not.toContain('idle');
    expect(manifest.permissions).not.toContain('scripting');
    expect(manifest.permissions).toContain('<all_urls>');
    expect(manifest.browser_action.default_title).toBe('recall');
    expect(manifest.content_scripts).toBeUndefined();
    expect(manifest.incognito).toBe('not_allowed');
    const code = readFileSync(join(built.orionFolder, 'sw.js'), 'utf8');
    expect(code).not.toMatch(/^import |^export /m);
    expect(readZip(readFileSync(built.orionZip)).map((file) => file.name)).toContain('probe.js');
    expect(readZip(readFileSync(built.orionZip)).map((file) => file.name)).not.toContain('capture.js');
  });

  it('draws the icons as PNG files', () => {
    const png = readFileSync(join(built.folder, 'icons', '128.png'));
    expect(png.subarray(1, 4).toString('ascii')).toBe('PNG');
    expect(png.readUInt32BE(16)).toBe(128);
  });
});

describe('install-extension', () => {
  it('installs a first build, then swaps in a later one with two renames and writes BUILD last', () => {
    const target = join(scratch, 'home', 'recall-extension');
    mkdirSync(join(scratch, 'home'), { recursive: true });
    expect(installExtension(built.zip, target)).toBe('2026.105.903');
    expect(readFileSync(join(target, 'BUILD'), 'utf8')).toBe('2026.105.903\n');
    expect(existsSync(`${target}.prev`)).toBe(false);

    expect(installExtension(laterBuild('2026.106.1200'), target)).toBe('2026.106.1200');
    expect(readFileSync(join(target, 'BUILD'), 'utf8')).toBe('2026.106.1200\n');
    expect(JSON.parse(readFileSync(join(target, 'manifest.json'), 'utf8')).version).toBe('2026.106.1200');
    expect(readFileSync(join(`${target}.prev`, 'BUILD'), 'utf8')).toBe('2026.105.903\n');
    expect(existsSync(`${target}.next`)).toBe(false);
    expect(existsSync(join(target, 'BUILD.tmp'))).toBe(false);
  });

  it('installs from a build folder and from a zip with one top folder (an unpacked artifact zipped again)', () => {
    const target = join(scratch, 'folder-install', 'recall-extension');
    mkdirSync(join(scratch, 'folder-install'), { recursive: true });
    expect(installExtension(built.folder, target)).toBe('2026.105.903');
    const nested = join(scratch, 'nested.zip');
    writeFileSync(nested, writeZip(readZip(readFileSync(built.zip)).map(({ name, data }) => ({ name: `recall-extension-abc1234/${name}`, data }))));
    expect(installExtension(nested, join(scratch, 'folder-install', 'second'))).toBe('2026.105.903');
  });

  it('refuses a half-written build, another key and a synced folder, leaving the installed one alone', () => {
    const target = join(scratch, 'refusals', 'recall-extension');
    mkdirSync(join(scratch, 'refusals'), { recursive: true });
    installExtension(built.zip, target);

    const partial = laterBuild('2026.107.100');
    rmSync(join(partial, 'sw.js'));
    expect(() => installExtension(partial, target)).toThrow('the build has no sw.js');

    const rekeyed = laterBuild('2026.107.100');
    const manifest = JSON.parse(readFileSync(join(rekeyed, 'manifest.json'), 'utf8'));
    writeFileSync(join(rekeyed, 'manifest.json'), JSON.stringify({ ...manifest, key: Buffer.from('another key').toString('base64') }));
    expect(() => installExtension(rekeyed, target)).toThrow(/another key/);

    const badVersion = laterBuild('2026.0107.0100');
    expect(checkBuild(badVersion).error).toMatch(/not a Chrome version/);

    expect(() => installExtension(built.zip, join(scratch, 'Library', 'CloudStorage', 'GoogleDrive-x', 'recall-extension'))).toThrow(/synced folder/);
    expect(readFileSync(join(target, 'BUILD'), 'utf8')).toBe('2026.105.903\n');
    expect(existsSync(`${target}.next`)).toBe(false);
  });

  it('refuses a zip with a path that leaves the folder', () => {
    const evil = join(scratch, 'evil.zip');
    writeFileSync(evil, writeZip([{ name: '../outside.txt', data: Buffer.from('x') }]));
    expect(() => installExtension(evil, join(scratch, 'evil', 'recall-extension'))).toThrow(/unsafe path/);
    expect(existsSync(join(scratch, 'evil', 'outside.txt'))).toBe(false);
  });
});

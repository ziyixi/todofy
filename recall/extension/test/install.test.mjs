// The build (scripts/build.mjs) and install-extension's swap (scripts/install.mjs) in temporary folders: what a build
// holds, the capture script's result as executeScript sees it, the zip, a first install, an update through two renames
// with BUILD written last, and the folders it refuses.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
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
    expect(readFileSync(join(built.orionFolder, 'capture.js'))).toEqual(readFileSync(join(built.folder, 'capture.js')));
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

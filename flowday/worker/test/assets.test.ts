/**
 * The page CSP (../src/assets.ts): exactly the inline scripts of the HTML, by SHA-256; external scripts are left to
 * 'self'. The PWA exception list is exactly the files the report names, nothing else under /pwa/.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PWA_PUBLIC_PATHS, inlineScriptHashes, pageCsp } from '../src/assets.ts';

const sha = (text: string) => `'sha256-${createHash('sha256').update(text).digest('base64')}'`;

describe('page CSP', () => {
  it('hashes inline scripts in order, once each, and skips scripts with src', async () => {
    const html = '<script>a()</script><script src="/x.js"></script><script type="module" async>b()</script><script>a()</script><script id="j" type="application/json">{"k":">"}</script>';
    expect(await inlineScriptHashes(html)).toEqual([sha('a()'), sha('b()'), sha('{"k":">"}')]);
  });

  it('adds the hashes to script-src only; no hashes is the strict policy', () => {
    expect(pageCsp([])).toContain("script-src 'self';");
    expect(pageCsp(["'sha256-x'"])).toContain("script-src 'self' 'sha256-x';");
    expect(pageCsp(["'sha256-x'"])).toContain("object-src 'none'");
  });
});

describe('PWA paths', () => {
  it('are exactly the manifest, the service worker and the icons', () => {
    expect([...PWA_PUBLIC_PATHS].sort()).toEqual([
      '/pwa/apple-touch-icon.png',
      '/pwa/icon-192x192.png',
      '/pwa/icon-512x512.png',
      '/pwa/icon-maskable-512x512.png',
      '/pwa/icon.svg',
      '/pwa/manifest.webmanifest',
      '/pwa/sw',
    ]);
  });
});

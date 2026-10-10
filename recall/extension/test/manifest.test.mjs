// The manifest (src/manifest.json through scripts/manifest.mjs): the permissions of the design and nothing more, no
// static content script, never in incognito, the committed key's stable ID, and the build-time version valid by
// Chrome's rule (5 January 09:03 and 31 December 23:59 included).
import { describe, expect, it } from 'vitest';
import { buildManifest, EXTENSION_ID, extensionIdOf, isChromeVersion, readTemplate, versionOf } from '../scripts/manifest.mjs';

/** Chrome's order of versions: part by part, as integers. */
function compareVersions(a, b) {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return Math.sign(diff);
  }
  return 0;
}

describe('the manifest', () => {
  const manifest = buildManifest(readTemplate(), { version: '2026.1010.900', versionName: 'abc1234' });

  it('asks for exactly the design\'s permissions', () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.minimum_chrome_version).toBe('120');
    expect(manifest.permissions).toEqual(['tabs', 'webNavigation', 'idle', 'alarms', 'storage', 'unlimitedStorage', 'scripting']);
    expect(manifest.host_permissions).toEqual(['<all_urls>']);
    expect(manifest.optional_permissions).toBeUndefined();
  });

  it('never runs in incognito, has no static content script, exposes nothing to pages', () => {
    expect(manifest.incognito).toBe('not_allowed');
    expect(manifest.content_scripts).toBeUndefined();
    expect(manifest.web_accessible_resources).toBeUndefined();
    expect(manifest.externally_connectable).toBeUndefined();
    expect(manifest.content_security_policy).toBeUndefined();
  });

  it('runs sw.js as a module worker and opens the options from the action', () => {
    expect(manifest.background).toEqual({ service_worker: 'sw.js', type: 'module' });
    expect(manifest.action.default_popup).toBeUndefined();
    expect(manifest.options_ui).toEqual({ page: 'options.html', open_in_tab: true });
  });

  it('carries the public key whose ID stays the same', () => {
    expect(extensionIdOf(manifest.key)).toBe(EXTENSION_ID);
    // The public half only: a private key would be a PKCS#8 structure, far longer.
    expect(Buffer.from(manifest.key, 'base64').length).toBe(294);
  });

  it('names the version and the short commit', () => {
    expect(manifest.version).toBe('2026.1010.900');
    expect(manifest.version_name).toBe('abc1234');
  });
});

describe('the version', () => {
  it('is <year>.<month × 100 + day>.<hour × 100 + minute> of the build time (UTC)', () => {
    expect(versionOf(new Date('2026-01-05T09:03:00Z'))).toBe('2026.105.903');
    expect(versionOf(new Date('2026-12-31T23:59:59Z'))).toBe('2026.1231.2359');
    expect(versionOf(new Date('2027-01-01T00:00:00Z'))).toBe('2027.101.0');
  });

  it('is valid by Chrome\'s rule, where a leading zero is not', () => {
    for (const version of ['2026.105.903', '2026.1231.2359', '2027.101.0']) expect(isChromeVersion(version), version).toBe(true);
    for (const version of ['2026.0105.0903', '2026.105.65536', '1.2.3.4.5', '', '2026..1']) expect(isChromeVersion(version), version).toBe(false);
  });

  it('sorts in time order', () => {
    expect(compareVersions('2026.105.903', '2026.104.2359')).toBe(1);
    expect(compareVersions('2027.101.0', '2026.1231.2359')).toBe(1);
    expect(compareVersions('2026.105.1000', '2026.105.959')).toBe(1);
  });
});

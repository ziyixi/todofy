// The built manifest (../../docs/design.md §3.1, §3.10): src/manifest.json with the version and the version name.
//
// The version is the build time (UTC) as <year>.<month × 100 + day>.<hour × 100 + minute>: 5 January 09:03 is
// 2026.105.903, which still sorts after 2026.104.2359 (Chrome compares the parts as integers and refuses a part with a
// leading zero, so 2026.0105.0903 would not load). The version name is the build's short commit.
//
// The manifest's `key` is the public half of a key pair made once (the private half was never kept: an unpacked
// extension does not need it), so the extension's ID, and with it the IndexedDB holding the outbox, never changes.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** The ID Chrome derives from the committed key. */
export const EXTENSION_ID = 'kpehdcbafdhgghclgaeigokjoceemfhj';

export const TEMPLATE_PATH = new URL('../src/manifest.json', import.meta.url);

/** One to four dot-separated integers of at most 65535, without leading zeros. */
const CHROME_VERSION = /^(0|[1-9][0-9]{0,4})(\.(0|[1-9][0-9]{0,4})){0,3}$/;

export function readTemplate() {
  return JSON.parse(readFileSync(TEMPLATE_PATH, 'utf8'));
}

/** Whether Chrome accepts a version. */
export function isChromeVersion(version) {
  return CHROME_VERSION.test(version) && version.split('.').every((part) => Number(part) <= 65535);
}

/** The version of a build made at `date` (UTC). */
export function versionOf(date) {
  const day = (date.getUTCMonth() + 1) * 100 + date.getUTCDate();
  const minute = date.getUTCHours() * 100 + date.getUTCMinutes();
  return `${String(date.getUTCFullYear())}.${String(day)}.${String(minute)}`;
}

/** The manifest of a build: the template with its version and version name. */
export function buildManifest(template, { version, versionName }) {
  const { manifest_version: manifestVersion, name, ...rest } = template;
  return { manifest_version: manifestVersion, name, version, version_name: versionName, ...rest };
}

/** The extension ID Chrome derives from a manifest key: the SHA-256 of the key's DER, its first 16 bytes as a-p. */
export function extensionIdOf(key) {
  const digest = createHash('sha256').update(Buffer.from(key, 'base64')).digest();
  return Array.from(digest.subarray(0, 16), (byte) => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15))).join('');
}

/** Orion's file installer can run a nonpersistent MV2 background script, without module service workers. */
export function buildOrionManifest(template, identity) {
  const { minimum_chrome_version: ignoredChromeVersion, host_permissions: hosts, background: ignoredBackground, action, ...base } = buildManifest(template, identity);
  void ignoredChromeVersion;
  void ignoredBackground;
  return {
    ...base,
    manifest_version: 2,
    permissions: [...base.permissions.filter((permission) => permission !== 'idle' && permission !== 'scripting'), ...hosts],
    background: { scripts: ['sw.js'], persistent: false },
    browser_action: action,
  };
}

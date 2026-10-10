/**
 * The self-update (../../docs/design.md §3.10). `npm run install-extension` never replaces files under the running
 * extension: it unpacks the new build beside the extension's folder, swaps the folders with two renames and writes the
 * file BUILD, holding the new version, last. On every tick (and from the options page's 检查更新) the service worker
 * reads BUILD and manifest.json from its own folder, which Chrome serves as they are on disk; only when both parse,
 * name the same version and that version is not its own is a new build in place, and the worker closes its span and
 * reloads. A half-written folder never passes, and during the swap the reads fail and the next tick tries again.
 */
import type { Context } from './context.ts';

/** A version in Chrome's form: one to four dot-separated integers without leading zeros. */
const CHROME_VERSION = /^(0|[1-9][0-9]{0,4})(\.(0|[1-9][0-9]{0,4})){0,3}$/;

async function readOwnFile(ctx: Context, name: string): Promise<string> {
  const response = await ctx.fetch(ctx.chrome.runtime.getURL(name), { cache: 'no-store' });
  if (!response.ok) throw new Error('not_found');
  return response.text();
}

/** The version of a newer build installed in the extension's folder, or null. */
export async function installedUpdate(ctx: Context): Promise<string | null> {
  let build: string;
  let manifest: unknown;
  try {
    build = (await readOwnFile(ctx, 'BUILD')).trim();
    manifest = JSON.parse(await readOwnFile(ctx, 'manifest.json'));
  } catch {
    return null;
  }
  const version = typeof manifest === 'object' && manifest !== null ? (manifest as { version?: unknown }).version : undefined;
  if (!CHROME_VERSION.test(build) || version !== build || build === ctx.build) return null;
  return build;
}

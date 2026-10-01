/**
 * The redirect path (../../docs/design.md §2, §4): what a short link answers. Its cost is the point: one D1 read by
 * primary key and no write at all (no click count, no last-used time), the Access token verified only when the
 * request carries one, and nothing logged (never a key, a path or a target).
 *
 * Who sees what:
 * - a live PUBLIC link: anyone is redirected (302) to its destination, or shown its preview (`/<key>+`);
 * - a live PRIVATE link: the owner likewise; anyone else gets exactly what an unknown key gets;
 * - an unknown, deleted or expired key: a 302 to the owner's continuation /_/k/<the same path>, behind Access,
 *   where the owner is redirected (if the link is live by then) or offered to create the key. The answer depends
 *   only on the request's path, so it says nothing about whether a private key exists.
 *
 * Nor does the time it takes: every request that is not for a live public link asks who it is from, whether or not
 * the key exists, so a private key costs exactly what an unknown one does (the Access check, and the issuer's keys
 * fetched when the isolate has none). Only a request that carries an Access token is checked at all (auth.ts
 * isOwner), so an anonymous request, and any request for a public link, never verifies anything.
 */
import { continuationPath, type ShortPath } from './keys.ts';
import type { Visibility } from './model.ts';
import { destination, type PathMode, type RestProblem } from './targets.ts';

/** The columns a redirect reads. */
export interface Resolvable {
  readonly target: string;
  /** Shown on the preview page only. */
  readonly description: string;
  readonly path_mode: PathMode;
  readonly visibility: Visibility;
  readonly expire_time: number | null;
  readonly delete_time: number | null;
}

/** The one D1 read of a redirect: the link by its primary key (a purged or never-made key is null). */
export function readResolvable(db: D1Database, key: string): Promise<Resolvable | null> {
  return db.prepare('SELECT target, path_mode, visibility, description, expire_time, delete_time FROM links WHERE key = ?').bind(key).first<Resolvable>();
}

/** A link that resolves now: not deleted and not expired. */
export function isLive(row: Resolvable | null, now: number): row is Resolvable {
  return row !== null && row.delete_time === null && (row.expire_time === null || row.expire_time > now);
}

/** What a short-link request gets, before it becomes a Response (http.ts). */
export type Resolution =
  | { readonly kind: 'redirect'; readonly location: string }
  | { readonly kind: 'preview'; readonly key: string; readonly row: Resolvable; readonly url: string | null }
  | { readonly kind: 'refused'; readonly problem: RestProblem };

/**
 * The answer to `path` for a link that `row` describes, read for a requester who is the owner or not. `owner` is a
 * function so that a request for a live public link never verifies anything; every other request calls it exactly
 * once, whatever `row` is (no timing oracle on which private keys exist).
 */
export async function resolve(path: ShortPath, row: Resolvable | null, now: number, owner: () => Promise<boolean>): Promise<Resolution> {
  if (isLive(row, now) && row.visibility === 'public') return answer(path, row);
  // Asked whether or not the key exists: a private key costs what an unknown, deleted or expired one does.
  const isOwnerRequest = await owner();
  if (!isLive(row, now) || !isOwnerRequest) return { kind: 'redirect', location: continuationPath(path) };
  return answer(path, row);
}

/** The owner's continuation, /_/k/<path>: the live link's answer, or null (the launcher offers to create it). */
export function resolveForOwner(path: ShortPath, row: Resolvable | null, now: number): Resolution | null {
  return isLive(row, now) ? answer(path, row) : null;
}

function answer(path: ShortPath, row: Resolvable): Resolution {
  const built = destination(row.target, row.path_mode, path.rest);
  if (path.preview) return { kind: 'preview', key: path.key, row, url: 'url' in built ? built.url : null };
  return 'url' in built ? { kind: 'redirect', location: built.url } : { kind: 'refused', problem: built.problem };
}

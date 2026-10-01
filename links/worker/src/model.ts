/**
 * A link as D1 stores it (links/migrations/0001_init.sql) and as links.ui.v1 sends it: the row types, the row as a
 * generated message, and the row as wire JSON written directly (ExportLinks writes up to LINKS_MAX lines without
 * building a message per link; test/model.test.ts proves it equals toWire of the message).
 */
import { create } from '@ziyixi/proto/protobuf';
import { timestampFromMs } from '@ziyixi/proto/protobuf/wkt';
import { Link_PathMode, Link_PathModeSchema, Link_Visibility, Link_VisibilitySchema, LinkSchema, type Link } from '@ziyixi/proto/links/ui/v1/link_pb';
import { wireEnum, type WireName } from '@ziyixi/proto/wire-json';
import type { PathMode } from './targets.ts';

export type Visibility = WireName<typeof Link_Visibility>;

/** The enums' wire names, which are also the values D1 stores (one table: a new value fails the typecheck). */
export const PATH_MODES = wireEnum(Link_PathModeSchema, Link_PathMode);
export const VISIBILITIES = wireEnum(Link_VisibilitySchema, Link_Visibility);

/** The fields the owner sets: what a revision keeps and an update or rollback replaces. */
export interface LinkContent {
  readonly target: string;
  readonly path_mode: PathMode;
  readonly visibility: Visibility;
  readonly description: string;
  /** JSON array of tag strings, as stored. */
  readonly tags: string;
  readonly expire_time: number | null;
}

/** A row of `links` (times in epoch milliseconds). */
export interface LinkRow extends LinkContent {
  readonly key: string;
  readonly create_time: number;
  readonly update_time: number;
  readonly delete_time: number | null;
  readonly purge_time: number | null;
  /** The current revision's number (link_revisions.revision); its time is update_time of the last content change. */
  readonly revision: number;
  readonly revision_time: number;
  readonly etag: string;
}

/** A row of `link_revisions`. */
export interface RevisionRow extends LinkContent {
  readonly key: string;
  readonly revision: number;
  readonly create_time: number;
}

/** Every column of `links`, in table order (one list for every SELECT and INSERT). */
export const LINK_COLUMNS =
  'key, target, path_mode, visibility, description, tags, expire_time, create_time, update_time, delete_time, purge_time, revision, revision_time, etag';
/** The content columns a revision keeps, in table order. */
export const CONTENT_COLUMNS = 'target, path_mode, visibility, description, tags, expire_time';

export function linkName(key: string): string {
  return `links/${key}`;
}

/** The tags of a row (stored as a JSON array; anything else reads as none). */
export function tagsOf(tags: string): string[] {
  try {
    const parsed: unknown = JSON.parse(tags);
    return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === 'string') : [];
  } catch {
    return [];
  }
}

export function sameContent(a: LinkContent, b: LinkContent): boolean {
  return (
    a.target === b.target &&
    a.path_mode === b.path_mode &&
    a.visibility === b.visibility &&
    a.description === b.description &&
    a.tags === b.tags &&
    a.expire_time === b.expire_time
  );
}

const ts = (ms: number | null) => (ms === null ? undefined : timestampFromMs(ms));

/** The row as a links.ui.v1.Link: at its current revision, or at `revision` (ListLinkRevisions). */
export function linkMessage(row: LinkRow, revision?: RevisionRow): Link {
  const content: LinkContent = revision ?? row;
  return create(LinkSchema, {
    name: linkName(row.key),
    target: content.target,
    pathMode: PATH_MODES.value(content.path_mode) ?? Link_PathMode.EXACT,
    visibility: VISIBILITIES.value(content.visibility) ?? Link_Visibility.PRIVATE,
    description: content.description,
    tags: tagsOf(content.tags),
    expireTime: ts(content.expire_time),
    createTime: ts(row.create_time),
    updateTime: ts(row.update_time),
    deleteTime: ts(row.delete_time),
    purgeTime: ts(row.purge_time),
    etag: row.etag,
    revisionId: String(revision?.revision ?? row.revision),
    revisionCreateTime: ts(revision?.create_time ?? row.revision_time),
  });
}

/** A timestamp in the wire profile: RFC 3339 UTC, no fraction for a whole second, else milliseconds. */
export function wireTime(ms: number): string {
  const iso = new Date(ms).toISOString();
  return ms % 1000 === 0 ? `${iso.slice(0, 19)}Z` : iso;
}

/**
 * The wire JSON object of linkMessage(row), written directly: the fields in number order, defaults omitted (an
 * empty description, no tags, an unset time), as the wire profile writes them.
 */
export function linkWire(row: LinkRow): Record<string, unknown> {
  const wire: Record<string, unknown> = { name: linkName(row.key), target: row.target, path_mode: row.path_mode, visibility: row.visibility };
  if (row.description !== '') wire['description'] = row.description;
  const tags = tagsOf(row.tags);
  if (tags.length > 0) wire['tags'] = tags;
  if (row.expire_time !== null) wire['expire_time'] = wireTime(row.expire_time);
  wire['create_time'] = wireTime(row.create_time);
  wire['update_time'] = wireTime(row.update_time);
  if (row.delete_time !== null) wire['delete_time'] = wireTime(row.delete_time);
  if (row.purge_time !== null) wire['purge_time'] = wireTime(row.purge_time);
  if (row.etag !== '') wire['etag'] = row.etag;
  wire['revision_id'] = String(row.revision);
  wire['revision_create_time'] = wireTime(row.revision_time);
  return wire;
}

import { readFile } from "node:fs/promises";
import path from "node:path";

import { ContentError } from "./errors";
import { hashContentSnapshot } from "./hash";
import {
  ContentManifestSchema,
  type ContentManifest,
  type ContentSnapshot,
  type Post,
} from "./schema";
import { validateContentSnapshotWithOptions } from "./validate";

export interface ContentBundle {
  snapshot: ContentSnapshot;
  manifest: ContentManifest;
}

export async function readContentBundle(
  contentDirectory = path.join(process.cwd(), ".generated", "content"),
): Promise<ContentBundle> {
  let snapshotText: string;
  let manifestText: string;
  try {
    [snapshotText, manifestText] = await Promise.all([
      readFile(path.join(contentDirectory, "snapshot.json"), "utf8"),
      readFile(path.join(contentDirectory, "manifest.json"), "utf8"),
    ]);
  } catch (error) {
    throw new ContentError(
      "MISSING_CONTENT_SNAPSHOT",
      "Prepared content is missing. Run `pnpm content:prepare --source=empty` (or fixture/notion) first.",
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }

  // The immutable snapshot does not carry profile data, so permit the one
  // repository-owned optional CV route here. content:validate proves that the
  // profile enables it and that a real PDF exists before any build succeeds.
  const snapshot = validateContentSnapshotWithOptions(JSON.parse(snapshotText) as unknown, {
    allowCvPath: true,
  });
  const manifest = ContentManifestSchema.parse(JSON.parse(manifestText) as unknown);
  if (manifest.sourceMode !== snapshot.sourceMode) {
    throw new ContentError("CONTENT_MODE_MISMATCH", "Snapshot and manifest source modes differ.");
  }
  if (
    manifest.postCount !== snapshot.posts.length ||
    manifest.mediaCount !== snapshot.media.length
  ) {
    throw new ContentError("CONTENT_COUNT_MISMATCH", "Snapshot and manifest counts differ.");
  }
  if (hashContentSnapshot(snapshot) !== manifest.contentHash) {
    throw new ContentError(
      "CONTENT_HASH_MISMATCH",
      "Prepared snapshot does not match its manifest.",
    );
  }
  return { snapshot, manifest };
}

export async function readContentSnapshot(contentDirectory?: string): Promise<ContentSnapshot> {
  return (await readContentBundle(contentDirectory)).snapshot;
}

export function findPostBySlug(snapshot: ContentSnapshot, slug: string): Post | undefined {
  return snapshot.posts.find((post) => post.slug === slug);
}

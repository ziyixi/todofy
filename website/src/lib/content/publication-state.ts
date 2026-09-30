import { z } from "zod";

import { ContentError } from "./errors";
import { hashContentSnapshot, sha256 } from "./hash";
import {
  CONTENT_SCHEMA_VERSION,
  ContentSnapshotSchema,
  PostSchema,
  type ContentSnapshot,
  type Post,
} from "./schema";
import { validateSlug } from "./slug";
import { stableStringify } from "./stable-json";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const PublicationIdentitySchema = z
  .object({
    codeSha: z.string().regex(/^(?:[a-f0-9]{7,64}|local-development)$/i),
    contentHash: Sha256Schema,
    configHash: Sha256Schema,
    schemaVersion: z.literal(CONTENT_SCHEMA_VERSION),
  })
  .strict();

export const PublicationStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    identity: PublicationIdentitySchema,
    posts: z.array(
      z
        .object({
          sourceKey: Sha256Schema,
          slug: z.string().transform(validateSlug),
          contentHash: Sha256Schema,
        })
        .strict(),
    ),
  })
  .strict()
  .superRefine((state, context) => {
    const keys = new Set<string>();
    const slugs = new Set<string>();
    for (const post of state.posts) {
      if (keys.has(post.sourceKey) || slugs.has(post.slug)) {
        context.addIssue({
          code: "custom",
          message: "Publication state cannot contain duplicate article identities or slugs.",
        });
      }
      keys.add(post.sourceKey);
      slugs.add(post.slug);
    }
  });

export type PublicationState = z.infer<typeof PublicationStateSchema>;
export type PublicationIdentity = PublicationState["identity"];

/** Only the normalized public post participates; no sync or release state is accepted. */
export function hashPostContent(post: Post): string {
  return sha256(stableStringify(PostSchema.parse(post)));
}

export function createPublicationState(
  snapshot: ContentSnapshot,
  identity: PublicationIdentity,
): PublicationState {
  const normalized = ContentSnapshotSchema.parse(snapshot);
  const validatedIdentity = PublicationIdentitySchema.parse(identity);
  if (hashContentSnapshot(normalized) !== validatedIdentity.contentHash) {
    throw new ContentError(
      "PUBLICATION_IDENTITY_MISMATCH",
      "Publication state must describe the snapshot identified by build-info.json.",
    );
  }

  return PublicationStateSchema.parse({
    schemaVersion: 1,
    identity: validatedIdentity,
    posts: normalized.posts
      .map((post) => ({
        sourceKey: post.sourceKey,
        slug: post.slug,
        contentHash: hashPostContent(post),
      }))
      .sort((left, right) => left.sourceKey.localeCompare(right.sourceKey)),
  });
}

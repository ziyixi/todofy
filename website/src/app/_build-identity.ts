import {
  CONTENT_SCHEMA_VERSION,
  PublicationIdentitySchema,
  type ContentManifest,
  type PublicationIdentity,
} from "@/lib/content";

export function getBuildIdentity(manifest: ContentManifest): PublicationIdentity {
  return PublicationIdentitySchema.parse({
    codeSha:
      process.env.CODE_SHA ??
      process.env.GITHUB_SHA ??
      process.env.VERCEL_GIT_COMMIT_SHA ??
      "local-development",
    configHash: manifest.configHash,
    contentHash: manifest.contentHash,
    schemaVersion: CONTENT_SCHEMA_VERSION,
  });
}

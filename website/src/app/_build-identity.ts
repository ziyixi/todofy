import {
  CONTENT_SCHEMA_VERSION,
  PublicationIdentitySchema,
  type ContentManifest,
  type PublicationIdentity,
} from "@/lib/content";

export function getBuildIdentity(manifest: ContentManifest): PublicationIdentity {
  return PublicationIdentitySchema.parse({
    codeSha:
      // The release sets CODE_SHA to the newest commit that touched website/ (docs/release.md).
      process.env.CODE_SHA ?? process.env.GITHUB_SHA ?? "local-development",
    configHash: manifest.configHash,
    contentHash: manifest.contentHash,
    schemaVersion: CONTENT_SCHEMA_VERSION,
  });
}

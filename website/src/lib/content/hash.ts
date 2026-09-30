import { createHash } from "node:crypto";

import {
  CONTENT_SCHEMA_VERSION,
  ContentSnapshotSchema,
  SiteConfigSchema,
  type ContentSnapshot,
  type SiteConfigData,
} from "./schema";
import { stableStringify } from "./stable-json";

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hashContentSnapshot(snapshot: ContentSnapshot): string {
  const normalized = ContentSnapshotSchema.parse(snapshot);
  return sha256(stableStringify(normalized));
}

export function hashPublicConfig(config: SiteConfigData): string {
  return sha256(
    stableStringify({
      schemaVersion: CONTENT_SCHEMA_VERSION,
      renderContractVersion: 1,
      config: SiteConfigSchema.parse(config),
    }),
  );
}

export function sourceKeyForNotionPage(pageId: string): string {
  const normalized = pageId.replaceAll("-", "").toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(normalized)) {
    throw new Error("Notion page ID must be a 32-character hexadecimal identifier.");
  }
  return sha256(`notion-page:v1:${normalized}`);
}

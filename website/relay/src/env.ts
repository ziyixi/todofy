/** Bindings of the Worker ziyixi-notion-publish (relay/wrangler.toml; secrets set with wrangler secret put). */
export interface RelayEnv {
  // Secrets.
  GITHUB_DISPATCH_TOKEN?: string;
  NOTION_WEBHOOK_SECRET?: string;
  /** A Notion integration with Read content on the Blog data source (the detector only reads). */
  NOTION_TOKEN?: string;
  NOTION_DATA_SOURCE_ID?: string;
  // Committed vars.
  GITHUB_REPOSITORY: string;
  RELEASE_WORKFLOW: string;
  CANONICAL_HOST: string;
  NOTION_API_VERSION: string;
  AUTO_PUBLISH?: string;
  QUIET_MINUTES?: string;
  MAX_AUTO_RELEASES_PER_DAY?: string;
  RECONCILE_UTC_HOUR?: string;
  /** Optional comma-separated Notion user IDs whose edits never count (e.g. the write-back bot). */
  IGNORED_EDITOR_IDS?: string;
}

export function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) return fallback;
  return parsed;
}

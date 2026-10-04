/** The daily relay holds GitHub credentials only; Actions reads Notion content. */
export interface RelayEnv {
  BUILD_SHA?: string;
  GITHUB_DISPATCH_TOKEN?: string;
  GITHUB_REPOSITORY: string;
  RELEASE_WORKFLOW: string;
  CANONICAL_HOST: string;
  DAILY_SYNC_CRON: string;
}

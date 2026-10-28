import type { SubscriptionStore } from './store.ts';
import type { ContentToolEnv } from './content.ts';
import type { WatchToolEnv } from './watch.ts';

/**
 * The one SubscriptionStore object that serves the app. A restore fills an empty store, so after losing this one's data
 * a release points the app at a new name (docs/backup.md); the old object then goes quiet but keeps its data.
 */
export const STORE_OBJECT = 'owner';

export interface Env extends ContentToolEnv, WatchToolEnv {
  SUBSCRIPTIONS: DurableObjectNamespace<SubscriptionStore>;
  /** The daily backup's private bucket (backup.ts), which a restore also reads; without it there is no backup. */
  BACKUPS?: R2Bucket;
  PUBLIC_HOST: string;
  ACCESS_ISSUER: string;
  ACCESS_AUDIENCE?: string;
  ACCESS_OWNER?: string;
  ACCESS_OWNER_ALIASES?: string;
  BUILD_SHA?: string;
  CALLBACK_HOSTS: string;
  DEV_AUTH_BYPASS?: string;
}

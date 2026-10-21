import type { SubscriptionStore } from './store.ts';
import type { ContentToolEnv } from './content.ts';

export interface Env extends ContentToolEnv {
  SUBSCRIPTIONS: DurableObjectNamespace<SubscriptionStore>;
  TASKS: Fetcher;
  PUBLIC_HOST: string;
  ACCESS_ISSUER: string;
  ACCESS_AUDIENCE?: string;
  ACCESS_OWNER?: string;
  ACCESS_OWNER_ALIASES?: string;
  BUILD_SHA?: string;
  CALLBACK_HOSTS: string;
  DEV_AUTH_BYPASS?: string;
}

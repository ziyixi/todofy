import type { FleetState } from './state.ts';
export interface Env {
  readonly FLEET: DurableObjectNamespace<FleetState>;
  readonly ASSETS: Fetcher;
  readonly PUBLIC_HOST: string;
  readonly ACCESS_ISSUER: string;
  readonly ACCESS_AUDIENCE: string;
  readonly HOST_KEY: string;
  readonly HOST_EPOCH: string;
  readonly BUILD_SHA?: string;
  readonly ACCESS_OWNER?: string;
  readonly ACCESS_OWNER_ALIASES?: string;
  readonly REPORT_HMAC_KEY?: string;
  readonly DEV_AUTH_BYPASS?: string;
  readonly DEV_NOW?: string;
}

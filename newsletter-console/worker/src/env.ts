export interface Env {
  readonly ASSETS: Fetcher;
  readonly PUBLIC_HOST: string;
  readonly ACCESS_ISSUER: string;
  /** Absent until "Infra apply" creates the console's Access application: every owner request is then UNAVAILABLE. */
  readonly ACCESS_AUDIENCE?: string;
  /** https://<platform runtime host>, where Newsletter answers newsletter.ui.v1 under /api/newsletter/v1/. */
  readonly NEWSLETTER_ORIGIN: string;
  readonly BUILD_SHA?: string;
  readonly ACCESS_OWNER?: string;
  readonly ACCESS_OWNER_ALIASES?: string;
  readonly DEV_AUTH_BYPASS?: string;
}

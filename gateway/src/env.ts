/** Bindings, vars and secrets of the gateway Worker, read the way the Python `config.py` read them. */
export interface Env {
  readonly ASSETS: Fetcher;
  readonly COORDINATOR: DurableObjectNamespace;
  readonly TODOFY_PUBLIC_HOST?: string;
  readonly TODOFY_HOOKS_HOSTS?: string;
  readonly BUILD_SHA?: string;
  readonly MAINTENANCE_MODE?: string;
  readonly ACCESS_ISSUER?: string;
  readonly ACCESS_AUDIENCE?: string;
  readonly ACCESS_OWNER?: string;
  readonly ACCESS_OWNER_ALIASES?: string;
  readonly MAIL_WEBHOOK_TOKEN_SHA256?: string;
  readonly MAIL_WEBHOOK_TOKEN_SHA256_PREVIOUS?: string;
  readonly REPORT_BASIC_AUTH_SHA256?: string;
  readonly CSRF_SIGNING_KEY?: string;
  // Dev and test only; ignored unless the public host is a *.localhost name.
  readonly DEV_AUTH_BYPASS?: string;
  readonly DEV_ACCESS_LOOPBACK_ISSUER?: string;
  // Tests shorten it; production uses the default.
  readonly JWKS_REFRESH_COOLDOWN_MS?: string;
}

type VarName = Exclude<keyof Env, 'ASSETS' | 'COORDINATOR'>;

/** A trimmed var; the fallback applies only when the var is not set at all. */
export function variable(env: Env, name: VarName, fallback = ''): string {
  const value = env[name];
  return value === undefined ? fallback : value.trim();
}

export function flag(env: Env, name: VarName): boolean {
  return variable(env, name) === 'true';
}

/** Comma-separated, trimmed, lowercased, empty items dropped. */
export function csv(env: Env, name: VarName): string[] {
  return variable(env, name)
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

/** A non-negative integer var; anything else falls back to the default. */
export function integer(env: Env, name: VarName, fallback: number): number {
  const value = variable(env, name);
  return /^\d+$/.test(value) ? Number(value) : fallback;
}

/** Dev-only switches are ignored unless the public host is a *.localhost name. */
export function localDev(env: Env): boolean {
  return variable(env, 'TODOFY_PUBLIC_HOST').toLowerCase().endsWith('.localhost');
}

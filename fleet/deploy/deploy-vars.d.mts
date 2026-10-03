/** Types for the plain Node deploy wrapper; production values are validated by its implementation. */
export function generateSecrets(env: Readonly<Record<string, unknown>>): Readonly<{
  ACCESS_OWNER: string;
  ACCESS_OWNER_ALIASES: string;
  REPORT_HMAC_KEY: string;
}>;
export function injectedVars(env: Readonly<Record<string, unknown>>): Readonly<{ BUILD_SHA: string }>;
export function placeholderIn(text: string): string | null;

/** The two classification choices; scheduling, prompt and Gmail writes stay in the existing pipeline. */
export const CODEX_MODEL = 'gpt-6-sol';
export const CLASSIFICATION_EFFORT = 'medium';

/** Only deployment configuration supplies this URL; the UI never accepts arbitrary destinations. */
export function codexEndpoint(env: { readonly CODEX_ENDPOINT_URL?: string; readonly CODEX_ENDPOINT_TOKEN?: string }): URL | null {
  if (!env.CODEX_ENDPOINT_TOKEN?.trim()) return null;
  try {
    const url = new URL(env.CODEX_ENDPOINT_URL ?? '');
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash ? url : null;
  } catch { return null; }
}

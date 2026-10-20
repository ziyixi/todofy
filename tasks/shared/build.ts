/**
 * Every owner API answer names the build (commit) the Worker runs in this header. The web compares it with
 * the build of its own bundle and asks for a reload when they differ (web/src/outdated.ts).
 */
export const BUILD_HEADER = 'x-tasks-build';
/** The Worker's message for an API path no route has; an older bundle may still call a removed one. */
export const UNKNOWN_ROUTE = 'Unknown API route';

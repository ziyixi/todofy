import type { Env } from './env.ts';
import { handleRequest } from './http.ts';
export { FleetState } from './state.ts';
export { Ops, NewsletterOps } from './ops.ts';
export default { fetch: handleRequest } satisfies ExportedHandler<Env>;

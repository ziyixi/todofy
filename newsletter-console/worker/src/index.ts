import type { Env } from './env.ts';
import { handleRequest } from './http.ts';
export default { fetch: handleRequest } satisfies ExportedHandler<Env>;

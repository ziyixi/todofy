import type { Env } from './env.ts';
import { handleRequest } from './http.ts';

export { StorageState } from './state.ts';
export default { fetch: handleRequest } satisfies ExportedHandler<Env>;

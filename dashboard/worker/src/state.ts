/**
 * HomeState: the one SQLite-backed Durable Object ("home-v1") that does all real work
 * (docs/design.md §3-§5): status polling, the GraphQL usage query, guard, canary, digest and the
 * cached overview. Scaffold only; the build step fills in the methods.
 */
import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env.ts';

/** Name of the single object instance. */
export const HOME_OBJECT = 'home-v1';

export class HomeState extends DurableObject<Env> {}

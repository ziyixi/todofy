/**
 * The named WorkerEntrypoint "Ops" (contracts/ops-v1, docs/design.md §8): status() and setGuard() for the
 * dashboard "home". Scaffold: both answer `unavailable` until LabState implements them and ops-v1 lists
 * the app "lab".
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import type { Env } from './env.ts';

export class Ops extends WorkerEntrypoint<Env> {
  status(): Promise<never> {
    return Promise.reject(new Error('unavailable'));
  }

  setGuard(): Promise<never> {
    return Promise.reject(new Error('unavailable'));
  }
}

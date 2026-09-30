/**
 * LabState (docs/design.md §4–§6): the single SQLite-backed Durable Object "lab-v1". It owns scheduling
 * (setAlarm only), job cursors, vectors, the neuron ledger and the guard, and is the only writer to D1.
 */
import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env.ts';

/** Name of the single object instance. */
export const LAB_OBJECT = 'lab-v1';

export class LabState extends DurableObject<Env> {
  /** Arms the alarm if none is set (first request, deploy probe). Scaffold: no-op. */
  ensureAlarm(): Promise<void> {
    return Promise.resolve();
  }

  /** Scaffold: the pipeline (fetch, parse, embed, rank, tldr, seed resolve, retention) lands here. */
  override alarm(): Promise<void> {
    return Promise.resolve();
  }
}

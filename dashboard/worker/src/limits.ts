/**
 * Workers Free & Paid allowances the dashboard measures (docs/limits.md, checked 2026-09-29 and
 * Paid updated 2026-11-24 against the linked Cloudflare pages; test/limits.test.ts keeps that table
 * and these values equal). They are account-wide: other Workers, databases, buckets and AI models
 * count too. "GB" is taken as 10^9 bytes (the docs do not say; decimal is the smaller, more cautious limit).
 */
import type { QuotaPeriod, QuotaPlan, QuotaResource, QuotaUnit } from './api-types.ts';

export interface Allowance {
  readonly period: QuotaPeriod;
  readonly unit: QuotaUnit;
  readonly limit: number;
  /**
   * Counts for the guard rule: daily resources and R2 operations, never storage, and not Workers AI:
   * shed defers the apps' cleanup and safety nets, which use no Workers AI, so shedding cannot lower
   * neuron use; above the Free allocation only AI calls fail (docs/limits.md §1).
   */
  readonly guardTrigger: boolean;
  readonly source: string;
}

const WORKERS_LIMITS = 'https://developers.cloudflare.com/workers/platform/limits/#daily-requests';
const WORKERS_PRICING = 'https://developers.cloudflare.com/workers/platform/pricing/';
const D1_PRICING = 'https://developers.cloudflare.com/d1/platform/pricing/';
const D1_LIMITS = 'https://developers.cloudflare.com/d1/platform/limits/';
const DO_PRICING = 'https://developers.cloudflare.com/durable-objects/platform/pricing/';
const DO_LIMITS = 'https://developers.cloudflare.com/durable-objects/platform/limits/';
const R2_PRICING = 'https://developers.cloudflare.com/r2/pricing/';
const AI_PRICING = 'https://developers.cloudflare.com/workers-ai/platform/pricing/';

export const GB = 1_000_000_000;

export type FreeQuotaResource = Exclude<QuotaResource, 'workers_cpu_ms'>;

export const FREE_QUOTA_RESOURCES: readonly FreeQuotaResource[] = [
  'workers_requests',
  'd1_rows_read',
  'd1_rows_written',
  'do_requests',
  'do_duration',
  'do_rows_read',
  'do_rows_written',
  'ai_neurons',
  'r2_class_a',
  'r2_class_b',
  'd1_storage',
  'd1_database_max',
  'do_storage',
  'r2_storage',
];

export const PAID_QUOTA_RESOURCES: readonly QuotaResource[] = [
  'workers_requests',
  'workers_cpu_ms',
  'd1_rows_read',
  'd1_rows_written',
  'do_requests',
  'do_duration',
  'do_rows_read',
  'do_rows_written',
  'ai_neurons',
  'r2_class_a',
  'r2_class_b',
  'd1_storage',
  'd1_database_max',
  'do_storage',
  'r2_storage',
];

export const ALLOWANCES: Readonly<Record<FreeQuotaResource, Allowance>> = {
  workers_requests: { period: 'daily', unit: 'requests', limit: 100_000, guardTrigger: true, source: WORKERS_LIMITS },
  d1_rows_read: { period: 'daily', unit: 'rows', limit: 5_000_000, guardTrigger: true, source: D1_PRICING },
  d1_rows_written: { period: 'daily', unit: 'rows', limit: 100_000, guardTrigger: true, source: D1_PRICING },
  do_requests: { period: 'daily', unit: 'requests', limit: 100_000, guardTrigger: true, source: DO_PRICING },
  do_duration: { period: 'daily', unit: 'gb_seconds', limit: 13_000, guardTrigger: true, source: DO_PRICING },
  do_rows_read: { period: 'daily', unit: 'rows', limit: 5_000_000, guardTrigger: true, source: DO_PRICING },
  do_rows_written: { period: 'daily', unit: 'rows', limit: 100_000, guardTrigger: true, source: DO_PRICING },
  ai_neurons: { period: 'daily', unit: 'neurons', limit: 10_000, guardTrigger: false, source: AI_PRICING },
  r2_class_a: { period: 'monthly', unit: 'operations', limit: 1_000_000, guardTrigger: true, source: R2_PRICING },
  r2_class_b: { period: 'monthly', unit: 'operations', limit: 10_000_000, guardTrigger: true, source: R2_PRICING },
  d1_storage: { period: 'storage', unit: 'bytes', limit: 5 * GB, guardTrigger: false, source: D1_LIMITS },
  d1_database_max: { period: 'storage', unit: 'bytes', limit: 0.5 * GB, guardTrigger: false, source: D1_LIMITS },
  do_storage: { period: 'storage', unit: 'bytes', limit: 5 * GB, guardTrigger: false, source: DO_LIMITS },
  r2_storage: { period: 'storage', unit: 'bytes', limit: 10 * GB, guardTrigger: false, source: R2_PRICING },
};

/**
 * Cloudflare Workers Paid ($5/month) included allowances: billing-cycle compute/D1/DO caps and 10 GB
 * per-database D1 cap. All `guardTrigger` flags stay false: Paid monthly quotas alert (at >= 80% used
 * or >= 100% projected to billing-period end) without shedding daily apps until the billing cycle ends.
 */
export const PAID_ALLOWANCES: Readonly<Record<QuotaResource, Allowance>> = {
  workers_requests: { period: 'monthly', unit: 'requests', limit: 10_000_000, guardTrigger: false, source: WORKERS_PRICING },
  workers_cpu_ms: { period: 'monthly', unit: 'milliseconds', limit: 30_000_000, guardTrigger: false, source: WORKERS_PRICING },
  d1_rows_read: { period: 'monthly', unit: 'rows', limit: 25_000_000_000, guardTrigger: false, source: D1_PRICING },
  d1_rows_written: { period: 'monthly', unit: 'rows', limit: 50_000_000, guardTrigger: false, source: D1_PRICING },
  do_requests: { period: 'monthly', unit: 'requests', limit: 1_000_000, guardTrigger: false, source: DO_PRICING },
  do_duration: { period: 'monthly', unit: 'gb_seconds', limit: 400_000, guardTrigger: false, source: DO_PRICING },
  do_rows_read: { period: 'monthly', unit: 'rows', limit: 25_000_000_000, guardTrigger: false, source: DO_PRICING },
  do_rows_written: { period: 'monthly', unit: 'rows', limit: 50_000_000, guardTrigger: false, source: DO_PRICING },
  ai_neurons: ALLOWANCES.ai_neurons,
  r2_class_a: { ...ALLOWANCES.r2_class_a, guardTrigger: false },
  r2_class_b: { ...ALLOWANCES.r2_class_b, guardTrigger: false },
  d1_storage: ALLOWANCES.d1_storage,
  d1_database_max: { period: 'storage', unit: 'bytes', limit: 10 * GB, guardTrigger: false, source: D1_LIMITS },
  do_storage: ALLOWANCES.do_storage,
  r2_storage: ALLOWANCES.r2_storage,
};

export function allowancesFor(plan: QuotaPlan): Readonly<Partial<Record<QuotaResource, Allowance>>> {
  return plan === 'paid' ? PAID_ALLOWANCES : ALLOWANCES;
}

/**
 * Memory of a Durable Object for duration billing. DO pricing's worked examples compute
 * "1,000,000 seconds * 128 MB / 1 GB = 128,000 GB-s", i.e. a factor of 0.128 (decimal GB).
 */
export const DO_DURATION_GB = 0.128;

/** Warn when any single Durable Object namespace exceeds this share of the daily duration allowance. */
export const DO_NAMESPACE_WARN_PERCENT = 15;

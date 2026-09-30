/**
 * Workers Free allowances the dashboard measures (docs/design.md §7.1, checked 2026-09-29 against the
 * linked Cloudflare pages). They are account-wide: other Workers, databases and buckets count too.
 * "GB" is taken as 10^9 bytes (the docs do not say; decimal is the smaller, more cautious limit).
 */
import type { QuotaPeriod, QuotaResourceId, QuotaUnit } from './api-types.ts';

export interface Allowance {
  readonly period: QuotaPeriod;
  readonly unit: QuotaUnit;
  readonly limit: number;
  /** Counts for the guard rule: daily resources and R2 operations, never storage. */
  readonly guardTrigger: boolean;
  readonly source: string;
}

const WORKERS_LIMITS = 'https://developers.cloudflare.com/workers/platform/limits/#daily-requests';
const D1_PRICING = 'https://developers.cloudflare.com/d1/platform/pricing/';
const D1_LIMITS = 'https://developers.cloudflare.com/d1/platform/limits/';
const DO_PRICING = 'https://developers.cloudflare.com/durable-objects/platform/pricing/';
const DO_LIMITS = 'https://developers.cloudflare.com/durable-objects/platform/limits/';
const R2_PRICING = 'https://developers.cloudflare.com/r2/pricing/';

export const GB = 1_000_000_000;

export const ALLOWANCES: Readonly<Record<QuotaResourceId, Allowance>> = {
  workers_requests: { period: 'daily', unit: 'requests', limit: 100_000, guardTrigger: true, source: WORKERS_LIMITS },
  d1_rows_read: { period: 'daily', unit: 'rows', limit: 5_000_000, guardTrigger: true, source: D1_PRICING },
  d1_rows_written: { period: 'daily', unit: 'rows', limit: 100_000, guardTrigger: true, source: D1_PRICING },
  do_requests: { period: 'daily', unit: 'requests', limit: 100_000, guardTrigger: true, source: DO_PRICING },
  do_duration: { period: 'daily', unit: 'gb_seconds', limit: 13_000, guardTrigger: true, source: DO_PRICING },
  do_rows_read: { period: 'daily', unit: 'rows', limit: 5_000_000, guardTrigger: true, source: DO_PRICING },
  do_rows_written: { period: 'daily', unit: 'rows', limit: 100_000, guardTrigger: true, source: DO_PRICING },
  r2_class_a: { period: 'monthly', unit: 'operations', limit: 1_000_000, guardTrigger: true, source: R2_PRICING },
  r2_class_b: { period: 'monthly', unit: 'operations', limit: 10_000_000, guardTrigger: true, source: R2_PRICING },
  d1_storage: { period: 'storage', unit: 'bytes', limit: 5 * GB, guardTrigger: false, source: D1_LIMITS },
  d1_database_max: { period: 'storage', unit: 'bytes', limit: 0.5 * GB, guardTrigger: false, source: D1_LIMITS },
  do_storage: { period: 'storage', unit: 'bytes', limit: 5 * GB, guardTrigger: false, source: DO_LIMITS },
  r2_storage: { period: 'storage', unit: 'bytes', limit: 10 * GB, guardTrigger: false, source: R2_PRICING },
};

/**
 * Memory of a Durable Object for duration billing. DO pricing's worked examples compute
 * "1,000,000 seconds * 128 MB / 1 GB = 128,000 GB-s", i.e. a factor of 0.128 (decimal GB).
 */
export const DO_DURATION_GB = 0.128;

# Home dashboard: Workers Free limits

The allowances the dashboard measures and guards, and the platform limits its design relies on. Every
value was checked against the linked Cloudflare page on **2026-09-29** (Workers Free plan). Re-check
the pages before changing a value; `worker/src/limits.ts` holds the same numbers, and
`worker/test/limits.test.ts` fails when a row below and `limits.ts` disagree (value or source).

**Account-wide.** Every total is for the whole Cloudflare account: Mail Hero, Todofy, this dashboard
and any other Worker, database or bucket in the account count toward the same allowance. The quota
section of the page therefore shows account totals, with the largest contributors where the dataset
has a breakdown. "GB" is taken as 10⁹ bytes (the pages do not say; decimal is the smaller, more
cautious limit).

## 1. Allowances shown as quota rows

| Resource id | Period | Allowance | `limits.ts` value | Guard trigger | Source |
| --- | --- | --- | --- | --- | --- |
| `workers_requests` | day | 100,000 requests | 100000 | yes | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/#daily-requests) |
| `d1_rows_read` | day | 5,000,000 rows | 5000000 | yes | [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) |
| `d1_rows_written` | day | 100,000 rows | 100000 | yes | [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) |
| `do_requests` | day | 100,000 requests (HTTP, RPC, alarms) | 100000 | yes | [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) |
| `do_duration` | day | 13,000 GB-s | 13000 | yes | [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) |
| `do_rows_read` | day | 5,000,000 rows (SQLite) | 5000000 | yes | [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) |
| `do_rows_written` | day | 100,000 rows (SQLite; each `setAlarm()` is one) | 100000 | yes | [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) |
| `r2_class_a` | month | 1,000,000 operations | 1000000 | yes | [R2 pricing](https://developers.cloudflare.com/r2/pricing/) |
| `r2_class_b` | month | 10,000,000 operations | 10000000 | yes | [R2 pricing](https://developers.cloudflare.com/r2/pricing/) |
| `d1_storage` | total | 5 GB per account | 5000000000 | no | [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) |
| `d1_database_max` | per database | 500 MB (the largest database is shown) | 500000000 | no | [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) |
| `do_storage` | total | 5 GB (SQLite-backed objects) | 5000000000 | no | [DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/) |
| `r2_storage` | total (GB-month) | 10 GB-month (Standard storage only) | 10000000000 | no | [R2 pricing](https://developers.cloudflare.com/r2/pricing/) |

What the pages say about periods and overruns:

- Workers: the daily request limit resets at midnight UTC; above it requests fail with error 1027.
- D1 and Durable Objects: "Free limits reset daily at 00:00 UTC"; above any one free limit "further
  operations of that type will fail with an error" (DO pricing).
- DO duration is wall-clock active time × 128 MB. The DO pricing page computes "1,000,000 seconds * 128
  MB / 1 GB = 128,000 GB-s", so the dashboard converts `activeTime` (µs) as `activeTime / 1e6 × 0.128`.
- R2: the free tier is monthly and applies to Standard storage only. "A GB-month is calculated by
  averaging the *peak* storage per day over a billing period (30 days)." The dashboard compares the
  current stored bytes with 10 GB and uses the UTC calendar month to date for operations: an
  approximation of Cloudflare's billing period.
- R2 operation classes, as the dashboard counts them. Class A: `ListBuckets`, `PutBucket`, `ListObjects`, `PutObject`, `CopyObject`, `CompleteMultipartUpload`, `CreateMultipartUpload`, `LifecycleStorageTierTransition`, `ListMultipartUploads`, `UploadPart`, `UploadPartCopy`, `ListParts`, `PutBucketEncryption`, `PutBucketCors`, `PutBucketLifecycleConfiguration`. Class B: `HeadBucket`, `HeadObject`, `GetObject`, `UsageSummary`, `GetBucketEncryption`, `GetBucketLocation`, `GetBucketCors`, `GetBucketLifecycleConfiguration`. Free: `DeleteObject`, `DeleteBucket`, `AbortMultipartUpload`.
  Also counted as Class A, on purpose: `DeleteObjects` (the bulk delete of a Worker's
  `bucket.delete([...])`), which the live account returns (sample of 2026-09-30) but the R2 pricing page
  lists in no class (it names only the single `DeleteObject` as free); counting it as Class A is the
  cautious choice and it is not reported as unclassified. Any other `actionType` also counts as Class A
  (cautious) and is reported as unclassified.

**Guard rule** (owner rule "pause non-critical jobs above 80 %"): a daily resource or a monthly R2
operation class at ≥ 80 % of its allowance puts both apps into `shed` until the next UTC midnight + 60
min (renewed while still ≥ 70 % that day; the hour covers one failed or late renewal at the 00:00
tick). The thresholds compare the measured value with the allowance (`used ≥ 0.8 × allowance`), not the
percent shown, which is rounded to 0.1 (79.95 % shows as 80.0 % and does not shed); storage never triggers, because `shed` defers cleanup,
which would make storage worse. Details: [`design.md`](design.md) §5.3.

**Projection** ("按当前速度线性估算"): daily `used × 86400 / elapsed seconds` of the UTC day (none
during the first 3 hours, where one early job would dominate); monthly `used × days in month / elapsed
days` (none during the first day); none for storage. It is a straight-line estimate, not a forecast,
and the page says so.

## 2. Platform limits the design relies on

| Limit | Value (Free) | Where it matters | Source |
| --- | --- | --- | --- |
| CPU per HTTP request and per Cron Trigger invocation | 10 ms | the fetch and scheduled handlers only authenticate, route and make one RPC to `HomeState` | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) |
| CPU per Durable Object invocation | 30 s (default) | all GraphQL parsing, aggregation, guard, canary and digest work runs in `HomeState` | [DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/) |
| Subrequests | 50 per request | a tick makes at most 9 outbound calls (2 `status`, 1 website probe, ≤ 2 `setGuard`, ≤ 2 canary calls, ≤ 1 `reportOps`, 1 GraphQL; `outboundPerTick()` in the registry, tested ≤ 30) | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) |
| Worker invocations per request | 32; each service-binding call counts, and counts as a subrequest | same bound as above | [Service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/) |
| Service-binding request fees | "do not incur additional request fees" | the `Ops` calls | [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) |
| Static assets | free and not counted only when served without invoking the Worker; with `run_worker_first` every asset request invokes the Worker and counts as a Worker request (above the daily limit it gets a 429, no fallback to free asset serving) | the UI (`ASSETS`): `run_worker_first = true` (Access check and private headers on every path), so each HTML, JS, CSS and icon fetch counts in `workers_requests`, and once the account reaches 100,000 requests a day the page itself is unavailable until 00:00 UTC | [Static assets billing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/) |
| Cron Triggers | 5 per account | one trigger `*/30 * * * *` (the account used 1 of 5 before the dashboard) | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) |
| Memory | 128 MB per isolate | GraphQL answers over 1 MB are refused | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) |
| GraphQL Analytics API | 300 queries per 5 min; account-scoped queries cover 1 account | one query per tick, owner refreshes ≤ 1 per minute | [GraphQL limits](https://developers.cloudflare.com/analytics/graphql-api/limits/) |
| Token permission for account analytics | "Account Analytics: Read" | `CF_ANALYTICS_TOKEN` ([`setup.md`](setup.md) §4) | [API token auth](https://developers.cloudflare.com/analytics/graphql-api/getting-started/authentication/api-token-auth/) |

## 3. What the dashboard itself uses per day

48 cron ticks: 48 Worker requests and 48 Durable Object requests; at most 96 `status()` calls (Mail
Hero ≤ 6 and Todofy ≤ 5 indexed D1 statements each, contracts/ops-v1); at most 48 GraphQL queries; a
few `setGuard`, canary and `reportOps` calls; one canary a day (one synthetic message stored in Mail
Hero's R2 and D1 and normally one Gemini call in Todofy, up to 3 when a transient failure is retried),
up to 3 more when the owner runs it by hand; at most 48 public GETs of the website's `build-info.json`
(v2 probe, outside Cloudflare's allowances) plus owner refreshes (≥ 10 min apart). Each tick
writes about 10–40 SQLite rows in `HomeState` (v2 adds two: `cf_scripts` and `probe:website`); a v1
overview reads at most 30, a v2 view at most 24 (`V2_ROWS_READ`, measured in workerd). Each owner page load
counts one Worker request per fetched file (HTML, scripts, styles, icon: `run_worker_first`, §2) plus one
per API call, and a DO request per API call. All of this is far below every allowance in §1.

## 4. Not yet verified

To be checked in production and recorded in [`verification.md`](verification.md):

- whether an app's `Ops` calls appear in `workersInvocationsAdaptive` for `mail-hero`/`todofy` (they
  are service-binding calls, which carry no request fee);
- whether R2 `actionType` values beyond the lists above occur (they would show as unclassified).
  `DeleteObjects` did (live sample of 2026-09-30) and is now counted as Class A (§1); the other values
  of that sample (`PutObject`, `CompleteMultipartUpload`, `GetBucketLifecycleConfiguration`,
  `PutBucket`) are on the lists;
- how far the analytics datasets lag behind a tick (a late dataset under-reports the day so far);
- `durableObjectsStorageGroups` returned no rows on this account when the query was verified, so
  `do_storage` shows "无数据" until it does.

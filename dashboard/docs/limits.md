# Home quota configuration and budgets

These are the dashboard's configured Workers Free reference allowances, mirrored from `worker/src/limits.ts`.
They are account-wide observations, shared with every Worker, database and bucket in the account. The numeric
values, guard flags and source links below are executable documentation: `worker/test/limits.test.ts` checks them
against the implementation. Changing a configured allowance requires reviewing the provider's current primary
documentation and the code together; this page is not a live billing or account verification.

## 1. Configured quota rows

| Resource id | Period | Allowance | `limits.ts` value | Guard trigger | Source |
| --- | --- | --- | --- | --- | --- |
| `workers_requests` | day | 100,000 requests | 100000 | yes | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/#daily-requests) |
| `d1_rows_read` | day | 5,000,000 rows | 5000000 | yes | [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) |
| `d1_rows_written` | day | 100,000 rows | 100000 | yes | [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) |
| `do_requests` | day | 100,000 requests (HTTP, RPC, alarms) | 100000 | yes | [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) |
| `do_duration` | day | 13,000 GB-s | 13000 | yes | [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) |
| `do_rows_read` | day | 5,000,000 rows (SQLite) | 5000000 | yes | [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) |
| `do_rows_written` | day | 100,000 rows (SQLite; each `setAlarm()` is one) | 100000 | yes | [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) |
| `ai_neurons` | day | 10,000 Neurons (Workers AI, all models) | 10000 | no | [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) |
| `r2_class_a` | month | 1,000,000 operations | 1000000 | yes | [R2 pricing](https://developers.cloudflare.com/r2/pricing/) |
| `r2_class_b` | month | 10,000,000 operations | 10000000 | yes | [R2 pricing](https://developers.cloudflare.com/r2/pricing/) |
| `d1_storage` | total | 5 GB per account | 5000000000 | no | [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) |
| `d1_database_max` | per database | 500 MB (the largest database is shown) | 500000000 | no | [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) |
| `do_storage` | total | 5 GB (SQLite-backed objects) | 5000000000 | no | [DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/) |
| `r2_storage` | total (GB-month) | 10 GB-month (Standard storage only) | 10000000000 | no | [R2 pricing](https://developers.cloudflare.com/r2/pricing/) |

The dashboard uses decimal GB (10⁹ bytes). Usage/storage samples and their freshness come from their respective
provider datasets; an absent dataset is unknown, not zero. Storage references and straight-line projections do not
establish a bill or a hard spending cap. R2 operation classification follows `worker/src/usage.ts`: unclassified
actions are conservatively counted as Class A and remain explicitly unclassified in the view.

## 2. Guard and projection rules

Only configured trigger rows can enter automatic shed, at measured usage of at least 80%, held at least 70% on the
same UTC day. Display rounding cannot trigger it. Storage and Workers AI do not trigger; per-service capability and
acknowledgement still gate writes. Unknown usage cannot start a new shed, and an existing one expires rather than
being renewed without evidence. See [guard behavior](design.md#53-per-service-guard).

Daily projection is `used × 86400 / elapsed_seconds`, suppressed during the first three UTC hours. Monthly
projection is `used × days_in_month / elapsed_days`, suppressed during the first day. Storage is not projected.
The UI labels this a straight-line estimate.

## 3. Executable resource bounds

- The edge handler authenticates/routes; aggregate work runs in HomeState. CPU regression thresholds live in
  `worker/test/runtime/cpu.test.ts` and `api-cpu.test.ts` and run without cached CPU results.
- `outboundPerTick()` derives the allowed call count from registered statuses/probes, guarded producers, the canary,
  digest and bounded drift steps. Tests pin it below `MAX_OUTBOUND_PER_TICK`; adding an app must preserve that bound.
- GraphQL responses are capped at one megabyte; fetches have deadlines. Usage refresh attempts are at most one per
  minute. Scheduled ticks are half-hourly; every producer status is attempted at most once per ten minutes.
- View sizes and actual SQLite reads are checked separately for ordinary fixtures and retained-decision stress.
  `VIEW_ROWS_READ_MAX` is a regression bound, not a universal billing or object-size limit.
- Home's assets pass through its Worker for authentication/private headers. Page polling, probes, Ops calls,
  analytics, drift and manual refreshes all consume their relevant resources; no fixed daily cost estimate covers
  every registered producer or owner session.

Run `bazel test //dashboard:check` for acceptance. Historical measurements and live checks are scoped and dated in
[verification.md](verification.md); current configuration ownership is in [setup.md](setup.md).

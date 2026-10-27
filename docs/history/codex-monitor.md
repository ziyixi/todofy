# Codex monitor (archived 2026-10-27)

Moved from `docs/codex-monitor-verification.md` on 2026-10-27, when the cleanup wave in [HANDOFF](../../HANDOFF.md)
set out to remove this monitor. It describes the monitor as accepted on 2026-10-25 and is not a statement of
current production state.

## Persistent daily usage

The implementation `0e3b78ed970e87f0a2c86892d90d53f19f687f8b` passed
[full branch CI 40237892117](https://github.com/ziyixi/todofy/actions/runs/40237892117) and
[same-SHA main release 40238899660](https://github.com/ziyixi/todofy/actions/runs/40238899660).
It superseded the initial process-only statistics described below.

Gateway saved UTC completion-day aggregates and its latest eight content-free requests in
`DATA_DIR/inference-monitor.sqlite3`. The Deployment reused `platform-state` through the isolated
`codex-gateway` subPath at `/var/lib/codex-gateway`. Platform provisioned that directory as its existing user
before Gateway deployment; the login mount was separate. No new volume, database service or polling loop was
added. Daily rows persisted, with the latest thirty recorded days returned; Home filtered Today, 7-day and 30-day
calendar ranges and showed the persistent history start. Earlier unrecorded usage was not guessed.

A real synthetic 6.1 call at `2026-10-25T22:18:07.346Z` recorded one completed request, one success, zero failures,
4,666 input / 15 output tokens and 4,511.1 ms. A separate health request reopened the SQLite file and returned
the same daily row. The natural observation at 22:20:12 UTC reached Home after its 22:20:38 UTC refresh.
Real Chrome checks of Today, 7-day and 30-day selectors showed the matching counts, token totals and daily row.
Runtime status returned HTTP 200, its release was ready and its reconcile plan clean; all four VPS Deployments
were ready. The existing reminder dismissals were preserved.

Physical local database tests covered reopen, a new monitor instance, UTC midnight, failure/unknown usage and
retained samples. Gateway passed 32 tests; Home passed 176 UI tests and its build. A thirty-day/eight-sample
health response measured about 8 KiB, so its bounded read became 12 KiB; NodeStatus/HostReport stayed at 12/16 KiB.
No extra production restart was forced, and no real mail, task or Notion content was used for acceptance.

The first staged rollout exposed an older reconcile-contract omission: three existing Gateway resource aliases
were missing and the change-list bound was ten while the fixed resource inventory had thirteen entries.
The new mount made that drift visible and caused `nodeStatus` to return INTERNAL. A real Planner/Service
transition regression reproduced the failure and passed after correction. The exact two output-rule changes
were recorded in `proto/reviewed-rules.json`; all other compatibility guards remained strict. Consumers deploy
before producers.

## Initial rollout

Implementation `1e86e6763ab30e3614ea2afdd9f6b9e334f1371d` passed the complete
[branch CI 40230659454](https://github.com/ziyixi/todofy/actions/runs/40230659454) and
[same-SHA main release 40232060456](https://github.com/ziyixi/todofy/actions/runs/40232060456).

Home's Codex page showed process-lifetime request counts, results, reported tokens, full gateway latency and
eight recent content-free completions, which reset on restart. The existing five-minute host observer forwarded
the actual sample time through Fleet; opening the page did not start an inference. Mailsort separately persisted
daily classification attempts and reported usage in its existing DO, showed current UTC-month totals and cleaned
daily rows after 400 days. No pre-upgrade usage was inferred and no price or remaining quota was fabricated.

At `2026-10-25T20:48:50.398Z`, a real synthetic `gpt-6.1-sol` / medium request on the VPS loopback endpoint
succeeded with 4,671 input / 15 output reported tokens in 3,578.9 ms; the monitor reported one request, one
success and one sample. The natural host observation at 20:50:14 UTC reached Fleet and Home, and a real Chrome
refresh showed the same request. Mailsort's production status returned zero Codex usage for 2026-10 before any new
classification, as expected, since the synthetic request bypassed Mailsort.

Local validation covered Gateway 29, Platform 135 (+143 subtests), Fleet 67 unit and 10 workerd, Mailsort 229 unit,
115 workerd/CPU and 106 UI, and Home 173 UI tests. Eight longest permitted samples stayed within the existing
4/12/16 KiB health, NodeStatus and HostReport limits. Linux CI measured Mailsort at 148.8 KiB gzip and Recall at
130.4 KiB against budgets raised to 150/132 KiB for this feature; CPU and spending limits were unchanged.

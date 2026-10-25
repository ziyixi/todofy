# Codex monitor verification

Implementation `1e86e6763ab30e3614ea2afdd9f6b9e334f1371d` passed the complete
[branch CI 40230659454](https://github.com/ziyixi/todofy/actions/runs/40230659454) and
[same-SHA main release 40232060456](https://github.com/ziyixi/todofy/actions/runs/40232060456).

## Monitoring and usage scopes

[Home's Codex page](https://home.ziyixi.science/#/ops/codex-gateway) shows process-lifetime request counts,
results, reported tokens, full gateway latency and eight recent content-free completions. These reset on
restart. The existing five-minute host observer forwards the actual sample time through Fleet; Home keeps
its normal cached reads and manual refresh. Opening the page does not start an inference.

[Mailsort](https://sort.ziyixi.science/) separately persists daily classification attempts and reported usage
in its existing DO, shows current UTC-month totals, and cleans daily rows after 400 days. Provider switching
retains both histories. Failed responses retain any reported tokens; absent usage is explicitly unknown.
No pre-upgrade usage is inferred, no price or account-wide remaining quota is fabricated, and no old mail is reclassified.

## Actual production observations

At `2026-10-25T20:48:50.398Z`, a real synthetic `gpt-6.1-sol` / medium request succeeded on the VPS loopback
inference endpoint using the existing inference-only credential. Reported usage was 4,671 input / 15 output
tokens; the gateway measured 3,578.9 ms. Its baked source SHA matched the implementation and its monitor
reported one request, one success, zero failures and one sample. This check used no mail, task or Notion content.
The unchanged public Tunnel/Access inference path was not retested by this loopback request.

The natural host observation at 20:50:14 UTC reached Fleet and Home. A real Chrome refresh at
20:51:07 UTC showed the same request, tokens and successful recent row, with 3.6 seconds displayed.
The page separately shows its actual sample and process start times. All four VPS Deployments were ready;
their running Pods had zero restarts. Existing reminder dismissals were not changed.

Mailsort's production `serviceStatus` returned `codex_usage` for `2026-10`, model `gpt-6.1-sol`, with zero
requests/tokens and no latest usage time. This is expected before a new Mailsort classification: the synthetic
service request above bypassed Mailsort. No real classification batch was triggered for acceptance.

## Local and CI checks

Local validation covered Gateway 29 tests, Platform 135 plus 143 subtests, Fleet 67 unit and 10 real workerd/SQLite
tests, Mailsort 229 unit, 115 real workerd/CPU and 106 UI tests, and Home 173 UI tests. Affected lint, typechecks,
builds, AIP lint and breaking checks passed. The full branch gate also checked shared-proto consumers.
The real Home build was inspected in Chrome with synthetic desktop and 390px iframe views; this was not a phone test.

Eight longest permitted model samples occupy 2,809 bytes in healthz, 4,363 in NodeStatus and 4,957 in HostReport,
within the existing 4/12/16 KiB limits. Linux CI's new descriptor/usage code measured Mailsort at 148.8 KiB gzip
and Recall at 130.4 KiB; intentional budgets are 150/132 KiB. CPU and spending limits were not raised.
No service, persistent Gateway store, paid product, credential or polling loop was added.

# Mailsort Codex hourly verification

Implementation branch: `codex/mailsort-codex-batch`, based on `377ca774`.
This record distinguishes local tests, model experiments, CI and actual deployment.

## Authorized behavior

The owner chose GPT-6.1 Sol medium and hourly classification of ungraded unread mail.
The first production operation explicitly includes **all currently unread** mail, including existing P1-P4.
Only priorities and Inbox/archive positions may change; read state, stars, other labels and messages remain.
Afterward routine runs skip mail already carrying a priority. No manual run substitutes for the first natural Cron.

## Local prompt experiment

The same private snapshot of 100 received messages, frozen evaluation time and unchanged prompt was used once
per effort. It includes read and archived mail, so this is not proof of the production unread selector.
Input and per-message outputs stay outside the public repository. Same existing subscription authentication;
old SDK 0.156.1 returned model_not_found; temporary SDK/CLI 0.163.0 completed all three requested settings.
Newsletter dependencies/source were not changed by the experiment.

| Effort | Seconds | Input tokens | Output tokens | Reasoning subset | Total | P1/P2/P3/P4 |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| medium | 104.58 | 94,837 | 3,469 | 139 | 98,306 | 1/3/17/79 |
| high | 147.45 | 94,837 | 4,530 | 850 | 99,367 | 1/3/18/78 |
| max | 406.69 | 94,837 | 15,021 | 11,671 | 109,858 | 1/2/16/81 |

Every SDK response returned all 100 unique IDs; accepted model and effort matched the request, with one turn
per setting and complete usage. Cached input was zero. Reasoning is included in output/total and is not added again.
High/max overlapped, so latency is an observation rather than a controlled benchmark. Subscription credit cost
was not measured. Medium/high agree on 99 messages; medium/max on 97. These are agreement counts, not accuracy.
Reviewed differences concern repeated notices and reading cadence; the snapshot supports medium as a default,
without establishing an independently labeled accuracy score.

## Local implementation checks

- Worker: 153 unit tests; lint and all three TypeScript configurations.
- Real workerd: 65 tests including generated machine HTTP, SQLite storage, multi-run 103-message recheck,
  write caps and new arrivals, failure state, and CPU. No actual Codex/Gmail call.
- UI: 76 tests, lint/types/build. New hourly status, all-unread scope, no old budget/replay/learning controls.
- Deployment helpers: 26 synthetic tests, including Gmail grant exclusion and secret preservation.
- Real local Wrangler smoke: 67 synthetic Google requests independently checked against the closed operation
  table; four priorities, read/star/other preservation, duplicate report, failed model, next run, all-unread,
  actual Codex flow counters, owner CSRF, machine Bearer, v1 reload response and Gmail auth stop.
- The smoke exposed a real own-write-history/recheck ordering bug. The original failing sequence now succeeds
  after initializing current_labels from the actual claim labels and ignoring history events that do not change
  that set. No extra sync pass, post-model Gmail check or recovery framework was added.
- Platform implementation agent verified 287 related tests, with one real-k3s check reserved for CI, and compatible
  root proto/schema changes. Runtime template observation keeps the original process-state enum and distinguishes
  installed CronJob config from actual model execution.

CPU remained under the existing Worker/DO bounds. One local run measured the cold Worker around 2.16 reference ms,
10-message/12k claim around 0.51 Worker + 38.08 DO ms, 100-result report around 0.79 Worker + 42.80 DO ms and
five writes in an Alarm around 10.97 DO ms. These are local reference measurements, not Cloudflare telemetry.

## Pending CI and production evidence

- [ ] Complete branch CI gate and real three-image build/smoke.
- [ ] Same green SHA main release, exact machine Access resources and managed identities.
- [ ] Worker digest secret and independent VPS raw token agree; Gmail secrets preserved.
- [ ] New runner image is anonymously pullable by fixed digest.
- [ ] Independent official Codex login: currently waiting for owner Passkey verification. Do not copy
  Newsletter credentials or change sign-in channels to bypass the challenge.
- [ ] Fixed main bundle foundation installed with owner sudo; existing ledgers/volumes preserved.
- [ ] Same release resumed through Actions; CronJob template verified, separate from business success.
- [ ] Authorized current-all-unread cohort queued before the natural run, without changing mode/budgets.
- [ ] First natural hourly run: model/effort/prompt, complete report, actual Gmail outcomes and remaining writes.
- [ ] Mailsort, Fleet and Home accurately display the new result and any wait/error, without private content.

No production batch or cleanup is claimed complete by this local record.

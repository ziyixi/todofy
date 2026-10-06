# Website daily sync verification

Recorded 2026-10-04; daily-window evidence updated 2026-10-06. The release contract is in
[website/docs/release.md](../website/docs/release.md). This record separates fixture checks from
production observations; it contains no article content or credentials.

## CI and synthetic checks

[Branch CI 37239704754](https://github.com/ziyixi/todofy/actions/runs/37239704754) and
[main CI 37240050911](https://github.com/ziyixi/todofy/actions/runs/37240050911) succeeded for
`da35586e171f4eb8a9df93746f4b5948008ec8f3`.
Website checks cover formatting, lint, types, unit tests, empty/fixture static builds, browser tests,
the complete deployment route contract and both Worker dry-runs. Contract and proto checks passed.
The branch run skipped all production deployments.

Fixtures prove receipt validation, unchanged checks without deployment, failed builds preserving
actual check time, cancellation and run-attempt separation, missing evidence remaining unconfirmed,
lost-response correlation and explicit complete Draft/archived withdrawal. They do not prove real
Notion permissions, a natural Cron invocation or live provider recovery after an outage.

## Production publication and manual sync

| Observation | Result |
| --- | --- |
| [Push release 37240089943](https://github.com/ziyixi/todofy/actions/runs/37240089943) | Successful run and `SYNC_PUBLISHED`; the live site and accepted release identity matched. |
| [Home manual sync 37240413731](https://github.com/ziyixi/todofy/actions/runs/37240413731) | Successful run and `SYNC_UNCHANGED`; actual check time advanced to `2026-10-04T22:34:02.831Z`. |
| Unchanged publication | Verified publication time remained `2026-10-04T22:30:18Z`; Worker version remained `0f0cb495-1c3e-43e4-bf60-4fe7800b6472`. |
| Concurrent Home requests | [37240561083](https://github.com/ziyixi/todofy/actions/runs/37240561083) and [37240589649](https://github.com/ziyixi/todofy/actions/runs/37240589649) both completed successfully with `SYNC_UNCHANGED`, checked at `2026-10-04T22:36:55.356Z` and `2026-10-04T22:38:23.230Z`. The second moved from pending to in progress after the first, demonstrating the real release queue. |
| Fresh Home observation | After refresh, Home showed unchanged content checked at 15:39 local / 22:39 UTC, the same version and code identity, publication at 15:30 local / 22:30 UTC, and the next check at 03:17 local / 10:17 UTC on October 5. |

Accepted site identity:

```json
{
  "codeSha": "4fd173f06ba7048061a86b5a0a5486852c9ad9a8",
  "contentHash": "945feb95289b6b947da6173935ba22c6c9d63a47032f50f96f27ca9f05d34597",
  "configHash": "9b41cd6f50df5a2b1781f2f9e97bba783a72e8dfb1ad0addf7b7c0134e045beb",
  "schemaVersion": 1
}
```

The relay and Home report `BUILD_SHA=da35586`, and Home has the `WEBSITE_SYNC` Ops service binding.
The relay's actual Cron is `17 10 * * *`; its only secret is `GITHUB_DISPATCH_TOKEN`.
It does not hold Notion credentials.

An additional cron-labelled [run 37240716771](https://github.com/ziyixi/todofy/actions/runs/37240716771)
started at `2026-10-04T22:37:25Z`, about nine minutes after the relay Cron configuration changed at
22:28:02 UTC. It succeeded with `SYNC_UNCHANGED`, checked at `2026-10-04T22:39:30.758Z`.
[Cloudflare documents](https://developers.cloudflare.com/workers/configuration/cron-triggers/#2-update-configuration)
up to 15 minutes for Cron changes to propagate. The timing is consistent with propagation of the
previous schedule, but that is an inference; the exact event source was not established. This run
does not verify the new daily 10:17 UTC schedule.

## Daily-window checks observed on October 6

Cloudflare's live relay schedule reads `17 10 * * *`. Both expected daily windows produced
completed Actions runs with matching content-check receipts:

| Daily window | Actions run and request ID | Receipt and actual check time | Final receipt status |
| --- | --- | --- | --- |
| October 5, 10:17 UTC | [37295602784](https://github.com/ziyixi/todofy/actions/runs/37295602784), created `2026-10-05T10:17:10Z`; `068cc3b3-aea9-440f-afe6-e229f551f370` | Deployment `6856525116`; `checked_at=2026-10-05T10:18:37.560Z`; `decision=unchanged` | `success`, `SYNC_UNCHANGED`, recorded `2026-10-05T10:18:40Z` |
| October 6, 10:17 UTC | [37448792826](https://github.com/ziyixi/todofy/actions/runs/37448792826), created `2026-10-06T10:17:27Z`; `cc85f7db-9b7c-4c89-ace7-e0c5885737f8` | Deployment `6881400090`; `checked_at=2026-10-06T10:18:57.147Z`; `decision=unchanged` | `success`, `SYNC_UNCHANGED`, recorded `2026-10-06T10:18:59Z` |

Both runs completed successfully on attempt 1. Their titles specify `Website release (cron)`;
each receipt's run ID, attempt and request ID match its run. In both runs,
`Verify production still serves the recorded baseline` and the complete snapshot/check steps
succeeded. Worker upload, deployment and release-recording steps were skipped. Neither run
created a `website-release` Deployment.

Publication evidence must be compared with the baseline for each date:

| Check | Accepted release baseline | Verified publication time | Worker version and website code identity |
| --- | --- | --- | --- |
| October 5 | Deployment `6847660009`, run `37240089943` | `2026-10-04T22:30:18Z` | `0f0cb495-1c3e-43e4-bf60-4fe7800b6472`; `4fd173f06ba7048061a86b5a0a5486852c9ad9a8` |
| October 6 | Deployment `6878226863`, [push run 37429581617](https://github.com/ziyixi/todofy/actions/runs/37429581617) | `2026-10-06T07:28:14Z` | `2fd07a7c-6a1c-461e-848d-219e4bec85b7`; `30fd74d207756ddc12c464e94ef1b42a415a6fd5` |

The later baseline came from normal code pushes, including [37410200559](https://github.com/ziyixi/todofy/actions/runs/37410200559).
Both daily receipts retain the content/config hashes recorded above. Cloudflare's deployment
history confirms no deployment changed the serving website version between October 4's accepted
release and October 6's first code push. The current version remains `2fd07a7c` at 100% after
October 6's daily check.
Its deployment was created at `2026-10-06T07:27:43.311506Z`; the verified publication time comes
from the later successful GitHub release status, as shown in the table.

Home was observed on October 6, after both windows. Its website-sync panel showed:

- A completed, unchanged check at `2026-10-06T10:18:57.147Z`, linked to `37448792826`.
- Verified publication at `2026-10-06T07:28:14Z`, linked to `37429581617`, with version `2fd07a7c` and code `30fd74d`.
- The next automatic check at `2026-10-07T10:17:00.000Z` (October 7, 03:17 in Los Angeles).

Home showed normal website-sync status and an all-normal overview. This acceptance only read the
UI; it did not request a sync or dismiss/restore reminders. It does not claim an October 5 Home
observation. A direct public `build-info.json` read from this workstation did not complete
(HTTP 403 / browser blocked); the successful live-baseline checks above are Actions evidence,
not a fresh direct identity read from this workstation.

Controller provenance remains pending. The relay's deployed scheduled handler is its only
application path that dispatches `cron`, and the run times match the live daily schedule.
GitHub nevertheless exposes `cron` as a workflow-dispatch input, and receipt payloads do not
record the Cloudflare event source. These observations verify the daily-window checks and
unchanged behavior, but do not independently prove the scheduled-controller source. The next
step is to correlate an existing relay `daily_sync` log's `run_id` with one of these runs.
Existing token permissions currently block that log query; the owner permission request is
already pending. Do not create a manual run as replacement evidence.

## Notion cleanup

Only the configured Blog data source was changed: eight operational fields were removed, eight
content fields retained their names, the sole retained view was renamed to `内容`, and two old views
were removed. The operational description was replaced with one sentence of content instructions.
Both rows retained their content and date values. Body comparisons
normalized transient signed URLs and connector references to stable file IDs; all 20 media references
were unchanged. A full subsequent snapshot retained the same content hash above.

Two legacy writer workflows were disabled. Their history was retained and PR checks remained active.
The new release reads Notion content without writing operational properties or descriptions.

## Evidence to read

Keep the two GitHub ledgers separate:

| Ledger | Minimum fields |
| --- | --- |
| `task=website-content-sync`, `environment=website-content-sync` | Deployment `id`, `sha`; payload `schema_version`, `run_id`, `run_attempt`, `request_id`, `checked_at`, `decision`, `identity`; latest status `state`, `description`, `created_at`, `log_url`. |
| `task=website-release`, `environment=production` | Deployment `id`, `sha`; payload `schemaVersion`, `identity`, `workerVersionId`, `previousWorkerVersionId`, `liveOrigin`, `workflowUrl`; latest status `state`, `created_at`, `log_url`. |

Project only these fields; do not print the full release payload or its content registry.
The receipt's `checked_at` is the actual content check time; the successful release status's
`created_at` is the verified publication time. Deployment `sha` identifies the pinned green checkout,
while `identity.codeSha` identifies its last change to `website/`; they may differ.
An Actions success without its required receipt does not prove a content check or publication.

## Pending production checks

- Independent Cloudflare scheduled-controller provenance for a daily-window run, using its
  existing `daily_sync` log and exact run ID. Keep the acceptance follow-up active until confirmed;
  do not repeatedly query the denied endpoint while owner permission is pending.
- Live outage, cancellation and rollback exercises. Current evidence for these paths is synthetic;
  this acceptance did not deliberately interrupt production.

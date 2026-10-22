# Work-memory release verification

This release extends the existing Personal Cloud App. It keeps the OAuth audience, private plugin identity,
existing services and Free-plan budgets. It adds no model API, service, database resource or scheduler.

## Local evidence

- Work records, checkpoints and reports use real SQLite. Tests cover exact write retries, report deduplication,
  independent checkpoint/report sequences, scoped links, context pagination after closing a previous item,
  Unicode pagination, and structured per-work Watch decisions.
- Watch management tests exercise the generated private API: preview, dedicated creation with `NONE`, partial
  updates, current-state read-back after pause/resume, shared refs and explicit missing/truncated evidence.
- Watch-feed tests verify linked open work only, stable reports after an interrupted cursor advance, health
  transitions, first-read failure and expired cursors. A checkpoint never queues an attention event.
- Recall tests verify the filtered activity route, WebP/JPEG MCP image content and an explicit missing archived
  image. Synthetic image bytes in these transport tests alone do not prove that Dots viewed a real image.

MCP TypeScript/lint, 64 unit tests, 7 real workerd tests and 9 deploy-wrapper tests pass locally. The workerd
journey observes a real 60-second Watch poll after restart, a scoped signed callback, silent checkpoints and
the source evidence reference. Recall's changed private service passes its two runtime cases. The production
wrapper dry-run includes `WATCH (watch#WatchApi)` and retains the existing single SQLite DO.

Watch's Worker unit tests, generated-API/runtime checks, Web tests/build, proto lint/schema/breaking checks and
bundle check passed locally. Full branch CI, deployed identities and actual-client checks are recorded below as
they finish.
No production mail, private task, browsing record or watched page is used as a test fixture.

## Release, 2026-10-22 UTC

| Evidence | Result |
| --- | --- |
| Implementation | `841839451ec1bb72d87b2a0b8eeda79be8f1c4ad` |
| Complete branch gate | [39777372400](https://github.com/ziyixi/todofy/actions/runs/39777372400), success |
| Same-SHA production release | [39779693261](https://github.com/ziyixi/todofy/actions/runs/39779693261), success |
| Recall | Version `2416ed04-0d9a-476e-98e1-5c78ce52cbe6`, verified deployment `7252383787` |
| Watch | Version `e655514b-e80c-4736-986f-8d1b319c289d`, verified deployment `7252386289` |
| Personal MCP | Version `bfff33e3-de78-4227-862b-2a37fbe4ea07`, verified deployment `7252401207` |
| Home | Version `c8a902fc-faeb-4bb4-b14f-6c3f4bab3ad1`, verified deployment `7252422604` |
| Authenticated existing connection | `connection_status` returned the full implementation SHA and `stage: work_memory` |
| Existing persisted state | Zero active subscriptions, zero pending deliveries; the two previously accepted callbacks remain. Work counters initialize at zero |
| Plugin skill | Private Personal Cloud `1.2.0`, release `pluginrel_6ada0448ad7881918c817eadd1b7b36a`; read-back matches repository source |
| Plugin preservation | App binding, presentation, owner connection and private sharing unchanged |

The deployment scope was exactly Watch, Recall, MCP and Home. Other services, extensions, application budgets and
operating switches were not changed. Work state remains in the existing SQLite DO. The rollout created no
production Work, Watch or Task. A public document at this exact code revision was opened for Recall QA; its
exact page lookup returned `NOT_FOUND`, so no image acceptance is claimed. Private browsing history was not read.

## Real-client acceptance still pending

Local workerd discovery verifies 34 tools and six events. The existing account's imported tool catalog still
needs **Refresh tools** on the Personal Cloud Manage page. The browser reached that page, but native computer
use then reported that the Mac was locked. The owner was asked only to unlock it; no alternate login or credential
route was attempted.

After unlocking:

1. Refresh the existing App's tool catalog and verify the same App/connection, 34 tools and six events.
2. Use only a clearly marked synthetic Work to verify a native `work.attention` subscription, source report,
   payload-specific Dots continuation and handled-through checkpoint. Stop the test subscription afterward.
3. Preview and create a dedicated synthetic Watch with `NONE`, inspect its real health and source evidence,
   then pause it and confirm the owned link before closing the Work. Do not change an existing Watch.
4. Read one newly recorded public test page through `recall_view` and verify an actual visible MCP image.
   No real browsing record has been read for this acceptance.
5. Create or reuse the agreed native hourly overall Work review, recording its real schedule identity only
   after creation. Keep unchanged reviews quiet. It has not been created by this rollout; `review_at` is not a timer.

Do not count an uploaded Worker, a local receiver, a returned base64 string or callback acceptance as actual Dots
continuation, image viewing or native scheduled execution. No such live checks are claimed yet.

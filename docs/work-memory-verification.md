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

MCP TypeScript/lint, 63 unit tests, 7 real workerd tests and 9 deploy-wrapper tests pass locally. The workerd
journey observes a real 60-second Watch poll after restart, a scoped signed callback, silent checkpoints and
the source evidence reference. Recall's changed private service passes its two runtime cases. The production
wrapper dry-run includes `WATCH (watch#WatchApi)` and retains the existing single SQLite DO.

Watch's Worker unit tests, generated-API/runtime checks, Web tests/build, proto lint/schema/breaking checks and
bundle check passed locally. Full branch CI, deployed identities and actual-client checks are recorded below as
they finish.
No production mail, private task, browsing record or watched page is used as a test fixture.

## Release and client evidence

Pending. Do not treat a local pass, a successful upload or an accepted callback as actual Dots continuation.

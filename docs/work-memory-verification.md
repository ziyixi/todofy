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

## Native Dots acceptance, 2026-10-23 UTC

The existing App's **Refresh tools** completed. Its detail page showed 14 write tools, 20 read tools and six
events, including `work.attention`; the App identity and OAuth connection stayed unchanged. The existing Dot
still had its old 18-tool catalog. A fresh ordinary conversation could not display its responses and supplies
no acceptance evidence. The owner then explicitly authorized **Reboot** of the existing Dot. Its confirmation
said conversations, memories and scheduled tasks are kept; after Restart, the same Dot could call Work/Watch.
No credential or application-code change was needed for that catalog refresh.

Only synthetic Work `cad1bde4-35b6-4003-ab4e-b97a7d3b9eed` and dedicated Watch
`watches/w-7c622935-2f25-46e3-b911-ab32378fa046` were created. The Watch targets the public example domain,
uses `NONE`, and its `owned` link was read back. Preview returned HTTP 200. The source was still awaiting its
first scheduled fetch when the report was handled: this does not prove a real webpage-change candidate.

The native subscription tool required `schedule` and `timing_mode` even for events. The inspected tool's
documented event form, `schedule: ""` and `timing_mode: "condition_watch"`, created an unscheduled webhook
(`X-UNSCHEDULED:1`, no next run), scoped to this Work. No Cron substitute was used. The native response did
not supply an independent subscription ID; none was invented.

The Dot submitted stable report `qa:c10d368c-a924-4bd0-8798-0b59bb487f83`, then received the native
`mcp_event` with event ID `work_cad1bde4-35b6-4003-ab4e-b97a7d3b9eed_3`. Its continuation matched the exact
synthetic marker, Work ID, report ID and sequence 3, and read the actual Watch. It silently checkpointed
`handled_through_report_seq=3` and read back an empty pending-report list. It did not report an acknowledgment
back into the event stream. An independent `connection_status` read confirmed that exact accepted event,
one webhook attempt, no pending deliveries and no pending Work reports. Both the native continuation and its
read-back are observed; the accepted count alone is not the evidence.

Cleanup was read back in the Dot: the scoped subscription stopped, the dedicated Watch is `paused` with an
observed `owned` link of `stopped`, and the Work is `done` with report sequence 3 handled and no pending reports.
An independent connection read confirms zero subscriptions, zero open Work and zero pending deliveries/reports;
the accepted event remains in the ledger. Other subscriptions and real Watches were not modified.

One native **Work 总体回顾** responsibility was checked by name, created and read back enabled with a real
schedule ID, retained in the owner's Dot rather than this public repository. It runs hourly, reads open/due Work
and necessary sources, checks the current executor before delegating, preserves each Work's authorized scope,
and stays quiet on unchanged/non-actionable state. Only meaningful progress, failure or an owner decision may
notify. It uses silent checkpoints and is shared (`owned: false` when linked); no extra supervisory Work was
created. The saved rule is hourly with `timing_mode: exact_schedule`, enabled, and a first DTSTART of 10:20 UTC.
The host returned `next_run_time: null`, so neither that exact firing time nor a natural execution is claimed as
verified. A later read was not attempted through the host's unfiltered schedule list. No Codex heartbeat was created.

### Actual image read

The new public test page still returned `NOT_FOUND`; the native window tool could not activate it for a fresh
capture (`noWindowsAvailable`). Its new-capture acceptance is not claimed. The existing, explicitly known public
diagnostic page `https://example.org/?recall-diagnostic=1` was found with a single bounded example-domain search.
No private browsing record was read.

The root connection read public snapshot
`pages/b3c9548ac873154e3d233ec152d82512/documents/e6a17313-b330-4df6-80de-5e8aa50ed416`:
capture time `2026-10-13T04:56:14.881Z`, 883 × 1920, archived text and no content error. The Dot then called
`recall_view` on that exact snapshot. It received real MCP image content with `image_available: true` and no
tool error, and described the visible dark page, book icon, multilingual example-domain text and purple
underlined Learn more link. This is actual image viewing of an older public fixture, not a base64/metadata
check or evidence of today's capture. The response did not identify the screenshot's backing store, so a live
Dropbox cold image read is not separately proven by the archived-text flag.

The remaining timed observation is the hourly review's first natural execution. Existing user Watches and
the earlier owner-stopped email/website observations are untouched. No new extension acceptance or production
webpage-change candidate is claimed by these checks.

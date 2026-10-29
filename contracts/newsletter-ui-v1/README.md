# Newsletter UI v1

`newsletter.ui.v1` is Newsletter's owner read API: everything the Newsletter console shows (issues with their full
content, runs and their failures, model calls, sources and the content configuration, deliveries, and the state of
the Notion backup). Source: [`proto/newsletter/ui/v1/`](../../proto/newsletter/ui/v1/newsletter_ui_service.proto);
the generated Python and TypeScript types are the contract on every side, with no hand-written DTOs. Newsletter owns
it. It is read-only: no method writes, runs, sends, retries or syncs anything.

Status: Newsletter answers every method on its console listener
([`newsletter/docs/console.md`](../../newsletter/docs/console.md)), and `fixtures/` holds its golden answers. The
console Worker ([`newsletter-console/`](../../newsletter-console/README.md), on `news.<zone>`) routes it behind the
owner's Access login and still answers every method `UNAVAILABLE` with the reason `NOT_CONFIGURED` until it forwards
reads; its UI shows that state. A change to the IDL checks and deploys Newsletter (with the paired VPS release) and the
console (`PROTO_PACKAGES`).

| Side | What it does |
| --- | --- |
| Newsletter (`newsletter/`, Python) | Answers every method from one short read-only snapshot of its SQLite database and content configuration, on a listener of its own that routes and strictly decodes requests with the generated `HTTP_BINDINGS`; writes every answer with the generated Python codec |
| Console Worker | Authenticates the owner, admits `GET` and `HEAD`, routes with the shared transcoder, forwards the request to Newsletter and passes the answer through unchanged as `PreEncoded` |
| Console UI | Calls the API with the shared client and reads every answer leniently |

## The record

Newsletter's SQLite database is authoritative for every answer. Notion is an asynchronous backup of it: the backup is
written after the fact from Newsletter's replication journal and is never a source or a step of the daily pipeline.
Newsletter reads a Notion page only to check it against the record and copies nothing back, so an edit made in Notion
does not return. The backup's state in these answers is the journal's; answering never calls Notion. The console takes
no lock of the engine and registers no deployment activity, so its reads stay available while a release has frozen the
engine's work.

## Transport and authentication

The console has one owner Access application, `newsletter-console`, with two destinations: the console's host and
`/api/newsletter/v1/*` on the platform runtime host (`platform_runtime_host` in `config/cloud.toml`). Both use the
shared owner policies and identity providers, so one owner login, and one audience, covers both.

1. The browser reaches the console Worker through that application. The Worker verifies the owner's assertion with
   `packages/edge-auth` (signature, issuer, the console's audience, lifetime, the owner's address) before anything
   else.
2. The Worker forwards an admitted request to `https://<platform runtime host>/api/newsletter/v1/<rest>`, always as a
   `GET` (it answers a `HEAD` from that without the body): the binding's `/api/v1/` becomes `/api/newsletter/v1/`, and
   the query string is kept. The only credential it sends is the assertion it has just verified, in the
   `cf-access-token` header, which Access reads for requests that are not a browser's. It never stores, logs or echoes
   it. Redirects are not followed, and a request that takes longer than 15 seconds is abandoned.
3. Access admits that path only with an assertion of the same application, and the tunnel's rule for the path
   requires that application's audience as well.
4. Newsletter verifies the assertion again before it reads anything, with PyJWT, as the Codex gateway does: RS256,
   a non-empty key ID, the team's Access certificates, the exact issuer, the console's audience (baked into the
   image at build time from `config/resources.toml`), expiry, issue and not-before times with a small leeway, a size
   cap, and an identity assertion with an email (a service token's assertion is refused). It does not compare the
   email: Access's owner policy decides who may log in, and Newsletter keeps no personal value; the signature,
   issuer and audience checks are defence in depth.

There is no service token and no stored credential: the console works with the owner's own login and stops when
that login expires.

## Wire

- Methods: `google.api.http` bindings under `/api/v1/`, all `GET`. Lists are one calendar month of issue dates as one
  page (Fleet's `ListNodes` precedent): `page_token` is reserved and must be empty, and the answer names the nearest
  earlier and later months with records. Issue dates and months are counted in the service's time zone
  (`Overview.time_zone`).
- Query parameters are integers and strings only, the kinds Newsletter's Python decoder reads: the usage range is
  `day_count` (7, 30 or 90), a month is `YYYY-MM`.
- JSON is the wire JSON profile ([`proto/README.md`](../../proto/README.md#wire-json-profile)). Every output field
  is `OUTPUT_ONLY` and written only when it has a value; Newsletter never writes `null`. Newsletter writes each
  answer with the codec's `to_wire` and compact `json.dumps(..., ensure_ascii=False, separators=(",", ":"))`, which
  are the bytes TypeScript's `toWire` and `JSON.stringify` write for the same message (its doubles are whole numbers
  or seconds to the millisecond, which both languages spell alike), so the Worker passes them through without
  parsing them.
- What the Worker answers: Newsletter's `200` with `application/json`, read under a streamed 4 MiB cap, unchanged;
  Newsletter's `404` as `NOT_FOUND` and `400` as `BAD_REQUEST`; anything else (a redirect, Access refusing, a `5xx`, a
  timeout, another content type, a larger body) as `UNAVAILABLE`, which a client may repeat, as for any failed
  dependency ([`proto/README.md`](../../proto/README.md#http-apis)). Its own authentication, configuration and
  transcoder answer `UNAUTHORIZED`, `NOT_CONFIGURED`, `METHOD_NOT_ALLOWED`, `BAD_REQUEST` and `INTERNAL`. It never
  copies Newsletter's body into an error. Every answer is `no-store`; nothing is cached at the edge.

## Bounds

| Where | Bound |
| --- | --- |
| `Overview.days` | The last 14 issue dates up to today, newest first |
| `ListRuns`, `ListEditions` | One month, at most 64 (0 means 64) |
| `ListModelCalls` | One run, at most 200 |
| `ModelCall.reported_models`, `ModelCall.router_requests` | 4 each |
| `RunNode.items` | 64 over the whole run |
| `SummarizeModelUsage` | 7, 30 or 90 issue dates, ending with the newest that has a run |
| `SourceCatalog.config_history` | 10 revisions |
| `FeedSource.recent` | The latest 7 scheduled runs |
| `BackupStatus.exceptions` | 50, oldest first |
| An answer through the Worker | 4 MiB |

## Rules that keep the console consistent

- **Budgets.** A node's budget is always the one its run froze when it started (`params.timeout_seconds` of the run's
  frozen graph), never today's configuration.
- **What stopped a run** (`RunFailure`). The earliest failed or unknown attempt of a node whose failure stops the run,
  else the first degraded node, else the run's own stop code. `timeout` is `NODE_BUDGET`; `interrupted` is
  `RUN_DEADLINE` when the attempt ended at or after the run's deadline, else `INTERRUPTED`; the run's
  `workflow_deadline` is `RUN_DEADLINE` too; `authentication`, `rate_limit`, `unavailable` and `invalid_output` are
  `MODEL_ERROR`; `no_findings` is `NO_FINDINGS`; the run's `no_publishable_content` is `NOTHING_PUBLISHABLE` and
  `workflow_storage` is `STORAGE`. A timed-out attempt may run past its budget by up to about 30 seconds while its
  model conversation closes.
- **Notion copy** (`Replica.State`). `CONFLICT` > `UNKNOWN` > `RETRYING` > `OUTDATED` (the edition changed after its
  last import) > `SYNCING` > `SYNCED`; `DISABLED` when the backup is off, `NOT_STARTED` when the journal has no
  entry yet.
- **Edition kind.** From Newsletter's own records, the first rule that applies: a fixture is 测试, an edition sent as a
  correction is 修订, an edition of any run but its issue date's scheduled run is 测试, and the rest are 日常. The Notion
  backup's type column copies these rules (it also files the editions from before the backup began as 测试), so the two
  agree for every edition created after it began.
- **Model usage.** `Overview.week_usage` is `SummarizeModelUsage`'s `totals` for 7 issue dates: both count the
  consecutive calendar dates ending with the newest issue date that has a run. An edition's `usage` is the summary
  frozen into its email, which has calls, tokens and completeness but no failure, partial or cost counts.
- **Shared with Fleet and Home.** The unknown-record counts use the monitoring snapshot's predicates, the latest
  delivery (`Overview.latest_delivery`) its query, the drain state the deployment gate's rows, and the queued and
  in-flight counts (`ServiceState.queued_count`, `inflight_count`, Fleet's 排队 and 进行中) the gate's own predicates, so
  the numbers agree with Fleet. `queued_run_count` and `running_run_count` count collection runs only and are not
  Fleet's numbers. `ConfigState` carries the fields of Fleet's configuration observation, read by the same Newsletter helper
  as the monitoring status, and its `state` is Fleet's rule (`configState`) evaluated when the view was read.
- **The first page.** `Overview.latest_run` is the newest run of the daily schedule (a later manual or replayed run does
  not take its place), `latest_edition` the newest daily edition, and each strip day that date's scheduled run, or else
  its newest run.
- **Never shown as live state.** The legacy packet projection, a run body's per-direction states and an edition
  body's queue fields, which the daily workflow no longer updates.
- **Not recorded is not zero.** Model calls recorded before this API lack their purpose, times, Router requests,
  reported models, cost and failure; feed runs before it lack per-source counts; backup pages last written before
  it lack a progress time. Those fields are absent, and a client says 上线前未记录 instead of showing zero.
- **Delivery.** `PROVIDER_ACCEPTED` means the mail provider accepted the mail, not that it reached an inbox. An
  `UNKNOWN` delivery is checked against the actual mail first; it is never sent again under another request key.

## Untrusted text and privacy

Model output, feed metadata, references and the email's HTML are third-party or model-written. A client shows them
as text, links only `http` and `https` URLs (outside any frame, `noopener noreferrer`), never fetches them, and
shows the email's HTML only in an isolated frame with no scripts and no network. `Edition.personal_digest` and
`EditionRendering` hold the owner's private Todofy items: only the owner sees them (the console labels the section
仅你可见), and whether the Notion backup copies them stays Newsletter's own setting (`backup_included`). Model calls
name the Router's requests (`requests/<id>`) and conversations, never their content. No side logs content or the
assertion: logs carry request IDs, method names, status classes and durations, or an error's class and reference.

## Checks and changes

`Proto checks` holds the IDL to `buf lint`, Google's api-linter, `buf breaking` and the wire profile's breaking
rules; a change to `fixtures/` runs it too (`PROTO_READS`).

`fixtures/` holds the answers Newsletter's reader writes for a synthetic database
(`newsletter/tests/support/console_world.py`; `newsletter/scripts/console_fixtures.py` checks them and `--update` rewrites
them), with no trailing newline. `newsletter/tests/test_console_contract.py` and `proto/test/newsletter-ui.test.ts` read
each back with the Python and the TypeScript codec and write it again byte for byte.

Changes are additive: a new field, method or enum value. Enums are open, so a client keeps a default branch and
shows a code it does not know as it is. Anything incompatible is `newsletter.ui.v2`.

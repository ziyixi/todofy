# Personal MCP verification

Status on 2026-10-21 UTC: the OAuth/synthetic-event gate is accepted and the business release is live.
The existing private App and owner connection are retained. Business evidence is separate from the original
gate and from synthetic local source tests.

## Business release, 2026-10-21 UTC

| Evidence | Result |
| --- | --- |
| Source bridge | `44bb3ef550ee09d5b8c8a4bc2f3183666bd12117`; [branch gate 39565107285](https://github.com/ziyixi/todofy/actions/runs/39565107285), [same-SHA main 39566319560](https://github.com/ziyixi/todofy/actions/runs/39566319560), success |
| Business release | `f5386a9d70d711bedd865e3b6b5dfaec605b29dc`; [branch gate 39567087612](https://github.com/ziyixi/todofy/actions/runs/39567087612), [same-SHA main 39568082826](https://github.com/ziyixi/todofy/actions/runs/39568082826), success |
| Actual build | Connected `connection_status` returned that full business SHA and `stage: business_tools` |
| App discovery | Existing App's refreshed UI showed 8 write and 10 read tools plus five event types; actual Dots catalog reply `MCP_CATALOG_CHECK_f5386a9d` independently reported all 18 names, five events and the exact build |
| Plugin skill | Same private USER/App identity, version `1.1.0`, release `pluginrel_6ad875bbf8d88191b1d77fce014f2fa8`; read-back verified skill plus unchanged binding/presentation. Plugin UI showed Skills 1 |
| Home Ops | Real owner UI refreshed the new MCP card: normal, zero subscriptions, one previously accepted callback, no pending/failed deliveries, authenticated tool-use timestamp |

Final local MCP checks passed lint/types, 35 unit tests and five real-workerd tests. The runtime journey uses actual
SQLite DO persistence and signed local receivers: four source baselines, source cursors plus frozen deliveries,
restart, confirmed own-write suppression, four event types, request deduplication, unsubscribe/no more source
polling, and callback failure followed by explicit unsubscribe. Nine deploy tests, 14 binding/drift tests, four
configuration checks and the production-config dry-run passed; the gzip bundle is 261.55 KiB.

Real Dots business acceptance completed before `2026-10-21T08:33:59Z`:

| Check | Observed evidence |
| --- | --- |
| Four live sources | Native Dots reported SUCCESS for `task.changed`, `task.must_start`, `mail.ready`, `service.attention`; connected status independently showed four active sources, advancing minute check times and no source errors |
| Current-only baseline | Establishing the subscriptions did not deliver historical business events; the prior connection test remained the sole accepted delivery before the synthetic task entered Must start |
| Task writes and exact retries | `643219ce-0e93-4c2d-b849-0104c8d34ede` was created once. Repeating its creation request returned the same identity; repeating Step request `466fe2a5-66bd-429a-845c-b54aadc4e30d` returned the same two Step IDs. A bounded read showed exactly two children |
| Native startup window | The synthetic task's deadline was `2026-10-21`. Its initial default lead of zero correctly did not enter today's window; explicitly changing only `lead_days` to 1 returned etag `2` and `must_start: true` |
| Actual business event | DO Alarm produced `must_start_1` at `2026-10-21T08:28:18.484Z`; the signed callback was accepted at `08:28:18.864Z` in one attempt. Dots' `MCP_BUSINESS_EVENT_f5386a9d` reply named that event and matched the synthetic task. A separate marked reply confirmed `automations.mcp_event` execution data, not an inference from task creation |
| Recall binding | A unique synthetic search phrase returned zero results. No real document was opened |
| Cleanup | Dots reported all four subscriptions STOPPED; soft-delete and an exact delete retry succeeded. Targeted reads of the synthetic parent and both known children returned NOT_FOUND |
| Final connection state | Build remained `f5386a9d`; active subscriptions 0, active sources empty, pending 0, failed 0. Accepted count 2 consists of the original connection test plus this one business event |

This run used the generated Tasks API and source Alarm, with no manual business-event emitter. The no-extra-copy
check concerns this exact retry scenario; it does not promise global causal tracking of every descendant mutation.
Natural date-only transitions, production Mail collection, real task completion, real Recall content and a new
actual Home fault were not exercised. They remain covered by the scoped synthetic source tests, not by claims
about private production content. No existing task, mail, browsing record, operating switch or budget was changed.

The initial gate's binding/tool inventory below describes that earlier release. It is superseded by the business
catalog in [Personal MCP](../personal-mcp/README.md). The Worker still has one SQLite DO and no D1/Queue/Workflow;
its source entrypoints retain their existing application data and budgets.

## Published identity and checks

| Evidence | Result |
| --- | --- |
| First complete branch CI | [39544158967](https://github.com/ziyixi/todofy/actions/runs/39544158967), SHA `9e1681a1429b1ac93b99ede55822077522c59204`, success |
| Initial main publication | [39544986444](https://github.com/ziyixi/todofy/actions/runs/39544986444), same SHA, success |
| Dedicated Access application | [Infra apply 39545088566](https://github.com/ziyixi/todofy/actions/runs/39545088566), one create; 36 existing resources unchanged; final plan empty |
| Worker publication branch CI | [39545449859](https://github.com/ziyixi/todofy/actions/runs/39545449859), SHA `ef76b57d2105ec93668aee7fe3f2d05be837d8e8`, success |
| Worker main release | [39546367619](https://github.com/ziyixi/todofy/actions/runs/39546367619), same SHA, success on attempt 2 |
| Exact OAuth redirect registration | [Infra apply 39546470218](https://github.com/ziyixi/todofy/actions/runs/39546470218), one update to the MCP application; 36 existing resources unchanged; final plan empty |
| Namespace registration CI | [39547230019](https://github.com/ziyixi/todofy/actions/runs/39547230019), SHA `9e72e2c80ba93205f71ade831f6e525314299927`, success |
| Namespace/Home publication | [39547948701](https://github.com/ziyixi/todofy/actions/runs/39547948701), same SHA, success; MCP Worker behavior unchanged |

The first Worker release deployed and passed its version check, then failed at the anonymous network probe.
The unchanged probe passed against the live endpoint, and rerunning the failed release job passed. The original
failure did not include a network cause code, so DNS or certificate propagation is not established as its cause.

The public endpoint is `https://mcp.ziyixi.science/mcp`. It answers anonymous requests with HTTP 401 and a Bearer
challenge advertising its Cloudflare protected-resource metadata. That metadata returns HTTP 200, the exact MCP
resource URL and the existing Access issuer. The authorization-server metadata advertises dynamic client
registration; ChatGPT's connection UI independently discovered it and selected DCR without a manually entered
client ID or secret.

Actual Access app ID/AUD and `SubscriptionStore` namespace identity are recorded in `config/resources.toml`.
Home has the explicit namespace mapping; the first-deploy exception is removed. The app has no Tasks, Mail,
Recall or Home business-service binding. The only tools are `connection_status` and `send_test_event`; the only
event is `personal_cloud.test`.

## Local behavior verified

The real workerd/SQLite DO journey covers MCP 2.0 discovery, signed callback verification, subscription and queued
event persistence over process restart, one delivery for a repeated request ID, and unsubscribe. Unit checks cover
the Access assertion boundary and Standard Webhooks signatures. Wrangler dry-run produces a roughly 180 KiB gzip
bundle. No real content is used in these checks.

Resource integration also passed the full Home recipe: 268 Worker unit tests, 97 workerd runtime tests, 158 web
tests, lint/type checks, build, deployment dry-run and the existing bundle budget. Registry tests confirm no MCP
launcher tile is added and its namespace belongs to the MCP service.

## Real-client acceptance

The owner approved **Connect Personal Cloud** and its disclosed sharing scope. The existing Chrome session then
completed Cloudflare Access's GitHub login and OAuth grant. The same private Personal Cloud plugin discovered
`connection_status`, `send_test_event` and `personal_cloud.test`; no second connector was created.

The existing Dot successfully called `connection_status`, but its native subscription attempt returned
`status: ERROR`, “The task service returned an unexpected error.” No server reason or callback hostname was
visible. A direct call through the connected plugin confirmed build `ef76b57d`, zero subscriptions and no
deliveries. The Dot did not call `send_test_event`, so no event receipt is claimed.

The first diagnostic release, `ddf7820d`, passed [branch CI 39553772393](https://github.com/ziyixi/todofy/actions/runs/39553772393)
and [main publication 39553955084](https://github.com/ziyixi/todofy/actions/runs/39553955084). A native retry again
failed. Its last authenticated event request was a successful `events/unsubscribe`, although the Dot had not
requested cancellation; the client cleanup had overwritten the subscription diagnostic.

Diagnostic release `0c787e31` passed [branch CI 39554497873](https://github.com/ziyixi/todofy/actions/runs/39554497873)
and [main publication 39554661146](https://github.com/ziyixi/todofy/actions/runs/39554661146).
It narrows the single slot to `last_subscription_request` and records only authenticated
subscription phase, known event name, TTL, delivery mode, callback hostname and safe HTTP/RPC error codes.
Catalog reads and cleanup unsubscribe cannot overwrite it. It excludes full callback URLs, signing secrets,
raw requests and raw errors. Local workerd tests cover accepted requests, schema rejection, unapproved hostname,
failed signed challenge and unchanged status after an unauthenticated request. Subscription validation is unchanged.

The next native attempt established the cause: `events/subscribe` returned RPC `-32015` with
`reason: callback_host_unapproved` and callback hostname `connectors.api.openai.com`. The production allowlist
had only `chatgpt.com`. The fix replaces that assumption with the observed exact hostname. A regression test
using the committed production allowlist and a synthetic path failed before the fix; it now accepts the native host.
Neither the callback path nor the signing secret is retained in this record.

## Completed gate, 2026-10-21 UTC

The exact-host fix `422df6a0b9fc263641738beca1fac83062f2bc26` passed
[branch CI 39555068340](https://github.com/ziyixi/todofy/actions/runs/39555068340) and
[main publication 39555301186](https://github.com/ziyixi/todofy/actions/runs/39555301186).

| Check | Observed evidence |
| --- | --- |
| Signed verification and native subscription | `events/subscribe` accepted; direct status showed one active subscription on build `422df6a0` |
| Test enqueue | Request `e9d7b170-2134-4264-a590-5056feb707f5` produced `test_e9d7b170-2134-4264-a590-5056feb707f5`, queued once |
| Receiver acceptance | One attempt, accepted at `2026-10-21T06:28:41.317Z`, no delivery error |
| Actual Dots receipt | Existing Dot reported that exact event ID and full build SHA; it reported observing the payload at `06:29:00 UTC`, and the browser inspection confirmed the payload-specific reply before `06:29:57 UTC` |
| Duplicate request | Repeating the same UUID returned `repeated: true`; accepted delivery count and attempt count remained one |
| Test cleanup | Dot stopped only the test subscription/responsibility; direct status returned zero subscriptions and the same one accepted delivery |

A preliminary task activation had no payload and is not counted as receipt. The later reply contained the actual
event ID and build SHA. The receiver's 2xx and the Dot's payload-specific reply are separate evidence.
No business task, email or browsing content was read or changed during this gate.

The business release above follows this accepted gate. Its additional source and live checks are recorded separately;
this synthetic connection test does not establish business behavior.

# Personal MCP connection verification

Status on 2026-10-20 (America/Los_Angeles): the isolated MCP Worker and OAuth infrastructure are deployed.
Real ChatGPT consent, owner login, discovery, signed subscription, actual Dots event receipt, request deduplication
and test unsubscribe are verified. Business tools and event sources are the next implementation stage.

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

Next: add the agreed Tasks tools, followed by Mail/Recall/Home and the four business event types. Keep application
data in its existing owner, reuse the generated contracts and the same subscription/delivery DO, and verify the
expanded tools separately; the gate above does not establish business behavior.

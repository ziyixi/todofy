# Personal MCP connection verification

Status on 2026-10-20 (America/Los_Angeles): the isolated MCP Worker and OAuth infrastructure are deployed.
Real ChatGPT consent, owner login and tool discovery are verified. Dots event subscription currently fails;
event receipt is not verified.

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

Remaining checks:

1. Publish the exact-host fix through branch CI and main Actions, then repeat one native subscription.
2. Confirm signed callback verification succeeds and the subscription is saved.
3. Send the intended synthetic event with request ID `e9d7b170-2134-4264-a590-5056feb707f5` and observe actual Dots receipt.
4. Replay that request ID once, then stop only this test subscription and record actual event/build/receipt evidence.
   Only then add business tools or production event sources.

A webhook 2xx only proves receiver acceptance. No actual Dots receipt, business action or production-content
query is claimed by the current evidence.

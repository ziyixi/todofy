# Personal MCP connection verification

Status on 2026-10-20 (America/Los_Angeles): the isolated MCP Worker and OAuth infrastructure are deployed.
Real ChatGPT consent, owner login and Dots event receipt are not yet verified.

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

## Remaining real-client acceptance

The existing Chrome session created the private Personal Cloud connector and reached **Connect Personal Cloud**.
Automatic approval review stopped that click because the page newly discloses potential sharing of relevant chats
and memories with the app. An explicit owner confirmation is pending. The confirmation page is retained; do not
create a second connector, change authentication to bypass consent, or extract a session token.

After the owner confirms:

1. Continue the existing connector's regular Access login and confirm both tools and the event are discovered.
2. In the existing Dot, subscribe to `personal_cloud.test`, send one test event and observe actual Dots receipt.
3. Read connection status, replay the same test request ID once, then stop only this test subscription.
4. Record actual event/build/receipt evidence here. Only then add business tools or production event sources.

A webhook 2xx only proves receiver acceptance. No actual Dots receipt, business action or production-content
query is claimed by the current evidence.

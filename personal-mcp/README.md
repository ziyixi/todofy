# Personal MCP

Private MCP tools and event subscriptions for ChatGPT Dots. One Worker and one SQLite Durable Object;
Cloudflare Access handles OAuth. Business data stays in its existing application.

## Connection and rollout

Real Dots OAuth, signed subscription, actual event receipt, request deduplication and unsubscribe passed on
`422df6a0`. Evidence is in [verification](../docs/personal-mcp-verification.md).

The next release connects the existing Tasks API and exposes a private Ops snapshot for Home. Source adapters
for Mail, Recall and cached Home observations are prepared in their own applications. Their MCP bindings and
the four business event types follow after those entrypoints are live. Application records stay in their owner;
the MCP DO stores subscription/delivery metadata and stable Step-write identities.

Connection tools remain available:

- `connection_status`: build identity, subscription count and synthetic delivery results.
- `send_test_event`: send one `personal_cloud.test` event, using a UUID request ID.
- `events/list`, `events/subscribe`, `events/unsubscribe`: MCP Events webhook lifecycle.

Tasks tools cover bounded list/detail reads, Inbox creation, Steps, explicit updates/completion, native Plan facts,
daily queue arrangement and read-only Focus. Queue changes preserve task dates and deadlines. Writes use the
native receipts and etags; retry an uncertain write with the same request ID and input.

Business tools require owner instructions or an explicitly authorized responsibility. Bets are weekly goals;
Committed is a limited commitment. Steps should usually fit within two hours. The assistant must not choose
commitments, dates or completion for the owner.

## Development

From `worker/`, use Node 26:

```sh
npm ci
npm run lint
npm run typecheck
npm test
npm run test:runtime
```

The runtime test uses workerd, a real SQLite DO and an in-process signed callback receiver. It checks discovery,
subscription persistence across restart, delivery, repeated request IDs and unsubscribe. Outbound calls remain local.

## Connect and verify

See [connection acceptance](docs/connection.md). The production endpoint, once released, is
`https://mcp.ziyixi.science/mcp`. Deployment uses the normal branch CI, Infra apply and main Actions flow.
Access's actual audience is recorded; the publication gate is enabled. Current release and business acceptance
status are tracked in the verification document and HANDOFF.

The standard MCP SDK owns protocol handling. This service requires MCP 2.0 (`2026-07-28`), uses the SDK's
native `createMcpHandler`, and uses `standardwebhooks` for signatures. It has no Agents framework, server-side
model calls, D1 database, Queue or Workflow.

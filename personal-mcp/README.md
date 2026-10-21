# Personal MCP

Private MCP tools and event subscriptions for ChatGPT Dots. One Worker and one SQLite Durable Object;
Cloudflare Access handles OAuth. Business data stays in its existing application.

## Current stage

The first release verifies the real connection before adding Tasks, Mail, Recall or Home bindings:

- `connection_status`: build identity, subscription count and synthetic delivery results.
- `send_test_event`: send one `personal_cloud.test` event, using a UUID request ID.
- `events/list`, `events/subscribe`, `events/unsubscribe`: MCP Events webhook lifecycle.

No task, email, browsing record or production content is read or changed in this stage.

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
Access's actual audience is recorded; the publication gate is enabled. Real Dots acceptance is still pending.

The standard MCP SDK owns protocol handling. This service requires MCP 2.0 (`2026-07-28`), uses the SDK's
native `createMcpHandler`, and uses `standardwebhooks` for signatures. It has no Agents framework, server-side
model calls, D1 database, Queue or Workflow.

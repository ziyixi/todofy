# Connection acceptance

## Implemented first gate

The only event is `personal_cloud.test`, with no filters and a synthetic message plus the deployed build SHA.
The tools read connection status and enqueue this test event. The Worker has no business-service bindings.

Subscriptions live in the single `SubscriptionStore` SQLite DO. A subscription ID includes its owner, callback,
event name and arguments. A signed challenge must succeed before it is saved. Repeated subscriptions renew the
same identity. The default lifetime is 30 days; `ttlMs: null` grants no expiration. Unsubscribe stops queued delivery.
No historical replay is supported (`cursor: null`).

Test deliveries use a stable event ID and exact serialized body, signed by `standardwebhooks`. A successful
response records `accepted`. Transient failures get two further attempts after one and five minutes; other failures
remain visible through `connection_status`. This first gate does not send real content.

Only HTTPS callbacks on the exact configured `CALLBACK_HOSTS` are accepted. Redirect responses are failures;
Workers fetch uses `redirect: manual`. The real Dots subscription uses `connectors.api.openai.com`; this exact
hostname is the production allowlist. Record only the hostname, never the callback path or signing secret.
Arbitrary webhook destinations are outside this personal ChatGPT integration. The current live acceptance
record is in [Personal MCP verification](../../docs/personal-mcp-verification.md).

## Release and real-client checks

1. Pass branch CI. The first merge prepared infrastructure only; the new Access application now exists.
2. Run the existing Infra drift/apply flow. Review that it creates only the new MCP Access application; record its
   actual app ID and AUD in `config/resources.toml`, then regenerate config. Preserve existing applications/policies.
3. Managed OAuth is enabled only for this application. IaC declares the documented issuer-aware ChatGPT redirect
   and the exact callback-ID URI observed in this owner's live connection form. A new ChatGPT connection may
   produce a different callback-ID URI; update that exact value through IaC. No wildcard is needed.
4. The publication gate is now enabled. Pass CI and release the same SHA via main Actions. Record the new DO
   namespace in resources after first deployment.
5. Register the live MCP in the private plugin, finish the real Access login, and rescan. Confirm two tools and the
   test event are discovered. Do not use Inspector success as a substitute for ChatGPT.
6. In a Dots or Cloud Work chat, subscribe to `personal_cloud.test`, invoke `send_test_event` with a fresh request ID,
   and confirm both the accepted delivery and ChatGPT's actual receipt. Repeat the request ID once: no second event.
7. Stop the subscription and verify it is gone. Record the observed run/build/event identities below, excluding
   credentials. Only after this gate passes, begin the agreed Tasks/Mail/Recall/Home integration.

If real-client login is incompatible, record the exact blocker and keep this gate isolated. Do not prebuild
alternative OAuth servers or modify the business applications while investigating it.

## Evidence

2026-10-20 (America/Los_Angeles): local type checks, lint and synthetic unit tests pass. The workerd runtime journey
passes discovery, persistent subscription and queued event after restart, signed webhook delivery, repeated test request and
unsubscribe. The later live acceptance completed Access OAuth, ChatGPT discovery, signed Dots subscription,
actual receipt, same-request deduplication and unsubscribe on `422df6a0`; see the root verification record above.

References: [OpenAI Events](https://developers.openai.com/plugins/build/mcp-events),
[OpenAI auth](https://developers.openai.com/plugins/build/auth),
[Cloudflare Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/).

The first complete branch gate passed at `9e1681a1429b1ac93b99ede55822077522c59204`
([CI 39544158967](https://github.com/ziyixi/todofy/actions/runs/39544158967)); the same SHA reached main.
[Infra apply 39545088566](https://github.com/ziyixi/todofy/actions/runs/39545088566) created only the dedicated
MCP Access application, left all 36 existing resources unchanged, and verified no remaining drift. Its real ID/AUD
are recorded in `config/resources.toml`. The next release enables the Worker and exact observed OAuth redirect.
These steps establish infrastructure readiness, not real Dots receipt.

## Business release

The connection gate above passed before business sources were connected. The current source catalog is listed in
[README](../README.md). Private `TasksApi`, `Mail` (Todofy's, read-only; `MailApi` until 2026-10-21), `RecallApi` and `HomeApi` entrypoints must be deployed before
the MCP binds them. The staged bridge does this through the normal source-app Actions releases; it also adds MCP's
private Ops entrypoint before Home begins monitoring it.

After the business Worker release:

1. Open the existing Personal Cloud plugin's **Manage** page and choose **Refresh tools**. Keep the existing
   account and OAuth connection; do not register a second App. Verify 18 tools and five event types.
2. Verify a temporary synthetic Inbox task, Steps, exact request replay, read-back and soft-delete. Do not test
   completion against real tasks or use real mail/browsing contents as fixtures.
3. Subscribe to a business event using Dots' native lifecycle. Subscriptions establish a current baseline;
   historical tasks, existing ready mail and current Home attention are not replayed.
4. Check `connection_status` source check times/errors and the Home MCP Ops card. Test callbacks accepted by the
   receiver separately from the Dot's actual payload-specific reply. Stop test responsibilities afterward.

The GTD skill source is `plugin/skills/personal-cloud/SKILL.md`. Before an account update, retrieve the existing
App-backed plugin manifest, bump its version and package it with that skill in a temporary directory. The upload
preserves the App binding, title, description and sharing; only skill/support files and version change. Refresh the App-owned tool
catalog and descriptions through its own management page, then re-read the manifest before packaging to avoid
restoring stale App metadata. GitHub deploys the Worker; skill publication remains a separate authorized account
update. The verification record distinguishes published code from live business checks still to do.

A subscription source error appears in Home. For `cursor_reset_required`, inspect the source's restore status,
then explicitly stop and recreate only that source subscription to establish a current baseline. This does not
replay missing history. A failed callback remains visible until the owner stops that subscription; recreating it
verifies the new callback and starts from current state. No automatic replay or second notification path is added.

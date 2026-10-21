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
Workers fetch uses `redirect: manual`. The first real ChatGPT subscription may identify a hostname needing this
configuration. Record only that hostname, never the callback path or signing secret. Arbitrary webhook destinations
are outside this personal ChatGPT integration.

## Release and real-client checks

1. Pass branch CI. The new Worker initially stays in `CHECK_ONLY`, so the first merge prepares infrastructure only.
2. Run the existing Infra drift/apply flow. Review that it creates only the new MCP Access application; record its
   actual app ID and AUD in `config/resources.toml`, then regenerate config. Preserve existing applications/policies.
3. Managed OAuth is enabled only for this application. Verify the exact ChatGPT redirect URI in the connection UI.
   The currently declared stable URI is valid only when the provider advertises RFC 9207 issuer identification;
   otherwise replace it with the exact callback-ID URI shown by ChatGPT, through IaC.
4. Remove `CHECK_ONLY`, pass CI and release the same SHA via main Actions. Record the new DO namespace in resources.
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
unsubscribe. Real Access OAuth, ChatGPT discovery, Dots subscription and Dots receipt remain pending.

References: [OpenAI Events](https://developers.openai.com/plugins/build/mcp-events),
[OpenAI auth](https://developers.openai.com/plugins/build/auth),
[Cloudflare Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/).

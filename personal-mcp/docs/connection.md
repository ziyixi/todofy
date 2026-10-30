# Personal Cloud connection

Access Managed OAuth protects the existing private ChatGPT App. Keep its App identity and account connection;
application publication and plugin/tool-catalog refresh are separate operations. Current tools are defined by the
Worker, with usage rules in [the skill](../plugin/skills/personal-cloud/SKILL.md).

## Setup and publication

1. Use [the rebuild runbook](../../docs/rebuild.md) to create/adopt the dedicated Access app and record its real AUD.
   Its OAuth redirect allowlist must contain the exact documented or observed ChatGPT callback. Do not infer a
   callback ID or use a wildcard.
2. Deploy the private Tasks, Todofy Mail, Recall, Watch and Home entrypoints before MCP binds them. Main Actions
   enforces the declared provider order; the Work store uses the existing DO and audience.
3. Connect through the existing private App and complete the normal Access login. After adding tools, refresh its
   catalog and verify the actual discovered tools and event types. An Inspector call alone does not verify Dots.
4. If changing the packaged skill, retrieve the current App-backed manifest, update its version and skill files,
   and preserve its App binding, title, description and sharing. Worker deployment does not publish this package.

## Subscription behavior

The single `SubscriptionStore` SQLite DO owns subscriptions. Their identity includes owner, callback, event name
and arguments. A signed challenge must succeed before saving; repeating the same subscription renews it.
The default lifetime is 30 days; `ttlMs: null` has no expiration. Only `work.attention` accepts a `work_id` filter.
Subscriptions establish a current baseline rather than replaying historical source content. Unsubscribe stops
queued delivery.

Only HTTPS callbacks on exact `CALLBACK_HOSTS` are accepted, currently `connectors.api.openai.com`. Redirects fail.
Do not log callback paths, signing secrets or business content. A frozen event keeps its ID and serialized body
through the existing signed delivery attempts; a successful callback records `accepted`. This means the receiver
accepted it, not that a Dot performed the intended work.

`connection_status` exposes current source-check times and safe delivery/source errors. Home monitors the same
app through Ops. For `cursor_reset_required`, inspect the source recovery state, then stop and recreate only the
needed source subscription to establish a fresh baseline. Missing history is not replayed. A callback failure
remains visible until that subscription is stopped; a new subscription verifies its own callback.

## Work and evidence

Watch evidence and health enter linked open Works as reports. MCP initializes the source cursor before creating
or attaching a Watch, and reads at most one page of 100 events per minute while a work subscription needs it or a
Work read requests it. An expired cursor creates a new baseline plus one blocked gap report per affected open Work.
When no open Work has a Watch link, the next attachment starts fresh.

`review_at` is a hint, not a scheduler. Authorized Dots schedules and local Codex delegation use their native
facilities; saving a reference in MCP does not start them. `watch_read`/`watch_view` read stored evidence and never
fetch a page or call a model. Work lifecycle and cleanup rules are in [work memory](work-memory.md).

## Acceptance

Use a synthetic event with a fresh request ID; confirm both the accepted signed callback and the Dot's reply
identifying that event. Replay the same request once, then unsubscribe. For business tests use temporary synthetic
records and verify their actual source effects separately. Do not read real mail or browsing records as fixtures.

[Connection verification](verification.md), [Work verification](../../docs/work-memory-verification.md) and
[Watch evidence verification](../../docs/watch-evidence-verification.md) record the completed checks and gaps.

References: [OpenAI authentication](https://developers.openai.com/plugins/build/auth),
[events](https://developers.openai.com/plugins/build/mcp-events),
[Cloudflare Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/).

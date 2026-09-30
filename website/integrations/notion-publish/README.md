# Notion publish button relay

The standalone Cloudflare Worker accepts authenticated Notion button actions
and dispatches either production release or publication-status refresh. It has no dependencies
and can be pasted into Cloudflare's Worker code editor as an ES module. Keep its
deployment separate from the Vercel website.

## Configuration

Configure these as **Worker secrets**, never plaintext source or ordinary vars:

| Secret                  | Purpose                                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `GITHUB_DISPATCH_TOKEN` | Fine-grained GitHub token scoped to `ziyixi/ziyixi.science`, with repository **Actions: Read and write** permission       |
| `NOTION_WEBHOOK_SECRET` | A randomly generated value of at least 32 characters, also placed in the Notion button's `X-Notion-Publish-Secret` header |

Set the Notion button action to **Send webhook**, using the Worker's HTTPS URL
plus `/publish`. The URL does not contain a secret. Add the custom header above.
For the separate **刷新状态** button, use `/refresh-status` with the same header.
It dispatches only `notion-status.yml` on `main`, with no inputs or deployment.
The request body can be left as Notion's default: the relay never reads it.
Only people permitted to edit that private button should have access to it.

The fixed operation is `release` on `main`, with
`confirmation=release:www.ziyixi.science`, `force_build=false`, and
`allow_empty=false`. It cannot select another repository, ref, workflow, recovery,
or empty-publication override. Existing production validation, environment rules,
deployment-state gates, and rollback behavior remain in force.

## Responses

- `GET /health`: liveness only; no GitHub call or secret/configuration disclosure.
- `POST /publish` with the correct header: `202 accepted` means GitHub accepted
  the request. It does **not** mean the site has deployed. Check the returned
  `runUrl`, or the fixed `workflowUrl` when a run ID is unavailable.
- `200 already-running`: an unfinished main-branch run was found; no new run was
  requested. This may be waiting on a production environment approval.
- `401 unauthorized`: the shared secret was missing or incorrect.
- `503 not_configured`: a required binding is absent or the shared secret is too
  short.
- `502`: GitHub failed or could not be reached. For
  `github_dispatch_unconfirmed`, check Actions before clicking again: the
  timed-out request may already have created a run. The relay never retries.

The recent-run check reduces double clicks, but is not an atomic distributed
lock: simultaneous requests or delayed GitHub run visibility can create multiple
runs. The existing workflow concurrency group serializes releases, and unchanged
content skips rebuilding. The relay checks the 30 most recent main dispatches;
it does not maintain durable deduplication state. A click during a running sync
does not queue a guaranteed later sync of additional edits: finish editing first,
and click again after the active run completes when necessary.

Notion receives acceptance immediately; GitHub writes final per-article feedback
after a successful comparison against the live publication manifest. Both workflows
use the same concurrency group with `queue: max`; refresh cannot replace a pending
release and feedback writes cannot overlap release snapshot reads. A post-release
feedback failure produces a warning without rolling back a verified website.
Notion can pause an action after a failed webhook, so inspect its
action settings if subsequent clicks stop working.

## Local checks and deployment

The security tests are included in the repository's existing `make check` via
`tests/unit/notion-publish-worker.test.ts`. They mock GitHub and never dispatch a
real workflow. To run just those tests with the repository's Node 24 environment:

```sh
pnpm exec vitest run tests/unit/notion-publish-worker.test.ts
```

Run `make deploy-relay` from the repository root after configuring both secrets
in the git-ignored `.env.local`. The deployment script pins Wrangler 4.141.0,
uploads only these two values through a private temporary file, and removes that
file afterwards. No other website credentials are uploaded. Authenticate first
with `npx --yes wrangler@4.141.0 login --scopes account:read user:read workers_scripts:write`
if required. The Worker runs separately at
`https://ziyixi-notion-publish.cloudflare-579.workers.dev`; no custom-domain/DNS
changes are necessary. Do not enable request-header or body logging.

See the [Chinese operation guide](../../doc/notion-publish-button.md) for daily
publishing, token renewal, and troubleshooting.

References: [Notion webhook actions](https://www.notion.com/help/webhook-actions),
[GitHub workflow dispatch](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event),
[Cloudflare secrets](https://developers.cloudflare.com/workers/configuration/secrets/).

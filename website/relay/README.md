# Website content sync

`ziyixi-notion-publish` dispatches `website-release.yml` on `main` once a day at **10:17 UTC**.
The workflow reads the complete Notion content snapshot and publishes only when its release identity
changes. Code pushes keep their normal publication path. There are no GitHub schedules or Notion
buttons, and this Worker holds no Notion credentials.

Home calls the same Worker through its private `Ops` service binding. The public HTTP entry returns
404; `workers.dev` and preview URLs are disabled. Home authenticates the owner and checks Origin and
CSRF before accepting an immediate sync. Different requests enter the release queue, including while
another build runs. Home stores each request UUID before dispatch; a repeated or uncertain request
only looks up its original run and never sends another dispatch.

## Configuration

[`wrangler.toml`](wrangler.toml) contains the target repository, workflow and website hostname.
`triggers.crons` and `DAILY_SYNC_CRON` both use `17 10 * * *`. If changing the daily time, update both.
The only Worker secret is `GITHUB_DISPATCH_TOKEN`: a fine-grained GitHub token scoped to the target
repository with **Actions: read and write** and **Deployments: read**. Set credentials through the
[bootstrap inputs](../../tools/cloud-bootstrap/README.md); do not put them in committed configuration.

The deployment retires only the old `NOTION_TOKEN`, `NOTION_DATA_SOURCE_ID` and
`NOTION_WEBHOOK_SECRET` Worker secrets. The Actions content reader keeps its own Notion token and data
source input.

## Status and requests

The root [sync proto](../../proto/website/sync/v1/sync.proto) defines the internal contract:

- `getSyncStatus`: last full check, current task, last verified publication and next daily tick.
- `requestSync`: dispatch fixed release inputs; acceptance requires GitHub's actual run ID.
- `getSyncRequest`: find a run by the exact UUID in its run name; never dispatch.

A lost response, timeout or ambiguous server error is unconfirmed. It is not reported as a successful
publication. Status combines the workflow run with the separate `website-content-sync` receipt and
existing release ledger. An unchanged check advances the check time without advancing publication
time. Provider failures, cancelled runs and missing receipts remain visible. A full check older than
26 hours raises a dismissible Home reminder.

Status stays within a fixed subrequest budget: the 10 newest runs, 25 receipts and 10 release records,
the statuses of at most two receipts (the latest and active runs), release statuses newest-first until
the first verified one, and the website's build info. Every listed receipt is still validated. A request
lookup reads 50 runs so an older request ID stays findable.

## Checks and release

From `website/`:

```sh
pnpm check
pnpm exec wrangler deploy --dry-run --config relay/wrangler.toml
```

[CI](../../.github/workflows/ci.yml) deploys the relay from the checked main SHA before deploying Home.
[Website release](../docs/release.md) retains the publication lock, identity verification and rollback.
Manual Home acceptance and the next natural Cron invocation are separate production checks.

References: [GitHub dispatch](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event),
[GitHub deployments](https://docs.github.com/en/rest/deployments/deployments),
[Cloudflare Cron](https://developers.cloudflare.com/workers/configuration/cron-triggers/).

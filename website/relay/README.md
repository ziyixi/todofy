# Notion relay: buttons and automatic releases

The Worker `ziyixi-notion-publish` (TypeScript, no dependencies) does two things, and both only
dispatch the monorepo workflow [`website-release.yml`](../../.github/workflows/website-release.yml)
on `main` with fixed inputs:

- **`fetch`: the two Notion buttons.** `POST /publish` («发布网站») requests
  `operation=release`, `POST /refresh-status` («刷新状态») requests `operation=status`.
- **`scheduled`: the change detector.** Every 15 minutes (`7,22,37,52 * * * *`) it decides whether
  Notion changed since the last release and, if so, dispatches `operation=release` with
  `trigger=cron`; once a day it dispatches a reconcile release (`trigger=reconcile`). The rules are
  in [`../docs/architecture.md`](../docs/architecture.md#automatic-releases).

It lives in `website/relay/` (it was `integrations/notion-publish/` in the old repository) because
it belongs to the website app: it shares the website's `package.json` (wrangler, vitest) and its
tests run in `Website checks`, but it has its own [`wrangler.toml`](wrangler.toml) and its own
deploy job (`Website relay deploy`). A change under `website/relay/` deploys the relay, not the site.

## Configuration

Committed in `wrangler.toml` (public, not secret): the target repository and workflow, the
canonical host used in the confirmation string, the Notion API version, and the detector settings
`AUTO_PUBLISH` (`"true"`), `QUIET_MINUTES` (25), `MAX_AUTO_RELEASES_PER_DAY` (6) and
`RECONCILE_UTC_HOUR` (10). Optional `IGNORED_EDITOR_IDS` (comma-separated Notion user IDs whose
edits never count) is not set.

**Worker secrets** (never in git or in a GitHub variable; they survive deploys):

| Secret                  | Purpose                                                                                                                                                                            |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GITHUB_DISPATCH_TOKEN` | Fine-grained PAT, repository **ziyixi/todofy**, **Actions: Read and write** (dispatch and list runs)                                                                               |
| `NOTION_WEBHOOK_SECRET` | The buttons' `X-Notion-Publish-Secret` header value, 32–1024 characters                                                                                                            |
| `NOTION_TOKEN`          | The detector's Notion integration; **Read content** on the Blog data source is enough (a separate read-only integration is recommended; the website's write-back token also works) |
| `NOTION_DATA_SOURCE_ID` | The Blog data source ID                                                                                                                                                            |

Without `NOTION_TOKEN`/`NOTION_DATA_SOURCE_ID` the buttons keep working and the detector logs
`NOT_CONFIGURED`.

## Buttons: responses

- `GET /health`: liveness only; no GitHub call, no configuration disclosure.
- `202 accepted`: GitHub accepted the dispatch. It does **not** mean the site deployed; follow
  `runUrl` (or `workflowUrl`).
- `200 already-running`: a `website-release.yml` run on `main` is queued or running; nothing new was
  requested. Releases and status refreshes share one concurrency group, so a click during a release
  is not queued: the release writes the Notion feedback itself.
- `401 unauthorized`, `503 not_configured`, `502 github_unavailable`, `502 github_dispatch_failed`
  (a `403` here usually means the PAT does not include ziyixi/todofy),
  `502 github_dispatch_unconfirmed` (a timeout after the dispatch was sent: check Actions before
  clicking again). The relay never retries and never reads the Notion request body.

## Detector: log codes

Workers Logs keep only one JSON line per tick, `{"relay":"detector","code":…,"counts":…}`; invocation
logs are off (they would record request metadata). Codes: `DISPATCH_CHANGES`, `DISPATCH_RECONCILE`,
`NO_CHANGE`, `QUIET_PERIOD`, `AUTO_CAP_REACHED`, `RUN_ACTIVE`, `AUTO_PUBLISH_OFF`, `NOT_CONFIGURED`,
`GITHUB_UNAVAILABLE`, `NOTION_UNAVAILABLE`, `DISPATCH_FAILED`, `DETECTOR_ERROR`. Counts are the
number of rows returned and of edited, due and pending rows; nothing else leaves Notion.

## Checks and deployment

Tests (mocked GitHub and Notion, no network): `pnpm exec vitest run tests/unit/relay-buttons.test.ts
tests/unit/relay-detector.test.ts` from `website/`. Bundle check without a token:
`pnpm exec wrangler deploy --dry-run --config relay/wrangler.toml`.

Deploys run only in GitHub Actions (`Website relay deploy` in `.github/workflows/ci.yml`, on `main`
when `website/relay/` changed or on a dispatch with `app=website`), with the monorepo's
`CF_API_TOKEN`. `wrangler deploy` keeps the Worker secrets and applies the cron trigger. Set or
rotate a secret from your own machine, never through chat:

```sh
cd website
npx wrangler secret put NOTION_TOKEN --config relay/wrangler.toml
```

References: [Notion webhook actions](https://www.notion.com/help/webhook-actions),
[GitHub workflow dispatch](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event),
[Notion data source query](https://developers.notion.com/reference/query-a-data-source),
[Cloudflare cron triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/).

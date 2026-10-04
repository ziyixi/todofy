# Website release

Every production change uses [Website release](../../.github/workflows/website-release.yml). Daily
Cloudflare dispatches, the Home **立即同步** action, code pushes and manual operations share the
`website-production` lock (`queue: max`, `cancel-in-progress: false`). There is one release job and no
GitHub schedule or Notion status write-back.

| Start                     | Inputs                                                           |
| ------------------------- | ---------------------------------------------------------------- |
| Daily relay               | `operation=release`, `trigger=cron`, a request UUID              |
| Home 立即同步             | `operation=release`, `trigger=manual`, a request UUID            |
| Website code push on main | CI gate → `Website deploy` → `operation=release`, `trigger=push` |
| Actions → Run workflow    | `release`, `bootstrap` or `recovery`, `trigger=manual`           |

The confirmation is `<operation>:<configured website host>`. The relay supplies fixed release inputs;
Home cannot select a ref, recovery, force-build or allow-empty. The optional `request_id` is a UUID,
included in the run name `Website <operation> (<trigger>) [<request_id>]` so a dispatch whose HTTP
response was lost can be matched to its actual run. Direct Actions and code-push dispatches may leave it
blank.

## Release stages

The job checks out main inside the lock, then selects its newest first-parent commit with a successful
main-push **CI gate**. Red, running and `[skip ci]` commits cannot be installed or built. If none of the
newest 50 candidates is green, the job fails. `context` checks the pinned commit again.

Each stage is one `pnpm release <command>`, run from `website/`:

1. `context` validates main, workflow dispatch, confirmation, request UUID and green commit.
2. `code-sha` identifies the newest commit that touched `website/`; unrelated service changes do not
   change the website's code identity.
3. `gate` reads the existing `website-release` records. Ordinary release needs a successful baseline;
   a failed/interrupted release needs recovery. No baseline requires bootstrap and produces a blocked
   content-sync receipt.
4. `recover` (recovery) or `check-baseline` (ordinary release) verifies the recorded Worker version and
   live identity before reading content.
5. Empty-snapshot checks run without secrets. `prepare` then reads the complete Notion snapshot and
   media, using the baseline registry for slug history and feed GUIDs. A previously non-empty collection
   becoming empty is automatic only when every previously public source identity is positively Draft
   or archived in the configured data source, with complete pagination and a stable reread. Missing
   records, permission errors and ambiguous identity keep the existing site. The explicit allow-empty
   recovery operation remains available. Draft/Published and publication dates remain the content rules.
6. `decide` compares code SHA, content hash, config hash and schema version. Only after both prepare and
   decide complete is the actual `checked_at` saved. `sync-record` creates a content-sync receipt:
   unchanged is successful with no build/deploy; changed is in progress.
7. A changed identity builds the static export and verifies its identity and complete route contract under
   `wrangler dev`. The hostname guard rejects unapproved hostname removal or takeover before upload.
8. `upload` creates a Worker version after checking the baseline again. The first bootstrap uses
   `wrangler deploy`, because the Worker may not exist yet. `record` writes the existing release ledger
   entry with its rollback target and route contract.
9. `deploy` rechecks hostnames and the active version, activates the new version, applies the configured
   hostnames and confirms the active version. `verify-live` checks the live identity, route contract and
   all other configured hostnames; `mark-success` completes the release ledger.
10. A failed deploy or live verification restores and verifies the previous recorded version when
    possible. The release record becomes failure/error and blocks ordinary releases until recovery.
11. `sync-finalize` runs with `always()`. It records success only for an unchanged completed check or a
    changed release verified on the live hostname and recorded successfully. A failed build/publish
    preserves the earlier actual check time. A failed or skipped snapshot has `checked_at: null`.

If the runner is terminated, dependency installation fails, or GitHub cannot accept a final record,
there can be no final receipt. Home must combine the run conclusion with available receipts, display
failure/cancellation or missing evidence, and keep the previous actual check time. A green workflow
alone never proves that Notion was checked or that production changed.

## Two separate GitHub ledgers

`website-release`, environment `production`, retains the existing payload schema 3: Worker version,
predecessor, live hostname, identity, content registry and route contract. It remains the baseline,
recovery and rollback ledger. Content-sync receipts do not alter it.

`website-content-sync`, environment `website-content-sync`, is a small schema 1 check receipt:

```json
{
  "schema_version": 1,
  "task": "website-content-sync",
  "run_id": 123,
  "run_attempt": 1,
  "request_id": "11111111-1111-4111-8111-111111111111",
  "checked_at": "2026-10-04T10:31:02.000Z",
  "decision": "unchanged",
  "identity": {
    "codeSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "contentHash": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "configHash": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    "schemaVersion": 1
  }
}
```

An uncompleted check uses `decision: not_checked`, `checked_at: null` and `identity: null`. There are no
article titles, bodies or registries in this payload. Status descriptions are fixed codes:

| Status      | Description               | Meaning                                                                  |
| ----------- | ------------------------- | ------------------------------------------------------------------------ |
| in_progress | `SYNC_DEPLOYING`          | Snapshot checked; a changed identity is being published                  |
| success     | `SYNC_UNCHANGED`          | Snapshot checked; identity unchanged                                     |
| success     | `SYNC_PUBLISHED`          | Changed release verified live and release ledger completed               |
| error       | `SYNC_BOOTSTRAP_REQUIRED` | No accepted baseline; run bootstrap                                      |
| error       | `SYNC_GATE_BLOCKED`       | Context/baseline gate failed; inspect run, use recovery when appropriate |
| failure     | `SYNC_CHECK_FAILED`       | Full snapshot and decision did not complete                              |
| failure     | `SYNC_BUILD_FAILED`       | Checked identity failed to build or verify locally                       |
| failure     | `SYNC_PUBLISH_FAILED`     | Upload, publication, live verification or release recording failed       |
| failure     | `SYNC_RECEIPT_FAILED`     | A check completed, but its receipt write or unchanged run failed         |
| error       | `SYNC_CANCELLED`          | Run cancelled; any already completed check remains recorded              |

A rerun has a new `run_attempt`, with its own receipt. Lost create responses are recovered from at most
25 recent content-sync records using run ID and attempt. Ambiguous or mismatched records fail closed.

## Manual operations

- **bootstrap:** first release, with no release records in this repository. With
  `WEBSITE_LEGACY_REPOSITORY`, import its last successful registry. Otherwise set the production variable
  `WEBSITE_BOOTSTRAP_APPROVAL` to the canonical origin. For an intentionally empty first collection,
  use `allow_empty=true` and confirmation `bootstrap:<configured website host>:allow-empty`.
- **recovery:** verify that production serves the latest recorded version or its previous accepted
  version; refuse any other identity. Then run a complete release, always rebuilding.
- **force_build:** explicitly rebuild/redeploy an unchanged identity. Baseline checks still apply.
- **allow_empty:** permit one non-empty → empty publication; confirmation must end in `:allow-empty`.

For a deliberate rollback, prefer a revert on main. An emergency rollback to the latest record's
`previousWorkerVersionId` can use the Cloudflare console or
`pnpm exec wrangler versions deploy <version-id>@100% --config wrangler.toml` from a trusted machine.
The next ordinary release then stops until recovery reconciles the ledger with production.

## Configuration and credentials

Public deployment values come from the generated cloud configuration, `wrangler.toml` and the pinned
Notion API version. The GitHub `production` environment supplies `WEBSITE_NOTION_TOKEN`,
`WEBSITE_NOTION_DATA_SOURCE_ID` and `CF_API_TOKEN`. Only `prepare` receives Notion credentials; it reads
content and never writes status properties or the database description.

The job's GitHub token has contents/checks/actions read and deployments write. Only the green gate and
record-reading/writing steps receive it; dependency installation, builds and tests do not. Logs contain
only IDs, counts and fixed errors. No Notion content or response bodies are logged.

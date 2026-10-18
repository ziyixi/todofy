# History and dated compatibility

This page records earlier layouts and the evidence that must survive cleanup. It is not a declaration of
current production state; [HANDOFF](../HANDOFF.md) names the current rollout and remaining verification.

## Archived handoffs

[Handoff through October 11, 2026](history/handoff-2026-10-11.md) preserves the rollout evidence and earlier
waiting lists from `414925e`. Later observations in that snapshot supersede many earlier entries. Current work and
remaining acceptance are in [HANDOFF](../HANDOFF.md); current rebuild steps and verified limits are in
[Rebuild](rebuild.md) and [rebuild verification](rebuild-verification.md).

## Todoist Plus removal, October 18

By the owner's decision of 2026-10-18 the Todoist Plus Chrome extension was removed with no compatibility window,
together with its CI job, Todofy's `/plus` page and hooks-host `/api/plus/*` routes, FlowDay's `FocusEntrypoint`
and the nine `PlusService` RPCs only the extension called (`proto/retired.json`). Tasks hosts Plan, Focus and Mail
natively. The last commit with the extension's source is `f6c08aaf`; see
[Todoist Plus (retired)](history/todoist-plus.md).

## October 11 maintenance simplification

`codex/maintenance-simplification` landed as `ccf2c27a12be509cbdeac057f888122da7c1b2d1` after
[full branch CI 38161463808](https://github.com/ziyixi/todofy/actions/runs/38161463808).
[Main CI 38162014695](https://github.com/ziyixi/todofy/actions/runs/38162014695) reused the same checked SHA
and passed. All application releases, image publications, VPS bundle and VPS deployment were skipped.

- HANDOFF now keeps current state and open acceptance; its previous 1,247 lines remain in the dated archive above.
  Local verification compared the archive with the original text and checked 101 document targets.
- Thirteen reviewed external test directories keep their checks without selecting production releases. Mixed
  production changes and unknown paths retain the previous rules; source-import checks enforce the boundary.
- Native workflow/composite assertions read parsed YAML fields. Formatting changes pass; altered release gates
  and locks fail. Existing expanded recipe and shell behavior tests remain. Root tests use the existing pinned
  uv version and pinned PyYAML, without changing application dependencies.
- Local: 446 repository tests passed (one existing skip), 33 catalog and 17 cloud-config tests passed, targeted
  actionlint passed, and nine Newsletter tooling tests passed after the installer correction. Independent review
  also passed 93 targeted tests. An initial branch run caught the root installer violating the existing uv-only
  workflow check; the final revision uses uv and passed the full gate. No Newsletter runtime or owner settings changed.

## Imported repositories

Mail Hero and Todofy were separate repositories until 2026-09-29; the website joined on 2026-09-30.
Their histories are kept. See [Mail Hero's commit map](../mail-hero/docs/history-map.md) and
[the website's commit map](../website/docs/history-map.md). FlowDay was imported as a snapshot; its original
repository retains its earlier history. Newsletter retains its own runtime and image release after joining here.

## Owner API compatibility

The Cloudflare owner APIs use the shared proto HTTP pattern. The dated cleanup schedule is:

| Surface | Old-client response | Earliest removal date |
| --- | --- | --- |
| Mail Hero | Old envelope, 410 `reload_required` | 2026-11-01 |
| Home | Old envelope, 410 `not_found` with a reload message | 2026-11-02 |
| FlowDay and Todofy | Old envelope, 410 `reload_required` | 2026-11-02 |
| FlowDay `UpdateTimerSession` / `ClearTimerSession` | google.rpc.Status, `RELOAD_REQUIRED`; refresh for server-owned timer commands | 2026-11-13 |
| Mailsort (`mailsort.ui.v1`, `/api/v1/...`) | google.rpc.Status, 410 `RELOAD_REQUIRED` with the zh-CN message 邮件分拣已更新，请刷新页面 | 2026-11-10 |

Do not remove these routes early. Read HANDOFF before removal and test what an old client shows.
Todofy's old `owner_api` core RPC remains for the previous gateway during the compatibility release.
These dates do **not** authorise deleting legacy webhook fixtures, schemas, event identities or database migrations.
Frozen bytes prove compatibility with events persisted by older code, including restored backups.

## Historical designs

The TypeScript-only [first Todofy migration proposal](../todofy/docs/cloudflare-migration-plan-v1.md) was
superseded by the [Python-core migration plan](../todofy/docs/cloudflare-migration-plan.md). The latter also
records assumptions that have changed; the [development notes](../todofy/docs/dev-notes.md),
[gateway contract](../todofy/docs/gateway-contract.md) and [release runbook](../todofy/docs/ci-cd.md) govern current work.

[Home's original design](../dashboard/docs/design.md) still governs storage, tick, guard, canary and digest.
[Its current views](../dashboard/docs/design-v2.md) and `dashboard.ui.v1` replaced the old UI/routes. Keep the
still-current invariants before archiving any section. The [original Ops implementation plan](../contracts/ops-v1/IMPLEMENTATION.md)
labels its superseded handwritten types and its later IDL migration.

Completed rollout proposals may move to a clearly labelled archive after links and current runbooks are updated.
Do not delete operational evidence or scripts needed for import, rollback, recovery or additive schema migration.

## Committed-config rollback

Historical procedure from the 2026-09-30 move to committed Wrangler configs. The variables below were retained
for that cutover's rollback window; this document has not checked whether they still exist. Do not recreate or
use them without checking the current runbook and obtaining the task's required production authorisation.


Before the committed configs, CI generated each config from GitHub variables. These production variables
are still set but **nothing reads them now**; changing one has no effect (change the committed
`wrangler.toml` instead): `CLOUDFLARE_ACCOUNT_ID`, `MAIL_HERO_PUBLIC_HOST`, `MAIL_HERO_D1_DATABASE_ID`,
`MAIL_HERO_D1_DATABASE_NAME`, `MAIL_HERO_R2_BUCKET_NAME`, `MAIL_HERO_BACKUP_BUCKET_NAME`,
`MAIL_HERO_ACCESS_ISSUER`, `MAIL_HERO_ACCESS_AUDIENCE`, `MAIL_HERO_WEBHOOK_ALLOWED_HOSTS`,
`MAIL_HERO_INGEST_DAILY_MESSAGE_LIMIT`, `MAIL_HERO_INGEST_DAILY_BYTE_LIMIT`, `TODOFY_PUBLIC_HOST`,
`TODOFY_D1_DATABASE_ID`, `TODOFY_HOOKS_HOSTS`, `TODOFY_ACCESS_ISSUER`, `TODOFY_ACCESS_AUDIENCE`,
`DASHBOARD_PUBLIC_HOST`, `DASHBOARD_ACCESS_ISSUER`, `DASHBOARD_ACCESS_AUDIENCE`.

They are the rollback path: reverting the layout's merge commit on `main` brings the generators back, CI
redeploys Mail Hero, both Todofy Workers (together, as `todofy/docs/ci-cd.md` requires) and the dashboard
from them, and a generator refuses a missing one ("Invalid or missing CI setting"). So keep all of them
until every Worker has had at least one successful deploy and one full cron cycle (a day) on the new
layout, and delete them in a follow-up change only after that. A revert deploys the values in these
variables, not the committed ones: if a committed value changed since the merge, update its variable
before reverting. Without them, the only rollback is Cloudflare's `wrangler rollback`, which Todofy allows
only for both Workers to their pre-merge pair; Mail Hero or the dashboard alone may be rolled back that
way in an emergency.

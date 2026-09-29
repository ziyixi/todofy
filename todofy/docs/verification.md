# Verification

Only what actually ran is recorded here, with the date and where. "Pending" means not done yet; nothing
in a pending section may be read as passed.

## Local suites (2026-09-29, macOS, clean copy of branch `cf-rewrite` plus uncommitted finisher changes)

The `Todofy checks` sequence was run from a copy holding only tracked and new source files (no
`node_modules`, `.venv`, `python_modules`, `uiassets/dist` or `.wrangler`):

| Step | Result |
|---|---|
| `npm ci`, `uv sync --locked` | ok |
| `ruff check worker tests tools deploy` | all checks passed |
| `ruff format --check worker tests tools deploy` | 110 files already formatted |
| `pytest tests/unit tests/fakes tools deploy` | 646 passed, 1 skipped (the proto cross-check needs a `protos` checkout next to the repository checkout, or `TODOFY_PROTOS_DIR`) |
| `web`: `npm ci`, `check:api`, `typecheck`, `test`, `build`, source guard | generated types match; 8 files, 61 tests passed; build ok; guard ok |
| `pytest tests/runtime` (workerd, real D1, Durable Object, alarms, cron, assets) | 326 passed in 8 min 16 s |
| placeholder production config + `pywrangler deploy --dry-run --secrets-file ...` | generated; `ACCESS_OWNER` and `ACCESS_OWNER_ALIASES` shown as `(hidden)`; workers SDK vendored in the bundle |

Also run on system Python 3.9.6 (the mini-PC's class of interpreter), synthetic data only:
`tools/legacy_migration/snapshot.py` on a WAL-mode inbox with an un-checkpointed commit kept the
committed change (a plain copy of the main file did not), and `legacy_to_d1.py` exported the snapshot
(47 summaries, 46 texts, CloudMailin rows included by default).

Limits of these runs: workerd does not enforce or report CPU time locally, so Workers Free CPU limits
(10 ms per Worker request, 30 s per Durable Object invocation) are not proven here; production CPU comes
from Workers Logs. Cloudflare Access, Custom Domains, TLS and D1 remote behaviour are not exercised.

## Production

Observed on the live account, hosts and callers on 2026-09-29; times are UTC. Only IDs, counts, status
codes and timings are recorded, never mail content, credentials or owner emails (the repository is
public). Sections below the checklist hold the evidence.

| Check | Status |
|---|---|
| D1 created, Access app, GitHub `production` environment | passed: D1 `todofy` took the import, the UI answered through Access, the releases below that went live were deployed from `main` |
| First deploy from `main`: `/health` reports the commit on the hooks host; UI host 401 without Access | deployed (`2a5ef96`); the `/health` commit and the 401 without Access were not recorded: pending |
| Worker secrets set; webhook smoke test (`tools/smoke_webhook.py`: 401/415/413/400/204/204/409) | passed with the real token |
| Owner login through Access (primary email and GitHub-login alias) and a UI reconcile | partly: the UI checks below passed through Access, including one reconcile action (`dismiss`); which login was used and the alias login were not recorded: pending |
| Mail Hero test event → `complete` with a Todoist task | passed: `complete` over the real Worker-to-Worker path |
| Cutover: snapshot, export, import, `verify_d1.py` PASS | passed |
| Newsletter: `/api/summary` and `/api/recommendation?top=10` return 200 | passed: 200 to the newsletter's own httpx client; its first scheduled run through RPC is pending |
| First real mail end to end | passed (`e4a57d8e`, `b3407aca`) |
| One-week usage check (Workers, DO, D1 reads/writes against the shared Free allowance) | pending |

### Cutover (2026-09-29, 07:49–08:10)

| Step | Result |
|---|---|
| Old Go containers | stopped |
| Snapshot | taken in an offline one-off container (`inbox.sqlite` is root-owned); consistent |
| Export (`legacy_to_d1.py`) | `mail_events` 142 (141 `complete`, 1 `ignored`), `summaries` 13,263, `legacy_mail_text` 13,262 (~44 MB of SQL); 0 warnings |
| Rehearsal: the real export into a local D1, `verify_d1.py` | PASS, all tables |
| Import into the remote D1 `todofy`, `verify_d1.py --remote` | PASS, every table |
| `daily.ziyixi.science` | Tunnel CNAME deleted by the owner; the host is now a Custom Domain of the Worker `todofy`; same anycast IPs, no DNS impact |
| Callers | unchanged: Mail Hero target `https://daily.ziyixi.science/hooks/mail` (Bearer); newsletter `TODO_API_BASE` `https://daily.ziyixi.science` (Basic) |

The remote import ran once only: D1 Free allows 100,000 rows written per day for the whole account
(shared with Mail Hero), and the import writes about 75,000 including index entries.

### Incident: newsletter crash loop (2026-09-29, 08:26–09:08)

The newsletter container restarted 54 times. Its startup preflight requires `GET /health` to return
`service=todofy` and `status=healthy` (the Go service's shape), which the rewrite did not return.
`981a47f` added both fields (now `gateway/src/hooks.ts`) and fixed it. The newsletter's Basic password
was rotated to a new 48-character random value; the old credential gets 401.

### Checks after the cutover (2026-09-29)

| Check | Result |
|---|---|
| `tools/smoke_webhook.py` with the real token | 401/415/413/400/204/204/409: PASS |
| Newsletter endpoints with the newsletter's own httpx client | 200 |
| Owner UI through Access: attention list, event detail, dismiss (CSRF + `action_request_id`), mobile layout | OK |
| Synthetic event end to end | Gemini (`gemini-3.8-flash`) → Todoist task within seconds |
| Mail Hero "send test event" over the real Worker-to-Worker path | `complete` |
| Real mail | `e4a57d8e` `complete` at 13:55 through the TypeScript gateway; `b3407aca` `complete` at 19:29 through RPC |

### Releases (2026-09-29)

| Commit | Change | Result |
|---|---|---|
| `2a5ef96` | first deploy: the single Python Worker `todofy` | live; served the cutover |
| `981a47f` | Go-shaped `/health` fields | live; ended the newsletter crash loop |
| `e3ca6de` | gateway split: TypeScript `todofy` + Python `todofy-core` | deploy blocked by flaky runtime tests; `2dec605` made them deterministic (its deploy then met the 10061 refusal below, [gateway-contract.md](gateway-contract.md) §6.6) |
| `a8e8f4f` | core class renamed `TodofyCore` | refused: Cloudflare error 10061 on `deleted_classes` while a live version still bound the class |
| `bc7b89e` | gateway that sends no migration (only the published `v1`) and exports an empty retired `TodofyCoordinator` | live: the gateway replaced the Python version |
| `90519d5` | RPC between gateway and core; weekly D1 → R2 backup; Analytics Engine metrics; migration `0002_daily_metrics` | live; first backup in `todofy-backups`: 18 MB, 7 tables, manifest verified; dataset `todofy_metrics` (the owner enabled Analytics Engine) |
| `4a6dffd` | gateway-only release deleting the retired class (`v2` `deleted_classes`) | accepted |
| `9ae9d8d` | RPC transition shim removed from the core | released; no separate check recorded |
| `55d2d40` | monorepo `ziyixi/todofy` (`todofy/`, `mail-hero/`, `contracts/`) | both apps deployed from it (Mail Hero Worker version `fc04e12b` at 21:08); backup collector image published as `ghcr.io/ziyixi/mail-hero-backup-collector`; the old `mail-hero` repository's workflows disabled; required check `CI gate` |

### CPU (Workers Free: 10 ms per plain Worker invocation, 30 s per Durable Object invocation)

| Release | Worker | Sample | CPU |
|---|---|---|---|
| before `bc7b89e` | single Python Worker `todofy` | 406 invocations, 0 errors | p50 9.3 ms, p90 21.4 ms, p99 42.3 ms: over 10 ms at p90 and p99 |
| `bc7b89e` | gateway `todofy` | 45 invocations | p50 1 ms, max 4 ms; none over 10 ms |
| `bc7b89e` | core Durable Object | | p50 12 ms, max 320 ms |
| `90519d5` | gateway | | p50 and max 2.3 ms |
| `90519d5` | core, first backup | 70 alarm steps | p50 234 ms, p99 1.3 s |

First-day samples, not the one-week usage check.

### Old stack retired (2026-09-29)

- Go containers and images removed, their Compose block removed (`self-host-on-vultr` `00f23f8`), data
  directories and env files deleted.
- The cutover snapshot stays on the host at `~/todofy-legacy-2026-09-29` until 2026-10-29.
- The Gemini and Todoist keys were reused; they are now secrets on `todofy-core` only.

### Pending

- The newsletter's first scheduled run through RPC (next: 2026-09-30 14:00 UTC).
- The first `daily_metrics` rows. Read from `worker/todofy/runtime/metrics.py`, not observed: counting
  began part-way through 2026-09-29, so that day stays "not recorded" and the 2026-09-30 00:05 flush
  writes nothing; the first rows are for 2026-09-30, written shortly after 2026-10-01 00:05 UTC.
- The one-week usage check (Workers, DO, D1 reads/writes, R2, against the shared Free allowance).
- The checklist items still open: `/health` reporting the deployed commit and the UI host's 401 without
  Access; the alias login.
- Deleting the snapshot on the host after 2026-10-29.

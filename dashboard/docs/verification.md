# Home dashboard: verification record

Only what was actually run is marked as passed. Local evidence and production evidence are recorded
separately; nothing below "Production" has happened yet.

## 1. Local, from a clean clone (2026-09-29)

Commit `2e3fc28` (branch `dashboard`, on top of `ops-layer` = `main` at `c2bc62a`), cloned fresh
into a throwaway directory; macOS, Node 26.9.0, the workflow's commands and placeholder values, no
token, no Cloudflare API call, synthetic data only. Every CI job's steps were run in the order
`.github/workflows/ci.yml` runs them.

| Job | Step | Result |
| --- | --- | --- |
| `Changes` | `python3 -m unittest discover -s .github/scripts` | 47 tests passed |
| | `ci_changes.py` for this branch (merge base with `origin/main`) | 92 files changed; every check, `contracts`, `packages` and every deploy flag true |
| `Shared packages` | `packages/edge-auth`: `npm ci`, `npm run typecheck`, `npm test` | typecheck OK (both lib sets); 195 tests passed |
| `Dashboard checks` | `npm ci` in `worker` and `web` | OK |
| | `node --test deploy/test/*.test.mjs` | 6 passed |
| | worker `lint`, `typecheck` | OK |
| | worker `npm test` (vitest, Node) | 7 files, 91 tests passed (includes the new `limits.test.ts`: `docs/limits.md` and `limits.ts` agree) |
| | worker `npm run test:runtime` (Miniflare/workerd: real `HomeState`, stub `mail-hero`/`todofy` Ops Workers serving contract fixtures, fake GraphQL, test Access JWKS) | 5 files, 36 tests passed |
| | web `lint`, `typecheck`, `test`, `build` | OK; 7 files, 41 tests passed; build OK, `dist/` has no cross-origin reference |
| | import guard (no `mail-hero/` or `todofy/` import in `worker/src`, `web/src`) | OK (the pattern was also checked to catch static, type and dynamic imports) |
| | generator + `wrangler deploy --dry-run --secrets-file` of the placeholder production config | OK: bindings `HOME` (HomeState), `MAIL_HERO` (mail-hero#Ops), `TODOFY` (todofy#Ops), `ASSETS`; the four secrets shown as "(hidden)"; bundle exports `HomeState` and `default`, contains `packages/edge-auth/src`, no app code, and the only Cloudflare API URL is `https://api.cloudflare.com/client/v4/graphql` |
| `Contracts` | Mail Hero: `contract-fixtures`, `ops-contract`, `native-ops` | 38 passed |
| | Todofy: contract, compat, OpenAPI vocabulary, ops contract and ops core | 310 passed |
| | Todofy gateway `test/ops.test.ts` | 10 passed |
| | Dashboard (new): `ops-client`, `guard`, `canary`, `digest` | 4 files, 48 tests passed |
| `Mail Hero checks` | deploy config tests; backup tests | 3 passed; 29 ran, 1 skipped (no GPG locally) |
| | Worker typecheck and `npm test` (includes workerd bindings) | OK; 168 passed |
| | UI typecheck, tests, build | OK; 66 passed; OK |
| | placeholder config dry-run | OK |
| `Todofy checks` | ruff check / format | OK / 128 files formatted |
| | host tests (`tests/unit tests/fakes tools deploy`) | 941 passed, 1 skipped |
| | gateway lint, typecheck, tests | OK; 86 passed |
| | UI `check:api`, typecheck, tests, build, no-Mail-Hero guard | OK; 76 passed; OK; OK |
| | workerd runtime tests | 391 passed (13 min) |
| | placeholder configs dry-run (core and gateway) | OK; the core bundle contains `python_modules/workers` |
| `CI gate` | the gate script with `Dashboard checks` = success / skipped / failure | exit 0 / 0 / 1 |
| workflow | `ci.yml` parsed as YAML; job graph | `dashboard-deploy` needs `changes, dashboard-checks, gate, todofy-deploy, mail-hero-deploy`, group `dashboard-production`; `gate` needs every check job |
| `Dashboard deploy` probe | the step's script with a stubbed `curl` | 302 to the issuer passes; no connection twice then 302 passes (retry); 200 from the app, a 302 elsewhere, and a persistent 522 fail |

Earlier, per-component evidence (same synthetic data, before the CI integration): the Worker commit
`f6768cb` (77 unit, 36 runtime, 6 generator tests) and the UI commit `78693eb` (41 tests, build).

Not run locally: the deploy jobs themselves (they need the `production` environment), and nothing
that needs a real Access login, a real analytics token or the deployed apps.

## 2. Production (pending)

None of these has been done; each needs the first `Dashboard deploy` on `main` (after Todofy and Mail
Hero with ops-v1 are live) and, where stated, the owner in a browser.

| Item | How | Status |
| --- | --- | --- |
| First deploy | `Dashboard deploy` succeeds; Custom Domain `home.ziyixi.science` gets DNS and a certificate | pending |
| Access fronts the host | the job's probe (302 to the team domain for `/` and `/api/v1/overview`) | pending |
| Real Access login | the owner opens the page with the primary login and, where configured, an alias; one refresh and one confirmed action | pending |
| Analytics token | the GraphQL query with the production token returns every dataset; then the token is replaced by an "Account Analytics: Read" token (setup.md §4) and checked again | pending (a broader token is still reused) |
| Quota numbers | spot-check the page's daily numbers against the Cloudflare dashboard's usage pages for the same UTC day | pending |
| First scheduled canary | the day's run reaches `ok` (Mail Hero delivered, Todofy one Gemini call, no Todoist task, not listed as mail) | pending |
| Guard round trip | only if a real ≥ 80 % day happens, or by the owner's 强制降载 then 解除降载: both apps report the guard in `status()` and clear it | pending |
| Digest | Todofy's next daily reminder carries the dashboard's warning/critical items, or none | pending |
| Open questions from `limits.md` §4 | whether `Ops` calls appear in the apps' Worker request totals; unclassified R2 action types; analytics lag at a tick; `durableObjectsStorageGroups` data | pending |

Known gap: there is no configuration switch to pause the scheduled canary. To stop it (for example
before a Todofy rollback), remove the Worker's Cron Trigger ([`setup.md`](setup.md) §7).

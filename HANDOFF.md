# Handoff: work in flight

This file is the shared working state of the monorepo for whoever picks up next: the owner, a local agent
session, or a cloud agent with only this repository. It lists what is being built, in which branch, in
what order it merges, what still needs checking after a deploy, and what waits for the owner.

Rules for this file:

- Update it in the same change that starts, lands or abandons a piece of work. A stale entry is worse
  than none.
- This repository is public. Write branch names, commit SHAs, public hostnames, phases and steps. Never
  write secrets, personal values (addresses, emails, Todoist ids), raw API output, watched URLs, or
  security-posture details. Those stay with the owner.
- Keep it short. The details live in each app's docs; link to them.

Last updated: 2026-10-02 (watch-l2 lands with this change; `mail.received.v1` on proto and watch-infra have landed, and "Infra apply" created the Access application "watch").

## How work lands

1. Commit on a branch and push it. Branch CI runs every check job and never deploys.
2. When the branch run is green, fast-forward `main` to the same SHA (`git push origin <sha>:main`).
   Branch protection requires `CI gate`; `main`'s run reuses the green branch checks and runs only the
   deploy jobs the diff reaches (`.github/scripts/ci_changes.py`).
3. Never deploy by hand. Production changes only through CI on `main`.
4. Cloudflare objects managed by `infra/` (Access apps and policies, D1, R2 of the monorepo apps) change only
   through a commit there plus a dispatch of "Infra apply" with `expect` set to the counts and fingerprint the
   "Infra drift" run printed (`infra/README.md`). Never edit them in the dashboard.
5. If two branches touch the same CI files (`ci.yml`, `ci_changes.py`, `test_ci_changes.py`, `README.md`,
   `AGENTS.md`, `proto/README.md`), land one, rebase the other onto the new `main`, resolve by meaning (keep
   both sides), and re-run its checks before pushing.

## In flight

| Work | Branch (pushed unless noted) | State | Lands as |
| --- | --- | --- | --- |
| Watch W2 + W3: `watch.ziyixi.science`, daily Todoist digest via task-intent `SOURCE_WATCH` (Todofy's least-privilege `Intents` entrypoint), Ops status and the 网页监视 tile for the dashboard | `watch-l2` | Lands with this change (the AUD and the application id of the Access application "watch" filled in) | Needs the `production` secret `WATCH_CSRF_SIGNING_KEY` before the push; deploys Todofy before watch, then the dashboard, Lab and Mail Hero, and runs "Infra drift" (`infra/` changed) |

## Waiting to be verified

- After `proto-mail` deploys: one manual canary from the dashboard (Ops `startCanary`); it must be queued,
  delivered with the canary marker, and recorded by Todofy. Do not test with real archived mail: a real send
  creates real Todoist tasks.
- 2026-10-02 13:30 UTC: the first newsletter reports built by `todofy.report.v1` (Todofy precompute), then
  the newsletter run that reads them.
- FlowDay rollback window (F5) ends 2026-10-08: the old container stays untouched until then. F6 (retire the
  container, its tunnel ingress and the `flowday-bypass` Access app) needs the owner's OK and goes through
  `infra/` for the Access app (`flowday/docs/design.md` section 11).
- Infra drift must stay `no-op` on its daily run (13:23 UTC).
- After `dashboard-new-tiles` deploys: 首页 shows FlowDay and 短链接 as ● 正常 with a latency
  (`dashboard/docs/verification.md` §2).
- After `watch-l2` deploys (`watch/README.md` "Deploy"):
  - its push's "Infra drift" is green with `no-op: 19`, `output changes: 0` and no outputs problem: the only check of
    the committed AUD (Access answers the deploy's probes before the Worker runs);
  - signed in, `https://watch.ziyixi.science/status` shows a next scheduler time (the alarm is armed);
  - the dashboard's 网页监视 tile (首页, 应用) is ● 正常 with its 新变化 count on its next tick, and the 网页监视 flow shows;
  - the first daily digest task in Todoist after 14:00 UTC on a day a watch has changed (Todofy's `Intents`, source
    watch);
  - a follow-up commit records the `WatchState` Durable Object namespace id in the dashboard registry
    (`dashboard/worker/src/registry.ts` RESOURCES `watch-state`, read-only from the account's namespace list).

## Waiting for the owner

- Enter the Todoist key once in FlowDay's settings (the Worker stores it sealed; sync stays off until then).
- Optional: Chrome site search `s` → `https://s.ziyixi.science/%s` (`links/README.md`).
- Dedicated Cloudflare tokens (`CF_INFRA_READ_TOKEN`, `CF_INFRA_TOKEN`) and a fresh deploy token
  (`infra/README.md` "Replacing the token").
- Retiring the self-hosted Slash and changedetection containers (no data import is wanted).

## Next, in order

1. Land the rows above, then verify as listed.
2. proto: the remaining UI APIs (Todofy's owner API, today an OpenAPI document; dashboard; Mail Hero; FlowDay),
   each on the shared transcoder and client (`proto/README.md`).
3. Watch W4: a shadow-mode week, then move the owner's watches over.
4. Service catalog: one `app.toml` per app generating hostnames, Access apps, dashboard links and probes,
   validated against each `wrangler.toml`.
5. Code quality phases (English comments everywhere, coverage and lint ratchets, clock injection in every
   app's tests).

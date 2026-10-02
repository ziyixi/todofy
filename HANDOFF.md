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

Last updated: 2026-10-02 (watch is live; the canary after the mail.received.v1 move passed; the dashboard tiles show FlowDay and links ok).

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
| Owner/UI APIs onto proto (google.api.http, the shared transcoder and client), like Lab's | `proto-todofy-ui`, `proto-mail-hero-ui`, `proto-flowday-ui` (local) | In progress (build, two reviews, fix per app) | One app at a time; each deploys only its app. External routes (Todofy's newsletter endpoints, the mail webhook, backup APIs) keep their paths and bytes. The dashboard's API follows |

## Waiting to be verified

- 2026-10-02 13:30 UTC: the first newsletter reports built by `todofy.report.v1` (Todofy precompute), then
  the newsletter run that reads them.
- FlowDay rollback window (F5) ends 2026-10-08: the old container stays untouched until then. F6 (retire the
  container, its tunnel ingress and the `flowday-bypass` Access app) needs the owner's OK and goes through
  `infra/` for the Access app (`flowday/docs/design.md` section 11).
- Infra drift must stay `no-op` on its daily run (13:23 UTC).
- Watch (live since 2026-10-02): the first daily digest task in Todoist after 14:00 UTC on a day a watch has
  changed (Todofy's `Intents`, source watch). No watches exist yet; W4 (a shadow-mode week, then the owner's watches)
  is next for this app.

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

#!/usr/bin/env node
// The values of the Worker "links" that are never committed to ../wrangler.toml, added at deploy time by the shared
// core (tools/cloud-config/worker-deploy.mjs: the rules, the commands and why they refuse):
//
// - with `wrangler deploy --var NAME:value`: BUILD_SHA (the commit). The links app has no GitHub-variable switches;
// - with `--secrets-file`: the owner's addresses (inputs LINKS_ACCESS_OWNER, LINKS_ACCESS_OWNER_ALIASES, masked in the
//   public Actions log). The deploy job ("Links deploy") fills them from the dashboard's environment secrets
//   DASHBOARD_ACCESS_OWNER and DASHBOARD_ACCESS_OWNER_ALIASES (the same owner).
//
// Since L2 (../docs/design.md §11) ../wrangler.toml holds the real D1 id and Access AUD. A real deploy is still refused
// while either is the all-zeros placeholder (a guard against a revert to the L1 config); a `wrangler deploy --dry-run`
// (CI's bundle check) needs no real resource and is always allowed.
//
// .github/scripts/test_wrangler_configs.py reads the next lines: every CI step that runs `exec` or `secrets` must set
// each input of that mode (Actions sets GITHUB_* itself).
// deploy-vars-inputs exec: GITHUB_SHA
// deploy-vars-inputs secrets: LINKS_ACCESS_OWNER LINKS_ACCESS_OWNER_ALIASES
import { BUILD_SHA, workerDeploy } from '../../tools/cloud-config/worker-deploy.mjs'

const deploy = workerDeploy(import.meta.url, {
  worker: 'links',
  injected: [BUILD_SHA],
  owner: 'LINKS_ACCESS_OWNER',
  guard: { database_id: 'zeros', ACCESS_AUDIENCE: 'zeros' },
})

export const {
  CONFIG, INJECTED, SettingError, injectedVars, wranglerArgs, generateSecrets, placeholderIn, writeSecrets, refusal, run,
} = deploy

deploy.main()

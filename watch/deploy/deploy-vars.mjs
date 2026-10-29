#!/usr/bin/env node
// The values of the Worker "watch" that are never committed to ../wrangler.toml, added at deploy time by the shared
// core (tools/cloud-config/worker-deploy.mjs: the rules, the commands and why they refuse):
//
// - with `wrangler deploy --var NAME:value`: BUILD_SHA (the commit). The watch app has no GitHub-variable switches;
// - with `--secrets-file`: the owner's addresses (inputs WATCH_ACCESS_OWNER, WATCH_ACCESS_OWNER_ALIASES, masked in the
//   public Actions log). The deploy job ("Watch deploy") fills them from the dashboard's environment secrets
//   DASHBOARD_ACCESS_OWNER and DASHBOARD_ACCESS_OWNER_ALIASES (the same owner, like the links app).
//
// Since W2 (../docs/design.md §11) ../wrangler.toml holds the Access application's AUD (the app has no D1). A real
// deploy is still refused while it is the all-zeros placeholder (a guard against a revert to the W1 config); a
// `wrangler deploy --dry-run` (CI's bundle check) needs no real resource and is always allowed.
//
// .github/scripts/test_wrangler_configs.py reads the next lines: every CI step that runs `exec` or `secrets` must set
// each input of that mode (Actions sets GITHUB_* itself).
// deploy-vars-inputs exec: GITHUB_SHA
// deploy-vars-inputs secrets: WATCH_ACCESS_OWNER WATCH_ACCESS_OWNER_ALIASES
import { BUILD_SHA, workerDeploy } from '../../tools/cloud-config/worker-deploy.mjs'

const deploy = workerDeploy(import.meta.url, {
  worker: 'watch',
  injected: [BUILD_SHA],
  owner: 'WATCH_ACCESS_OWNER',
  guard: { ACCESS_AUDIENCE: 'zeros' },
})

export const {
  CONFIG, INJECTED, SettingError, injectedVars, wranglerArgs, generateSecrets, placeholderIn, writeSecrets, refusal, run,
} = deploy

deploy.main()

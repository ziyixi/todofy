#!/usr/bin/env node
// The values of the Worker "newsletter-console" that are never committed to ../wrangler.toml, added at deploy time by
// the shared core (tools/cloud-config/worker-deploy.mjs: the rules, the commands and why they refuse):
//
// - with `wrangler deploy --var NAME:value`: BUILD_SHA (the commit). The console has no GitHub-variable switches;
// - with `--secrets-file`: the owner's addresses, which are Home's (one person, the same Access identities): the deploy
//   job fills NEWSLETTER_CONSOLE_ACCESS_OWNER(_ALIASES) from Home's identity secrets, and of Home's map
//   (DASHBOARD_WORKER_SECRETS) only ACCESS_OWNER and ACCESS_OWNER_ALIASES are taken (worker-secrets.json
//   identity_from): nothing else of Home's reaches this Worker. The console holds no credential of its own.
//
// The Access application's AUD is absent from ../wrangler.toml until "Infra apply" creates it (README.md 上线顺序): a
// real deploy needs it committed and well formed, and a dry run (CI's bundle check) is allowed only while it is absent.
//
// .github/scripts/test_wrangler_configs.py reads the next lines: every CI step that runs `exec` or `secrets` must set
// each input of that mode (Actions sets GITHUB_* itself).
// deploy-vars-inputs exec: GITHUB_SHA
// deploy-vars-inputs secrets: NEWSLETTER_CONSOLE_ACCESS_OWNER NEWSLETTER_CONSOLE_ACCESS_OWNER_ALIASES DASHBOARD_WORKER_SECRETS
import { BUILD_SHA, workerDeploy } from '../../tools/cloud-config/worker-deploy.mjs'

const deploy = workerDeploy(import.meta.url, {
  worker: 'newsletter-console',
  injected: [BUILD_SHA],
  owner: 'NEWSLETTER_CONSOLE_ACCESS_OWNER',
  guard: { ACCESS_AUDIENCE: 'strict' },
})

export const {
  CONFIG, INJECTED, SettingError, injectedVars, wranglerArgs, generateSecrets, placeholderIn, writeSecrets, refusal, run,
} = deploy

deploy.main()

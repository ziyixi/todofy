#!/usr/bin/env node
// The values of the Worker "mailsort" that are never committed to ../wrangler.toml, added at deploy time by the shared
// core (tools/cloud-config/worker-deploy.mjs: the rules, the commands and why they refuse):
//
// - with `wrangler deploy --var NAME:value`: MODE (the GitHub variable MAILSORT_MODE: `live`, `shadow` or `off`, the
//   highest mode the deployment allows: the emergency switch) and BUILD_SHA (the commit);
// - with `--secrets-file`: the owner's addresses (inputs MAILSORT_ACCESS_OWNER, MAILSORT_ACCESS_OWNER_ALIASES, masked
//   in the public Actions log). The deploy job fills them from the dashboard's DASHBOARD_ACCESS_OWNER(_ALIASES) (the
//   same owner, like the watch app).
//
// The Gmail grant (GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN) is never part of a deploy: the owner puts
// it from their own machine (mint-token.mjs). The secrets file never names it, and this wrapper refuses a
// MAILSORT_WORKER_SECRETS map that does, so it can neither come from GitHub nor be overwritten by a deploy; and
// `wrangler deploy --secrets-file` keeps every secret the file does not name (test/secrets-kept.test.mjs checks the
// pinned wrangler), so a deploy never deletes it either.
//
// A real deploy is refused while ../wrangler.toml has no ACCESS_AUDIENCE (before "Infra apply" creates the Access
// application); a `wrangler deploy --dry-run` (CI's bundle check) is always allowed.
//
// .github/scripts/test_wrangler_configs.py reads the next lines: every CI step that runs `exec` or `secrets` must set
// each input of that mode (Actions sets GITHUB_* itself).
// deploy-vars-inputs exec: MAILSORT_MODE GITHUB_SHA
// deploy-vars-inputs secrets: MAILSORT_ACCESS_OWNER MAILSORT_ACCESS_OWNER_ALIASES
import { BUILD_SHA, workerDeploy } from '../../tools/cloud-config/worker-deploy.mjs'

const deploy = workerDeploy(import.meta.url, {
  worker: 'mailsort',
  injected: [{ name: 'MODE', from: 'MAILSORT_MODE', kind: 'toggle', pattern: /^(?:live|shadow|off)$/ }, BUILD_SHA],
  owner: 'MAILSORT_ACCESS_OWNER',
  ownerOnly: ['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN'],
  guard: { ACCESS_AUDIENCE: 'required' },
})

export const {
  CONFIG, INJECTED, OWNER_ONLY_SECRETS, SettingError, injectedVars, wranglerArgs, generateSecrets, placeholderIn,
  writeSecrets, refusal, run,
} = deploy

deploy.main()

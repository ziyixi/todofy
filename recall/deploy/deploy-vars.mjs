#!/usr/bin/env node
// The values of the Worker "recall" that are never committed to ../wrangler.toml, added at deploy time by the shared
// core (tools/cloud-config/worker-deploy.mjs: the rules, the commands and why they refuse):
//
// - with `wrangler deploy --var NAME:value`: BUILD_SHA (the commit). recall has no operational switch: its emergency
//   stops are the owner's (../docs/design.md §9);
// - with `--secrets-file`: the owner's addresses (inputs RECALL_ACCESS_OWNER, RECALL_ACCESS_OWNER_ALIASES, masked in
//   the public Actions log). The deploy job fills them from the dashboard's DASHBOARD_ACCESS_OWNER(_ALIASES) (the same
//   owner, like mailsort).
//
// The digests of the two machine tokens (INGEST_TOKEN_SHA256, EXPORT_TOKEN_SHA256 and their _PREVIOUS) are never part
// of a deploy: the owner makes the tokens in recall's 设置 (RecallState keeps their digests), and a digest put by hand
// as a Worker secret stays accepted. The secrets file never names them, and this wrapper refuses a
// RECALL_WORKER_SECRETS map that does, so they can neither come from GitHub nor be overwritten by a deploy; and
// `wrangler deploy --secrets-file` keeps every secret the file does not name (test/secrets-kept.test.mjs checks the
// pinned wrangler), so a deploy never deletes them either.
//
// A real deploy is refused while ../wrangler.toml has no ACCESS_AUDIENCE (before "Infra apply" creates the Access
// application); a `wrangler deploy --dry-run` (CI's bundle check) is always allowed.
//
// .github/scripts/test_wrangler_configs.py reads the next lines: every CI step that runs `exec` or `secrets` must set
// each input of that mode (Actions sets GITHUB_* itself).
// deploy-vars-inputs exec: GITHUB_SHA
// deploy-vars-inputs secrets: RECALL_ACCESS_OWNER RECALL_ACCESS_OWNER_ALIASES
import { BUILD_SHA, workerDeploy } from '../../tools/cloud-config/worker-deploy.mjs'

const deploy = workerDeploy(import.meta.url, {
  worker: 'recall',
  injected: [BUILD_SHA],
  owner: 'RECALL_ACCESS_OWNER',
  ownerOnly: ['INGEST_TOKEN_SHA256', 'INGEST_TOKEN_SHA256_PREVIOUS', 'EXPORT_TOKEN_SHA256', 'EXPORT_TOKEN_SHA256_PREVIOUS'],
  guard: { ACCESS_AUDIENCE: 'required' },
})

export const {
  CONFIG, INJECTED, OWNER_ONLY_SECRETS, SettingError, injectedVars, wranglerArgs, generateSecrets, placeholderIn,
  writeSecrets, refusal, run,
} = deploy

deploy.main()

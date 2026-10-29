#!/usr/bin/env node
// Fleet production wrapper. Owner UI is read-only; its machine report identity is independent.
// The shared core (tools/cloud-config/worker-deploy.mjs) adds BUILD_SHA as a --var and writes the owner's addresses and
// the report HMAC key to the secrets file. A deploy needs the Access application's real AUD; a dry run runs only before
// one is committed.
// deploy-vars-inputs exec: GITHUB_SHA
// deploy-vars-inputs secrets: FLEET_ACCESS_OWNER FLEET_ACCESS_OWNER_ALIASES FLEET_REPORT_HMAC_KEY
import { BUILD_SHA, workerDeploy } from '../../tools/cloud-config/worker-deploy.mjs'

const deploy = workerDeploy(import.meta.url, {
  worker: 'fleet',
  injected: [BUILD_SHA],
  owner: 'FLEET_ACCESS_OWNER',
  secrets: [{ name: 'REPORT_HMAC_KEY', from: 'FLEET_REPORT_HMAC_KEY', pattern: /^[0-9a-fA-F]{64}$/ }],
  guard: { ACCESS_AUDIENCE: 'strict' },
})

export const {
  CONFIG, INJECTED, SettingError, injectedVars, wranglerArgs, generateSecrets, placeholderIn, writeSecrets, refusal, run,
} = deploy

deploy.main()

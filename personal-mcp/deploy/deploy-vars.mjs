#!/usr/bin/env node
// Personal MCP production wrapper. Access owns OAuth; the Worker checks the owner assertion.
// The shared core (tools/cloud-config/worker-deploy.mjs) adds BUILD_SHA as a --var and writes the owner's addresses
// to the secrets file. A deploy needs the Access application's real AUD; a dry run runs only before one is committed.
// deploy-vars-inputs exec: GITHUB_SHA
// deploy-vars-inputs secrets: PERSONAL_MCP_ACCESS_OWNER PERSONAL_MCP_ACCESS_OWNER_ALIASES
import { BUILD_SHA, workerDeploy } from '../../tools/cloud-config/worker-deploy.mjs'

const deploy = workerDeploy(import.meta.url, {
  worker: 'personal-mcp',
  injected: [BUILD_SHA],
  owner: 'PERSONAL_MCP_ACCESS_OWNER',
  guard: { ACCESS_AUDIENCE: 'strict' },
})

export const {
  CONFIG, INJECTED, SettingError, injectedVars, wranglerArgs, generateSecrets, placeholderIn, writeSecrets, refusal, run,
} = deploy

deploy.main()

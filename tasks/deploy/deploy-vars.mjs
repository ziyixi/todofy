#!/usr/bin/env node
// Tasks production wrapper on the shared core (tools/cloud-config/worker-deploy.mjs): BUILD_SHA as a --var, and the
// secrets file from Tasks' own complete TASKS_WORKER_SECRETS map, which holds the owner (and any aliases) itself.
// A real deploy is refused while the committed D1 id or Access AUD is the all-zeros placeholder.
// deploy-vars-inputs exec: GITHUB_SHA
// deploy-vars-inputs secrets: TASKS_WORKER_SECRETS
import { BUILD_SHA, workerDeploy } from '../../tools/cloud-config/worker-deploy.mjs'

const deploy = workerDeploy(import.meta.url, {
  worker: 'tasks',
  injected: [BUILD_SHA],
  owner: null,
  guard: { database_id: 'zeros', ACCESS_AUDIENCE: 'zeros' },
})

export const {
  CONFIG, INJECTED, SettingError, injectedVars, wranglerArgs, generateSecrets, placeholderIn, writeSecrets, refusal, run,
} = deploy

deploy.main()

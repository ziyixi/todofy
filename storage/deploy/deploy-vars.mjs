// deploy-vars-inputs exec: GITHUB_SHA
// deploy-vars-inputs secrets: STORAGE_ACCESS_OWNER STORAGE_ACCESS_OWNER_ALIASES DASHBOARD_WORKER_SECRETS
import { BUILD_SHA, workerDeploy } from '../../tools/cloud-config/worker-deploy.mjs'

const deploy = workerDeploy(import.meta.url, {
  worker: 'storage', injected: [BUILD_SHA], owner: 'STORAGE_ACCESS_OWNER', guard: { ACCESS_AUDIENCE: 'strict' },
})

export const {
  CONFIG, INJECTED, SettingError, injectedVars, wranglerArgs, generateSecrets, placeholderIn, writeSecrets, refusal, run,
} = deploy

deploy.main()

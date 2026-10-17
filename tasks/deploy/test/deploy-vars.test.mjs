import assert from 'node:assert/strict';
import test from 'node:test';
import { generateSecrets, placeholderIn, refusal } from '../deploy-vars.mjs';

const values = { ACCESS_OWNER: 'owner@example.test', CSRF_SIGNING_KEY: 'ab'.repeat(32) };
test('Tasks deploys from its own complete secret map without another application’s legacy inputs', () => {
  assert.deepEqual(generateSecrets({ TASKS_WORKER_SECRETS: JSON.stringify(values) }),
    { ...values, ACCESS_OWNER_ALIASES: ' ' });
  assert.throws(() => generateSecrets({ TASKS_WORKER_SECRETS: JSON.stringify({ ...values, UNDECLARED: 'no' }) }), /TASKS_WORKER_SECRETS/);
  assert.throws(() => generateSecrets({}), /TASKS_WORKER_SECRETS/);
});

test('deployment cannot target a different environment or an unprovisioned database', () => {
  assert.match(refusal(['wrangler', 'deploy', '--env', 'other']), /--env/);
  assert.equal(placeholderIn('database_id = "00000000-0000-0000-0000-000000000000"'), 'database_id');
  assert.equal(placeholderIn('ACCESS_AUDIENCE = "' + '0'.repeat(64) + '"'), 'ACCESS_AUDIENCE');
});

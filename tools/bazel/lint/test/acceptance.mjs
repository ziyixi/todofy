import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(process.env.TEST_SRCDIR, process.env.TEST_WORKSPACE);
const args = process.argv.slice(2);
for (let offset = 0; offset < args.length; offset += 3) {
  const [target, manifest, binary] = args.slice(offset, offset + 3);
  if (offset === 0) {
    const inputs = JSON.parse(readFileSync(resolve(root, manifest), 'utf8'));
    assert(inputs.files.includes('declaration.d.ts'));
  }
  const result = spawnSync(resolve(root, target), [manifest, binary], { cwd: root, encoding: 'utf8' });
  if (result.error) throw result.error;
  const output = result.stdout + result.stderr;
  assert.equal(result.status, offset / 3, output);
  if (offset === 3) {
    assert.match(output, /bad\.js/);
    assert.match(output, /no-undef/);
  }
}

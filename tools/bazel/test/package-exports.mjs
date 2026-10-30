import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const directory = process.argv[2];
const metadata = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
for (const [name, target] of Object.entries(metadata.exports)) {
  assert.equal(typeof target, 'string', `${metadata.name} export ${name} must name a file`);
  assert.ok(statSync(join(directory, target)).isFile(), `${metadata.name} export ${name}: ${target}`);
}

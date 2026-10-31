import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(process.env.TEST_SRCDIR, process.env.TEST_WORKSPACE);
const [manifest, binary] = process.argv.slice(2);
const { args, files } = JSON.parse(readFileSync(resolve(root, manifest), 'utf8'));
const result = spawnSync(resolve(root, binary), [...args, ...files], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;

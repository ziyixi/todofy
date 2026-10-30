// Delegate the original Node test runner to the repository's locked TSX executable.
import { spawnSync } from 'node:child_process';

const [tool, ...args] = process.argv.slice(2);
if (!tool) throw new Error('Missing declared TSX tool');
const result = spawnSync(tool, args, { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;

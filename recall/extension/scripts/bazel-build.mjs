import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildExtension } from './build.mjs';

const identity = JSON.parse(readFileSync(process.argv[2], 'utf8'));
await buildExtension({
  dist: resolve('dist'),
  commit: identity.commit,
  time: new Date(Number(identity.time) * 1000),
});

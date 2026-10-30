import { createRequire } from 'node:module';

const require = createRequire(new URL('../../../todofy/package.json', import.meta.url));
process.stdout.write(require('workerd').default + '\n');

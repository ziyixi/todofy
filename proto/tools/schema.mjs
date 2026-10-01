/**
 * The contracts' JSON Schemas generated from the IDL (tools/gen_schema.py: `buf build | gen_schema.py`; ops-v1's and
 * Todofy's reports), started without a shell like every tool of ensure.mjs (toolCommands: buf's entry point on this
 * Node, Python from PROTO_PYTHON, else python3, or python on Windows), so `npm run schema` and `npm run check:schema`
 * run wherever generation does.
 *
 *   node tools/schema.mjs           rewrites the committed schemas (SCHEMAS in gen_schema.py)
 *   node tools/schema.mjs --check   fails when a committed schema is not the generated one (Proto checks, Contracts,
 *                                   and this folder's npm test, so a stale schema shows up locally too)
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toolCommands } from './ensure.mjs';

const PROTO = dirname(dirname(fileURLToPath(import.meta.url)));

function main(args) {
  if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) {
    console.error('usage: node tools/schema.mjs [--check]');
    return 2;
  }
  const tools = toolCommands();
  const [node, bufPrefix] = tools.buf;
  // With source info: a self-contained schema describes its message and fields with their comments.
  const image = spawnSync(node, [...bufPrefix, 'build', '--exclude-imports', '-o', '-#format=json'], {
    cwd: PROTO,
    maxBuffer: 64 << 20,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  if (image.error !== undefined || image.status !== 0) {
    console.error(`schema: buf build failed${image.error === undefined ? '' : `: ${image.error.message}`}`);
    return 1;
  }
  const [python, pythonPrefix] = tools.python;
  const generated = spawnSync(python, [...pythonPrefix, join(PROTO, 'tools', 'gen_schema.py'), ...args], {
    cwd: PROTO,
    input: image.stdout,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  if (generated.error !== undefined) {
    console.error(`schema: ${python} could not start: ${generated.error.message}`);
    return 1;
  }
  return generated.status ?? 1;
}

process.exit(main(process.argv.slice(2)));

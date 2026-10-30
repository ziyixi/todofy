import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../../../', import.meta.url);
const read = (file) => readFileSync(new URL(file, root), 'utf8');
const module = read('MODULE.bazel');
const parameter = (call, name) => {
  const body = new RegExp(`${call.replaceAll('.', '\\.')}\\(([^)]+)\\)`, 's').exec(module)?.[1];
  const value = new RegExp(`\\b${name}\\s*=\\s*"([^"]+)"`).exec(body ?? '')?.[1];
  assert.ok(value, `MODULE.bazel must explicitly pin ${call}.${name}`);
  return value;
};

const catalogTypescript = /^\s{2}"typescript":\s*"([^"]+)"/m.exec(read('pnpm-workspace.yaml'))?.[1];
assert.ok(catalogTypescript, 'pnpm catalog must explicitly pin TypeScript');
assert.equal(parameter('typescript.deps', 'version'), catalogTypescript, 'Bazel and pnpm must use the same TypeScript');

const engine = JSON.parse(read('package.json')).engines.node;
const nodeMajor = /^(\d+)\.x$/.exec(engine)?.[1];
assert.ok(nodeMajor, 'package.json must declare the supported Node major');
assert.equal(parameter('node.toolchain', 'node_version').split('.')[0], nodeMajor, 'Bazel must use the supported Node major');

assert.equal(parameter('python.toolchain', 'python_version'), read('.python-version').trim(), 'Bazel must use the existing Python version');

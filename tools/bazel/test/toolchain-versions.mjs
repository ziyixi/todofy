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
const nodeVersion = parameter('node.toolchain', 'node_version');
assert.equal(nodeVersion.split('.')[0], nodeMajor, 'Bazel must use the supported Node major');
assert.equal(read('.node-version').trim(), nodeVersion, 'Actions must install exactly the Node version Bazel tests with');

const tofu = [...module.matchAll(/opentofu\/releases\/download\/v([^/]+)\/tofu_([^_]+)_/g)];
assert.ok(tofu.length > 0, 'MODULE.bazel must pin OpenTofu');
for (const [, release, archive] of tofu) {
  assert.equal(archive, release, 'Each OpenTofu archive must belong to its release');
  assert.equal(read('.opentofu-version').trim(), release, 'Bazel and Actions must use the same OpenTofu');
}

assert.equal(parameter('python.toolchain', 'python_version'), read('.python-version').trim(), 'Bazel must use the existing Python version');

#!/usr/bin/env node
/**
 * Makes the generated code of proto/ current (proto/README.md, How it works). Generated code is never
 * committed; this script produces it, and every way into the repository runs it:
 *
 * - `npm ci` / `npm install` in an app that depends on `@ziyixi/proto` (its `postinstall`),
 * - `uv sync` / `uv run` in a Python app that depends on `ziyixi-proto` (the package's build backend,
 *   proto/python/build_backend.py, runs it whenever uv rebuilds the package),
 * - `npm run generate|test|typecheck` in proto/ and the "Proto checks" CI job.
 *
 * It writes:
 *   proto/ts/<package path>/*_pb.ts                         protobuf-es (buf.gen.yaml)
 *   proto/python/src/ziyixi_proto/<package path>/*_pb.py    tools/gen_py.py
 * and a stamp, proto/.generated.json: a hash of every input (the .proto files, buf.yaml, buf.lock,
 * buf.gen.yaml, package-lock.json, which pins buf, protoc-gen-es and the runtime, this script and
 * gen_py.py) and of every output file (proto/python/build_backend.py checks it the same way). When the stamp matches, it does nothing and needs no network, so
 * repeated installs are fast and work offline. Otherwise it installs the pinned toolchain into
 * proto/node_modules if needed (`npm ci --omit=dev`, the only step that needs network; buf also fetches the
 * locked googleapis module once into its cache), generates into a temporary directory and moves the
 * result in under a lock, so parallel installs cannot interleave.
 *
 * Every directory under proto/ts and proto/python/src/ziyixi_proto is generated (gitignored); every file
 * there is hand-written. A regeneration replaces those directories.
 *
 *   node tools/ensure.mjs                         generate if the stamp does not match
 *   node tools/ensure.mjs --force                 always regenerate
 *   node tools/ensure.mjs --check-deterministic   ensure, then generate twice more into temporary
 *                                                 directories: all three must be byte-identical, and the
 *                                                 stamp's .proto files must be exactly buf's module files
 *
 * Environment: PROTO_PYTHON selects the Python that runs gen_py.py (default python3; the build backend
 * passes its own interpreter).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROTO = dirname(dirname(fileURLToPath(import.meta.url)));
const STAMP = join(PROTO, '.generated.json');
const LOCK = join(PROTO, '.generate.lock');
const BUF = join(PROTO, 'node_modules', '.bin', 'buf');
/** Output roots: every directory directly inside them is generated. */
const TARGETS = { ts: join(PROTO, 'ts'), py: join(PROTO, 'python', 'src', 'ziyixi_proto') };
/** Not part of the buf module (keep equal to buf.yaml `excludes`; --check-deterministic compares). */
const EXCLUDED = new Set(['node_modules', 'python', 'scripts', 'test', 'testdata', 'tools', 'ts']);
const INPUT_FILES = ['buf.yaml', 'buf.lock', 'buf.gen.yaml', 'package-lock.json', 'tools/ensure.mjs', 'tools/gen_py.py'];
/** The toolchain generation needs (package.json "dependencies"); proto's own tests add devDependencies. */
const TOOLCHAIN = ['@bufbuild/buf', '@bufbuild/protoc-gen-es', '@bufbuild/protobuf'];
const STAMP_VERSION = 1;
const LOCK_WAIT_MS = 300_000;
const LOCK_STALE_MS = 600_000;

class EnsureError extends Error {}

function log(message) {
  process.stderr.write(`proto: ${message}\n`);
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function toPosix(path) {
  return path.split(sep).join('/');
}

/** Every .proto file of the module, relative to proto/, sorted. */
function protoFiles(dir = PROTO, top = true) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || (top && EXCLUDED.has(entry.name))) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...protoFiles(path, false));
    else if (entry.name.endsWith('.proto')) found.push(toPosix(relative(PROTO, path)));
  }
  return found.sort();
}

function inputsHash() {
  const hash = createHash('sha256');
  for (const name of [...protoFiles(), ...INPUT_FILES]) {
    hash.update(`${name}\0`).update(readFileSync(join(PROTO, name))).update('\0');
  }
  return hash.digest('hex');
}

/** Generated files under `root` (only inside its directories), relative to proto/, sorted. */
function generatedFiles(root, dir = root) {
  if (!existsSync(dir)) return [];
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__pycache__') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...generatedFiles(root, path));
    else if (dir !== root) found.push(toPosix(relative(PROTO, path)));
  }
  return found.sort();
}

function outputsHashes() {
  const files = [...generatedFiles(TARGETS.ts), ...generatedFiles(TARGETS.py)].sort();
  return Object.fromEntries(files.map((file) => [file, sha256(readFileSync(join(PROTO, file)))]));
}

function readStamp() {
  try {
    return JSON.parse(readFileSync(STAMP, 'utf8'));
  } catch {
    return null;
  }
}

/** True when the stamp matches the inputs and every generated file is present and unchanged. */
function isCurrent() {
  const stamp = readStamp();
  if (stamp?.version !== STAMP_VERSION || stamp.inputs !== inputsHash()) return false;
  const outputs = outputsHashes();
  const expected = stamp.outputs ?? {};
  const names = Object.keys(expected);
  return names.length > 0 && names.length === Object.keys(outputs).length && names.every((n) => outputs[n] === expected[n]);
}

/** The environment of a child process without the calling npm's settings (e.g. --prefix of `npm ci --prefix`). */
function cleanEnv(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^npm_/i.test(key) && key !== 'INIT_CWD') env[key] = value;
  }
  return { ...env, ...extra };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: PROTO, env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'], ...options });
  if (result.error) throw new EnsureError(`${command} could not start: ${result.error.message}`);
  if (result.status !== 0) {
    throw new EnsureError(`${[command, ...args].join(' ')} failed (exit ${String(result.status)}):\n${result.stderr?.toString() ?? ''}${result.stdout?.toString() ?? ''}`);
  }
  return result.stdout;
}

/** Installs the toolchain locked in package-lock.json unless node_modules already has those versions. */
function ensureToolchain() {
  const lock = JSON.parse(readFileSync(join(PROTO, 'package-lock.json'), 'utf8'));
  const installed = TOOLCHAIN.every((name) => {
    const want = lock.packages?.[`node_modules/${name}`]?.version;
    try {
      return want !== undefined && JSON.parse(readFileSync(join(PROTO, 'node_modules', name, 'package.json'), 'utf8')).version === want;
    } catch {
      return false;
    }
  });
  if (installed) return;
  log('installing the pinned toolchain (npm ci --omit=dev in proto/)');
  run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--omit=dev', '--no-audit', '--no-fund']);
}

/** Generates every output into `dir` (fresh): dir/ts and dir/py. */
function generateInto(dir) {
  run(BUF, ['generate', '--output', dir]);
  const image = run(BUF, ['build', '--exclude-imports', '--exclude-source-info', '-o', '-#format=json'], { maxBuffer: 64 << 20 });
  run(process.env.PROTO_PYTHON || 'python3', [join(PROTO, 'tools', 'gen_py.py'), join(dir, 'py')], {
    input: image,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  for (const lang of ['ts', 'py']) {
    const root = join(dir, lang);
    mkdirSync(root, { recursive: true });
    const stray = readdirSync(root).filter((name) => !statSync(join(root, name)).isDirectory());
    if (stray.length > 0) throw new EnsureError(`generated ${lang} files outside a package directory: ${stray.join(', ')}`);
  }
}

/** Replaces the generated directories of each target with the ones in `dir`. */
function install(dir) {
  for (const [lang, target] of Object.entries(TARGETS)) {
    for (const entry of readdirSync(target, { withFileTypes: true })) {
      if (entry.isDirectory()) rmSync(join(target, entry.name), { recursive: true, force: true });
    }
    for (const name of readdirSync(join(dir, lang))) renameSync(join(dir, lang, name), join(target, name));
  }
}

function freshDir() {
  return mkdtempSync(join(PROTO, '.generate-'));
}

function generate() {
  ensureToolchain();
  const dir = freshDir();
  try {
    generateInto(dir);
    install(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // excluded and input_files let proto/python/build_backend.py check this stamp without Node.js (it runs
  // inside Pyodide when pywrangler vendors the package); it hashes exactly as inputsHash() does.
  const stamp = {
    version: STAMP_VERSION,
    excluded: [...EXCLUDED].sort(),
    input_files: INPUT_FILES,
    inputs: inputsHash(),
    outputs: outputsHashes(),
  };
  writeFileSync(`${STAMP}.tmp`, `${JSON.stringify(stamp, null, 2)}\n`);
  renameSync(`${STAMP}.tmp`, STAMP);
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withLock(fn) {
  const start = Date.now();
  for (;;) {
    try {
      mkdirSync(LOCK);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let age = 0;
      try {
        age = Date.now() - statSync(LOCK).mtimeMs;
      } catch {
        continue; // released meanwhile
      }
      if (age > LOCK_STALE_MS) {
        log(`removing a stale lock (${String(Math.round(age / 1000))} s old)`);
        rmSync(LOCK, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - start > LOCK_WAIT_MS) throw new EnsureError(`${LOCK} is held by another generation; remove it if none runs`);
      sleep(200);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(LOCK, { recursive: true, force: true });
  }
}

function listTree(root) {
  const files = {};
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else files[toPosix(relative(root, path))] = sha256(readFileSync(path));
    }
  };
  walk(root);
  return files;
}

function sameTree(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter((key) => a[key] !== b[key]).sort();
}

function checkDeterministic() {
  withLock(() => {
    if (!isCurrent()) generate();
    const moduleFiles = run(BUF, ['ls-files']).toString().split('\n').filter(Boolean).map(toPosix).sort();
    const stamped = protoFiles();
    if (JSON.stringify(moduleFiles) !== JSON.stringify(stamped)) {
      throw new EnsureError(`buf.yaml excludes and EXCLUDED disagree: buf ${JSON.stringify(moduleFiles)}, stamp ${JSON.stringify(stamped)}`);
    }
    const runs = [freshDir(), freshDir()];
    try {
      for (const dir of runs) generateInto(dir);
      const installed = {};
      for (const [lang, target] of Object.entries(TARGETS)) {
        for (const file of generatedFiles(target)) {
          installed[`${lang}/${toPosix(relative(target, join(PROTO, file)))}`] = sha256(readFileSync(join(PROTO, file)));
        }
      }
      const [first, second] = runs.map(listTree);
      const differ = [...sameTree(first, second).map((f) => `run 1 vs run 2: ${f}`), ...sameTree(first, installed).map((f) => `fresh vs installed: ${f}`)];
      if (differ.length > 0) throw new EnsureError(`generation is not deterministic:\n  ${differ.join('\n  ')}`);
      log(`generation is deterministic (${String(Object.keys(first).length)} files, ${String(stamped.length)} .proto)`);
    } finally {
      for (const dir of runs) rmSync(dir, { recursive: true, force: true });
    }
  });
}

function main(args) {
  const force = args.includes('--force');
  if (args.includes('--check-deterministic')) return checkDeterministic();
  if (!force && isCurrent()) return;
  withLock(() => {
    if (!force && isCurrent()) return; // another process generated while this one waited
    log(force ? 'regenerating' : 'generating (inputs changed or output missing)');
    generate();
    log('generated code is current');
  });
}

try {
  main(process.argv.slice(2));
} catch (error) {
  if (!(error instanceof EnsureError)) throw error;
  log(`error: ${error.message}`);
  process.exit(1);
}

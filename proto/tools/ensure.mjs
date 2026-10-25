#!/usr/bin/env node
/**
 * Generates the shared TypeScript/Python wire code from the pinned root pnpm workspace.
 * Root/app lifecycle scripts and the Python build backend call this entrypoint. Generated
 * package directories and proto/.generated.json are never committed.
 *
 * The stamp hashes the IDL, generator inputs, workspace catalog/manifests and root lockfile,
 * plus every generated output. A current toolchain and stamp need no network. Missing tools
 * are restored with a frozen, filtered pnpm install with lifecycle scripts disabled, so this
 * generator cannot recursively enter itself while holding its existing generation lock.
 *
 * Lock ownership, stale-owner recovery and atomic output replacement are shared with the
 * Python backend. PROTO_PYTHON selects its interpreter. Tool commands use Node entrypoints
 * rather than shell shims, including on Windows.
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
import { hostname } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, relative, sep, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROTO = dirname(dirname(fileURLToPath(import.meta.url)));
const ROOT = dirname(PROTO);
const require = createRequire(import.meta.url);
const STAMP = join(PROTO, '.generated.json');
const LOCK = join(PROTO, '.generate.lock');
const OWNER = join(LOCK, 'owner.json');
const TEMP_PREFIX = '.generate-';
/** Output roots: every directory directly inside them is generated. */
const TARGETS = { ts: join(PROTO, 'ts'), py: join(PROTO, 'python', 'src', 'ziyixi_proto') };
/** Not part of the buf module (keep equal to buf.yaml `excludes`; --check-deterministic compares). */
const EXCLUDED = new Set(['node_modules', 'python', 'scripts', 'test', 'testdata', 'tools', 'ts']);
const INPUT_FILES = ['buf.yaml', 'buf.lock', 'buf.gen.yaml', 'package.json', 'ts/package.json', '../package.json', '../pnpm-workspace.yaml', '../pnpm-lock.yaml', '../.python-version', 'tools/ensure.mjs', 'tools/gen_py.py', 'tools/gen_wire_ts.py', 'tools/wire_rules.py'];
const STAMP_VERSION = 1;
/** A lock whose holder cannot be checked (another host, no owner file yet) is abandoned at this age. */
const LOCK_STALE_MS = 600_000;
/** Longer than LOCK_STALE_MS: a waiter always outlives an abandoned lock. */
const LOCK_WAIT_MS = 900_000;
const LOCK_LOG_EVERY_MS = 30_000;

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
    if (entry.name === '__pycache__' || entry.name === 'node_modules') continue;
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

/** Resolve the root-pinned interpreter without invoking a package build or another manager. */
function pythonCommand(env) {
  if (env.PROTO_PYTHON) return env.PROTO_PYTHON;
  const version = readFileSync(join(ROOT, '.python-version'), 'utf8').trim();
  const result = spawnSync('uv', ['--no-cache', 'python', 'find', version], { cwd: ROOT, env: cleanEnv(), encoding: 'utf8' });
  if (result.error || result.status !== 0 || !result.stdout.trim()) {
    throw new EnsureError(`Python ${version} is required: install uv, then run "uv python install" at the repository root before generating proto code`);
  }
  return result.stdout.trim();
}

/** Start pinned pnpm, buf and Python without a shell, including from uv's build backend. */
export function toolCommands({ platform = process.platform, execPath = process.execPath, env = process.env } = {}) {
  const fromManager = env.npm_execpath ?? '';
  let npm = ['npm', []];
  if (/(?:^|[\\/])npm-cli\.js$/.test(fromManager)) npm = [execPath, [fromManager]];
  else if (platform === 'win32') npm = [execPath, [win32.join(win32.dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')]];
  const manager = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).packageManager;
  const pnpm = /(?:^|[\\/])pnpm\.(?:cjs|mjs)$/.test(fromManager)
    ? [execPath, [fromManager]]
    : [npm[0], [...npm[1], 'exec', '--yes', `--package=${manager}`, '--', 'pnpm']];
  return {
    pnpm,
    buf: [execPath, [join(PROTO, 'node_modules', '@bufbuild', 'buf', 'bin', 'buf')]],
    python: [pythonCommand(env), []],
  };
}

/** The toolchain and runtime both declare catalog-pinned packages in the root workspace. */
function toolchainCurrent() {
  try {
    const { load } = require('js-yaml');
    const { catalog } = load(readFileSync(join(ROOT, 'pnpm-workspace.yaml'), 'utf8'));
    return [PROTO, join(PROTO, 'ts')].every((directory) => {
      const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
      const packages = { ...manifest.dependencies, ...manifest.devDependencies };
      return Object.keys(packages).length > 0 && Object.entries(packages).every(([name, spec]) => {
        const expected = spec === 'catalog:' ? catalog[name] : spec;
        const installed = JSON.parse(readFileSync(join(directory, 'node_modules', name, 'package.json'), 'utf8'));
        return installed.version === expected;
      });
    });
  } catch {
    return false;
  }
}

/** Restore only the shared toolchain/runtime, using the one root lock and no install hooks. */
function ensureToolchain() {
  if (toolchainCurrent()) return;
  log('installing the pinned workspace toolchain (pnpm frozen install)');
  const [pnpm, prefix] = toolCommands().pnpm;
  run(pnpm, [...prefix, '--filter', '@ziyixi/proto-toolchain', '--filter', '@ziyixi/proto', 'install', '--frozen-lockfile', '--ignore-scripts'], { cwd: ROOT });
  if (!toolchainCurrent()) throw new EnsureError('pnpm did not install the catalog-pinned toolchain and runtime; run pnpm install --frozen-lockfile at the repository root');
}

function buf(args, options) {
  const [node, prefix] = toolCommands().buf;
  return run(node, [...prefix, ...args], options);
}

/** Generates every output into `dir` (fresh): dir/ts and dir/py. */
function generateInto(dir) {
  buf(['generate', '--output', dir]);
  const image = buf(['build', '--exclude-imports', '--exclude-source-info', '-o', '-#format=json'], { maxBuffer: 64 << 20 });
  const [python, prefix] = toolCommands().python;
  // The Python modules, and the TypeScript wire JSON types next to protobuf-es's output (same image).
  for (const [generator, out] of [
    ['gen_py.py', 'py'],
    ['gen_wire_ts.py', 'ts'],
  ]) {
    run(python, [...prefix, join(PROTO, 'tools', generator), join(dir, out)], { input: image, stdio: ['pipe', 'pipe', 'pipe'] });
  }
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
      if (entry.isDirectory() && entry.name !== 'node_modules') rmSync(join(target, entry.name), { recursive: true, force: true });
    }
    for (const name of readdirSync(join(dir, lang))) renameSync(join(dir, lang, name), join(target, name));
  }
}

function freshDir() {
  return mkdtempSync(join(PROTO, TEMP_PREFIX));
}

function generate() {
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

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM'; // it runs, as another user
  }
}

/** The raw owner file of the lock directory `dir` ('' when it has none yet, null when `dir` is gone). */
function readOwner(dir) {
  try {
    return readFileSync(join(dir, 'owner.json'), 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return existsSync(dir) ? '' : null;
  }
}

/** Why the lock (owner file `raw`) is abandoned, or null while its holder may still run. */
function abandonedBecause(raw) {
  let age;
  try {
    age = Date.now() - statSync(LOCK).mtimeMs;
  } catch {
    return null; // released meanwhile
  }
  let owner = null;
  try {
    owner = JSON.parse(raw);
  } catch {
    // no owner file yet (written right after mkdir) or one from an older ensure.mjs: only the age tells
  }
  if (owner?.host === hostname() && Number.isInteger(owner.pid) && !isRunning(owner.pid)) {
    return `its holder, pid ${String(owner.pid)}, no longer runs`;
  }
  return age > LOCK_STALE_MS ? `it is ${String(Math.round(age / 1000))} s old` : null;
}

/**
 * Removes the lock only if it still has the owner file `raw` that was judged abandoned: it is moved aside
 * first (atomic), and moved back if another run took the lock in between.
 */
function removeAbandoned(raw) {
  const aside = `${LOCK}.abandoned-${String(process.pid)}`;
  try {
    renameSync(LOCK, aside);
  } catch {
    return; // released or taken over meanwhile
  }
  if (readOwner(aside) !== raw) {
    try {
      renameSync(aside, LOCK);
    } catch {
      // the new holder's lock is lost; its generation still completes, the stamp still checks it
    }
    return;
  }
  rmSync(aside, { recursive: true, force: true });
}

function describeHolder(raw) {
  try {
    const owner = JSON.parse(raw);
    return `pid ${String(owner.pid)} on ${String(owner.host)}`;
  } catch {
    return 'an unknown run';
  }
}

/** Runs fn holding proto/.generate.lock (see the top of this file). */
function withLock(fn) {
  const token = JSON.stringify({ pid: process.pid, host: hostname(), started: new Date().toISOString() });
  const start = Date.now();
  let lastLog = 0;
  for (;;) {
    try {
      mkdirSync(LOCK);
      writeFileSync(`${OWNER}.tmp`, token);
      renameSync(`${OWNER}.tmp`, OWNER);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const raw = readOwner(LOCK);
    if (raw === null) continue; // released meanwhile
    const reason = abandonedBecause(raw);
    if (reason !== null) {
      log(`taking over ${LOCK}: ${reason}`);
      removeAbandoned(raw);
      continue;
    }
    const waited = Date.now() - start;
    if (waited > LOCK_WAIT_MS) {
      throw new EnsureError(`${LOCK} is still held by ${describeHolder(raw)}; remove it if that generation no longer runs`);
    }
    if (waited - lastLog >= LOCK_LOG_EVERY_MS || lastLog === 0) {
      log(`waiting for ${LOCK}, held by ${describeHolder(raw)}`);
      lastLog = Math.max(waited, 1);
    }
    sleep(200);
  }
  try {
    // Temporary directories are only made under the lock: any left now belong to a run that died.
    for (const name of readdirSync(PROTO)) {
      if (name.startsWith(TEMP_PREFIX)) rmSync(join(PROTO, name), { recursive: true, force: true });
    }
    return fn();
  } finally {
    // Only our own lock: if it was taken over as abandoned, it belongs to another run now.
    if (readOwner(LOCK) === token) rmSync(LOCK, { recursive: true, force: true });
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
    ensureToolchain();
    if (!isCurrent()) generate();
    const moduleFiles = buf(['ls-files']).toString().split('\n').filter(Boolean).map(toPosix).sort();
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
  if (!force && toolchainCurrent() && isCurrent()) return;
  withLock(() => {
    ensureToolchain();
    if (!force && isCurrent()) return; // only the toolchain was missing, or another run generated meanwhile
    log(force ? 'regenerating' : 'generating (inputs changed or output missing)');
    generate();
    log('generated code is current');
  });
}

// Run as a script (`node tools/ensure.mjs`); the tests import toolCommands() without running it.
if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof EnsureError)) throw error;
    log(`error: ${error.message}`);
    process.exit(1);
  }
}

#!/usr/bin/env node
/** Materialize the canonical Bazel proto outputs for raw pnpm/uv consumers. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
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
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROTO = dirname(dirname(fileURLToPath(import.meta.url)));
const ROOT = dirname(PROTO);
const STAMP = join(PROTO, '.generated.json');
const LOCK = join(PROTO, '.generate.lock');
const OWNER = join(LOCK, 'owner.json');
const TEMP_PREFIX = '.generate-';
const TARGETS = {
  ts: join(PROTO, 'ts'),
  py: join(PROTO, 'python/src/ziyixi_proto'),
};
const LOCK_STALE_MS = 600_000;
const LOCK_WAIT_MS = 900_000;
const LOCK_LOG_EVERY_MS = 30_000;
class EnsureError extends Error {}
function log(message) {
  process.stderr.write(`proto: ${message}\n`);
}

function bazel(args, capture = false) {
  const command = process.env.BAZEL || 'bazel';
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : ['ignore', 'inherit', 'inherit'],
  });
  if (result.error)
    throw new EnsureError(
      `Bazel 9.3.1 could not start (${result.error.message}); install it on PATH or set BAZEL to its executable`,
    );
  if (result.status !== 0) throw new EnsureError(`Bazel proto materialization failed (exit ${String(result.status)})`);
  return result.stdout?.trim();
}

function sourceFile(tree, name) {
  if (name.startsWith('ts/')) return join(tree, name);
  const prefix = 'python/src/ziyixi_proto/';
  if (name.startsWith(prefix)) return join(tree, 'py', name.slice(prefix.length));
  throw new EnsureError(`Unexpected generated output: ${name}`);
}

function makeWritable(root) {
  chmodSync(root, 0o755);
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    chmodSync(join(entry.parentPath, entry.name), entry.isDirectory() ? 0o755 : 0o644);
  }
}

function install(tree) {
  const manifest = JSON.parse(readFileSync(join(tree, 'manifest.json'), 'utf8'));
  if (manifest.version !== 2 || !Object.keys(manifest.outputs ?? {}).length)
    throw new EnsureError('Invalid Bazel materialization manifest');
  const stage = mkdtempSync(join(PROTO, TEMP_PREFIX));
  try {
    for (const language of ['ts', 'py']) {
      const destination = join(stage, language);
      cpSync(join(tree, language), destination, { recursive: true });
      // Bazel output trees are read-only; raw workspace copies must permit replacement and cleanup.
      makeWritable(destination);
    }
    for (const [name, expected] of Object.entries(manifest.outputs)) {
      const data = readFileSync(sourceFile(stage, name));
      if (createHash('sha256').update(data).digest('hex') !== expected)
        throw new EnsureError(`Bazel output does not match its manifest: ${name}`);
    }
    for (const [language, destination] of Object.entries(TARGETS)) {
      mkdirSync(destination, { recursive: true });
      for (const entry of readdirSync(destination, { withFileTypes: true })) {
        if (entry.isDirectory() && !['node_modules', '__pycache__'].includes(entry.name))
          rmSync(join(destination, entry.name), {
            recursive: true,
            force: true,
          });
      }
      for (const entry of readdirSync(join(stage, language)))
        renameSync(join(stage, language, entry), join(destination, entry));
    }
    writeFileSync(`${STAMP}.tmp`, `${JSON.stringify(manifest, null, 2)}\n`);
    renameSync(`${STAMP}.tmp`, STAMP);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
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
  const token = JSON.stringify({
    pid: process.pid,
    host: hostname(),
    started: new Date().toISOString(),
  });
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
      throw new EnsureError(
        `${LOCK} is still held by ${describeHolder(raw)}; remove it if that generation no longer runs`,
      );
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
      if (name.startsWith(TEMP_PREFIX)) {
        makeWritable(join(PROTO, name));
        rmSync(join(PROTO, name), { recursive: true, force: true });
      }
    }
    return fn();
  } finally {
    // Only our own lock: if it was taken over as abandoned, it belongs to another run now.
    if (readOwner(LOCK) === token) rmSync(LOCK, { recursive: true, force: true });
  }
}

export function materialize() {
  return withLock(() => {
    bazel(['build', '//proto:materialized']);
    const bin = bazel(['info', 'bazel-bin'], true);
    install(join(bin, 'proto/materialized'));
    log('Bazel-generated modules are materialized');
  });
}

if (import.meta.main) {
  try {
    if (process.argv.length !== 2) throw new EnsureError('usage: node proto/tools/ensure.mjs');
    materialize();
  } catch (error) {
    log(error.message);
    process.exitCode = 1;
  }
}

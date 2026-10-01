/**
 * tools/ensure.mjs, the one way generated code is made (README.md, How it works), run as a child process on
 * a copy of proto/ in a temporary directory: it restores a missing toolchain even when the generated code
 * is current, survives a lock left by a run that died, says whom it waits for, and starts every tool
 * without a shell (what Windows needs).
 */
import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';

const PROTO = dirname(import.meta.dirname);
const PROTO_FILE = 'todofy/taskintent/v1/task_intent.proto';
/** Installed, generated or left by a run (every directory inside the two package roots is generated). */
function copied(source: string): boolean {
  const path = relative(PROTO, source).split(sep).join('/');
  if (/^(node_modules|\.generate)/.test(path)) return false;
  return !(/^(ts|python\/src\/ziyixi_proto)\/[^/]+$/.test(path) && statSync(source).isDirectory());
}

type ToolCommands = Record<'npm' | 'buf' | 'python', [string, string[]]>;
interface EnsureModule {
  toolCommands(options?: { platform?: string; execPath?: string; env?: Record<string, string> }): ToolCommands;
}

const copies: string[] = [];

afterEach(() => {
  for (const dir of copies.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A copy of proto/ without generated code; its node_modules links to the real one unless `ownModules`. */
function copyProto({ ownModules = false } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'proto-ensure-'));
  copies.push(root);
  const copy = join(root, 'proto');
  cpSync(PROTO, copy, { recursive: true, filter: copied });
  if (!ownModules) symlinkSync(join(PROTO, 'node_modules'), join(copy, 'node_modules'), 'junction');
  return copy;
}

function ensure(copy: string, ...args: string[]): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [join(copy, 'tools', 'ensure.mjs'), ...args], {
    cwd: copy,
    encoding: 'utf8',
    timeout: 60_000,
  });
}

function expectOk(result: SpawnSyncReturns<string>): void {
  expect(result.status, result.stderr).toBe(0);
}

/** A pid that no longer runs: a child that already exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', '']);
  expect(child.status).toBe(0);
  return child.pid;
}

function holdLock(copy: string, owner: object | null, ageMs = 0): string {
  const lock = join(copy, '.generate.lock');
  mkdirSync(lock);
  if (owner !== null) writeFileSync(join(lock, 'owner.json'), JSON.stringify(owner));
  const when = new Date(Date.now() - ageMs);
  utimesSync(lock, when, when);
  return lock;
}

function touchProto(copy: string): void {
  appendFileSync(join(copy, PROTO_FILE), '\n// changed by ensure.test.ts\n');
}

describe('the copy', () => {
  test('excludes the generated code and keeps the hand-written files', () => {
    const copy = copyProto();
    expect(existsSync(join(copy, 'ts', 'wire-json.ts'))).toBe(true);
    expect(existsSync(join(copy, 'python', 'src', 'ziyixi_proto', 'wire_json.py'))).toBe(true);
    expect(existsSync(join(copy, 'ts', 'todofy'))).toBe(false);
    expect(existsSync(join(copy, 'python', 'src', 'ziyixi_proto', 'todofy'))).toBe(false);
    expect(existsSync(join(copy, '.generated.json'))).toBe(false);
  });
});

describe('the toolchain', () => {
  test(
    'is restored when proto/node_modules is gone although the generated code is current, with every devDependency',
    () => {
      const copy = copyProto();
      expectOk(ensure(copy));
      unlinkSync(join(copy, 'node_modules')); // a monorepo-wide node_modules cleanup
      const restored = ensure(copy);
      expectOk(restored);
      expect(restored.stderr).toContain('installing the pinned toolchain');
      const lock = JSON.parse(readFileSync(join(copy, 'package-lock.json'), 'utf8')) as {
        packages: Record<string, { version?: string; dependencies?: object; devDependencies?: object }>;
      };
      const root = lock.packages[''];
      for (const name of Object.keys({ ...root?.dependencies, ...root?.devDependencies })) {
        const installed = JSON.parse(readFileSync(join(copy, 'node_modules', name, 'package.json'), 'utf8')) as {
          version: string;
        };
        expect(installed.version, name).toBe(lock.packages[`node_modules/${name}`]?.version);
      }
      // Current again: nothing to do, nothing said.
      const again = ensure(copy);
      expectOk(again);
      expect(again.stderr).toBe('');
    },
    180_000,
  );
});

describe('the lock', () => {
  test('held by a pid that no longer runs here is taken over at once, with the dead run\'s temporary files', () => {
    const copy = copyProto();
    expectOk(ensure(copy));
    touchProto(copy);
    holdLock(copy, { pid: deadPid(), host: hostname(), started: new Date().toISOString() });
    mkdirSync(join(copy, '.generate-abandoned'));
    const started = Date.now();
    const result = ensure(copy);
    expectOk(result);
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(result.stderr).toMatch(/taking over .*no longer runs/);
    expect(result.stderr).toContain('generated code is current');
    expect(existsSync(join(copy, '.generate.lock'))).toBe(false);
    expect(existsSync(join(copy, '.generate-abandoned'))).toBe(false);
  });

  test('that cannot be checked is waited for, naming its holder', async () => {
    const copy = copyProto();
    expectOk(ensure(copy));
    touchProto(copy);
    holdLock(copy, { pid: 1, host: 'another-host', started: new Date().toISOString() });
    const child = spawn(process.execPath, [join(copy, 'tools', 'ensure.mjs')], { cwd: copy });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const exited = new Promise<number | null>((done) => child.on('exit', done));
    for (let waited = 0; !stderr.includes('waiting for') && waited < 20_000; waited += 100) {
      await new Promise((done) => setTimeout(done, 100));
    }
    child.kill('SIGKILL');
    await exited;
    expect(stderr).toContain('held by pid 1 on another-host');
    expect(stderr).not.toContain('generated code is current');
  });

  test('that cannot be checked is taken over once it is old enough', () => {
    const copy = copyProto();
    expectOk(ensure(copy));
    touchProto(copy);
    holdLock(copy, null, 11 * 60_000); // no owner file: an older ensure.mjs, or one killed right after mkdir
    const result = ensure(copy);
    expectOk(result);
    expect(result.stderr).toMatch(/taking over .*s old/);
  });

  test('is released when generation fails, and a later run succeeds', () => {
    const copy = copyProto();
    const proto = join(copy, PROTO_FILE);
    const good = readFileSync(proto, 'utf8');
    writeFileSync(proto, `${good}\nmessage {`);
    const failed = ensure(copy);
    expect(failed.status).toBe(1);
    expect(existsSync(join(copy, '.generate.lock'))).toBe(false);
    writeFileSync(proto, good);
    expectOk(ensure(copy));
  });
});

describe('tool commands', () => {
  async function load(): Promise<EnsureModule> {
    // Imported, not run: ensure.mjs runs main() only as a script (import.meta.main).
    const url = pathToFileURL(join(PROTO, 'tools', 'ensure.mjs')).href;
    return (await import(url)) as EnsureModule;
  }

  test('start no .cmd file, shim or shell on Windows', async () => {
    const { toolCommands } = await load();
    const commands = toolCommands({ platform: 'win32', execPath: 'C:\\nodejs\\node.exe', env: {} });
    expect(commands.npm).toEqual(['C:\\nodejs\\node.exe', ['C:\\nodejs\\node_modules\\npm\\bin\\npm-cli.js']]);
    expect(commands.buf[0]).toBe('C:\\nodejs\\node.exe');
    expect(commands.buf[1]).toEqual([join(PROTO, 'node_modules', '@bufbuild', 'buf', 'bin', 'buf')]);
    expect(commands.python).toEqual(['python', []]);
    for (const [command, args] of Object.values(commands)) {
      for (const part of [command, ...args]) {
        expect(part).not.toMatch(/\.(cmd|bat)$/i);
        expect(part).not.toMatch(/[\\/]\.bin[\\/]/);
      }
    }
  });

  test('find npm and buf on this machine as uv\'s build runs them (no npm_execpath)', async () => {
    const { toolCommands } = await load();
    const commands = toolCommands({ env: {} });
    const npm = spawnSync(commands.npm[0], [...commands.npm[1], '--version'], { encoding: 'utf8' });
    expect(npm.status, npm.stderr).toBe(0);
    expect(npm.stdout).toMatch(/^\d+\.\d+\.\d+/);
    expect(commands.buf[0]).toBe(process.execPath);
    expect(existsSync(commands.buf[1][0] ?? '')).toBe(true);
    expect(commands.python).toEqual([process.platform === 'win32' ? 'python' : 'python3', []]);
  });

  test('prefer the npm that runs the install and the given Python', async () => {
    const { toolCommands } = await load();
    const commands = toolCommands({
      platform: 'linux',
      execPath: '/opt/node/bin/node',
      env: { npm_execpath: '/elsewhere/npm/bin/npm-cli.js', PROTO_PYTHON: '/venv/bin/python' },
    });
    expect(commands.npm).toEqual(['/opt/node/bin/node', ['/elsewhere/npm/bin/npm-cli.js']]);
    expect(commands.python).toEqual(['/venv/bin/python', []]);
  });

  test('buf.gen.yaml starts each plugin on node, never through a node_modules/.bin shim', () => {
    const config = readFileSync(join(PROTO, 'buf.gen.yaml'), 'utf8');
    const locals = [...config.matchAll(/^\s*- local: (.+)$/gm)].map((match) => match[1] ?? '');
    expect(locals.length).toBeGreaterThan(0);
    for (const local of locals) expect(local).toMatch(/^\[node, node_modules\/[^\]]+\]$/);
  });
});

// npm run install-extension [-- <build folder or zip>] [--target <folder>]
//
// Installs a build into the stable folder Chrome loads the unpacked extension from (../../docs/design.md §3.10), by
// default ~/recall-extension, outside Google Drive (a cloud-only placeholder file would fail to load). Without a
// source it installs this package's own build (dist/extension, `npm run build`); a source is a build folder, the
// build's zip or the CI artifact recall-extension-<sha>.zip as downloaded.
//
// It never replaces files under the running extension: it unpacks into the sibling <target>.next, checks it (the
// files, a valid version, the committed key, so the extension's ID and its IndexedDB stay the same), swaps it in with
// two renames (the old folder becomes <target>.prev) and writes the file BUILD, holding the version, last. The running
// extension reads BUILD and manifest.json on its next tick and reloads when both name the same new version.
//
// Plain Node, no dependency, so it runs on a downloaded artifact before any `npm ci`.
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXTENSION_ID, extensionIdOf, isChromeVersion, readTemplate } from './manifest.mjs';
import { readZip } from './zip.mjs';

export const DEFAULT_TARGET = join(homedir(), 'recall-extension');
const OWN_BUILD = join(dirname(dirname(fileURLToPath(import.meta.url))), 'dist', 'extension');
/** The files every build has. */
export const BUILD_FILES = ['manifest.json', 'sw.js', 'capture.js', 'options.html', 'options.js', 'options.css'];

/** `{ manifest }` when a folder is a build this script installs, else `{ error }` saying why not. */
export function checkBuild(folder) {
  for (const name of BUILD_FILES) {
    if (!existsSync(join(folder, name))) return { error: `the build has no ${name}` };
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8'));
  } catch {
    return { error: 'the build\'s manifest.json does not parse' };
  }
  if (typeof manifest.version !== 'string' || !isChromeVersion(manifest.version)) return { error: 'the build\'s version is not a Chrome version' };
  if (manifest.key !== readTemplate().key || extensionIdOf(manifest.key) !== EXTENSION_ID) {
    return { error: 'the build has another key: Chrome would give it another ID and a new, empty outbox' };
  }
  return { manifest };
}

/** Writes a file whole or not at all (a temporary file, then a rename). */
function writeAtomic(path, text) {
  writeFileSync(`${path}.tmp`, text);
  renameSync(`${path}.tmp`, path);
}

/** Unpacks a build folder or zip into `folder`; a zip may hold the files at its root or in one folder. */
function unpack(source, folder) {
  mkdirSync(folder, { recursive: true });
  if (statSync(source).isDirectory()) {
    cpSync(source, folder, { recursive: true });
    return;
  }
  const files = readZip(readFileSync(source));
  const tops = new Set(files.map((file) => file.name.split('/')[0]));
  const prefix = !files.some((file) => file.name === 'manifest.json') && tops.size === 1 ? `${[...tops][0]}/` : '';
  for (const { name, data } of files) {
    const path = join(folder, name.slice(prefix.length));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, data);
  }
}

/** Installs `source` into `target`; returns the installed version. */
export function installExtension(source, target) {
  const folder = resolve(target);
  if (/[/\\](Google ?Drive|CloudStorage)[/\\]/i.test(`${folder}/`)) {
    throw new Error(`${folder} is in a synced folder: a cloud-only file there would fail to load; pick a folder such as ~/recall-extension`);
  }
  if (!existsSync(source)) throw new Error(`no build at ${source}: run \`npm run build\` first, or pass a build folder or zip`);
  const next = `${folder}.next`;
  const previous = `${folder}.prev`;
  rmSync(next, { recursive: true, force: true });
  unpack(source, next);
  // BUILD is written last, into the swapped-in folder: one that came with the build would announce it too early.
  rmSync(join(next, 'BUILD'), { force: true });
  const checked = checkBuild(next);
  if (checked.error !== undefined) {
    rmSync(next, { recursive: true, force: true });
    throw new Error(checked.error);
  }
  rmSync(previous, { recursive: true, force: true });
  if (existsSync(folder)) renameSync(folder, previous);
  renameSync(next, folder);
  writeAtomic(join(folder, 'BUILD'), `${checked.manifest.version}\n`);
  return checked.manifest.version;
}

function main(args) {
  let target = DEFAULT_TARGET;
  let source = OWN_BUILD;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--target') target = args[++i] ?? '';
    else source = resolve(args[i]);
  }
  const firstInstall = !existsSync(target);
  const version = installExtension(source, target);
  console.log(`recall extension ${version} installed in ${target}`);
  if (firstInstall) {
    console.log('First install: open chrome://extensions, turn on Developer mode, Load unpacked (⌘⇧G and the folder above),');
    console.log('then open the extension\'s options, paste the ingest token and set the device label.');
  } else {
    console.log('The running extension reloads into it within a minute (or at once from its options: 检查更新).');
  }
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`install-extension: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

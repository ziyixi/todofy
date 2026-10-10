// npm run build: the extension into dist/extension/ (what Chrome loads) and dist/recall-extension-<commit>.zip (the same
// files, for the CI artifact and for `npm run install-extension`). ../../docs/design.md §3.1, §3.10.
//
// - sw.js and options.js: esbuild bundles of src/sw.ts and src/options.ts (ES modules, Chrome 120, no dependency);
// - capture.js: src/capture-script.ts as a script whose last statement is its result, which is what
//   scripting.executeScript answers;
// - options.html, options.css, the icons, shared/NOTICE and manifest.json with the version of the build time (UTC) and
//   the short commit as its version name.
//
// The build is not minified (an unpacked extension is read from disk; its code stays readable in DevTools) and holds
// nothing personal: recall's host is a public constant and the token is pasted in the options later. BUILD is not part
// of it: install.mjs writes that file last, after the swap. Environment: RECALL_BUILD_TIME (an ISO time, default now)
// and RECALL_COMMIT (default GITHUB_SHA, then `git rev-parse HEAD`).
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { ICON_SIZES, iconPng } from './icons.mjs';
import { buildManifest, isChromeVersion, readTemplate, versionOf } from './manifest.mjs';
import { writeZip } from './zip.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const DIST = join(ROOT, 'dist');

/** The commit being built: RECALL_COMMIT, GITHUB_SHA, or the checkout's HEAD. */
function currentCommit() {
  const commit = process.env.RECALL_COMMIT || process.env.GITHUB_SHA || '';
  if (commit !== '') return commit;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return 'dev';
  }
}

/** Every file under a folder, as paths relative to it with `/`, sorted. */
function filesUnder(folder) {
  return readdirSync(folder, { recursive: true })
    .map((name) => String(name))
    .filter((name) => statSync(join(folder, name)).isFile())
    .map((name) => name.split('\\').join('/'))
    .sort();
}

/**
 * Builds the extension into `<dist>/extension` and `<dist>/recall-extension-<short commit>.zip` (`dist` is emptied
 * first); returns the version, the short commit and both paths.
 */
export async function buildExtension({ dist = DIST, time = new Date(), commit = currentCommit() } = {}) {
  if (Number.isNaN(time.getTime())) throw new Error('the build time is not a time');
  const short = commit.slice(0, 7);
  const version = versionOf(time);
  if (!isChromeVersion(version)) throw new Error(`not a Chrome version: ${version}`);
  const out = join(dist, 'extension');
  // dist/ holds one build: its folder and its zip.
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(join(out, 'icons'), { recursive: true });

  const common = {
    bundle: true,
    target: 'chrome120',
    platform: 'browser',
    legalComments: 'none',
    logLevel: 'warning',
    define: { RECALL_BUILD: JSON.stringify(version) },
  };
  await build({ ...common, entryPoints: { sw: join(ROOT, 'src/sw.ts'), options: join(ROOT, 'src/options.ts') }, format: 'esm', outdir: out });
  await build({
    ...common,
    entryPoints: { capture: join(ROOT, 'src/capture-script.ts') },
    format: 'iife',
    globalName: 'recallCapture',
    footer: { js: 'recallCapture.result;' },
    outdir: out,
  });

  for (const name of ['options.html', 'options.css']) copyFileSync(join(ROOT, 'src', name), join(out, name));
  copyFileSync(join(ROOT, '..', 'shared', 'NOTICE'), join(out, 'NOTICE'));
  for (const size of ICON_SIZES) writeFileSync(join(out, 'icons', `${String(size)}.png`), iconPng(size));
  writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(buildManifest(readTemplate(), { version, versionName: short }), null, 2)}\n`);

  const zip = join(dist, `recall-extension-${short}.zip`);
  writeFileSync(zip, writeZip(filesUnder(out).map((name) => ({ name, data: readFileSync(join(out, name)) }))));
  return { version, commit: short, folder: out, zip };
}

if (import.meta.main) {
  const time = process.env.RECALL_BUILD_TIME ? new Date(process.env.RECALL_BUILD_TIME) : new Date();
  const built = await buildExtension({ time });
  console.log(`recall extension ${built.version} (${built.commit}): ${relative(process.cwd(), built.folder)}/ and ${relative(process.cwd(), built.zip)}`);
}

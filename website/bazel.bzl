"""Website browser checks on the declared empty and synthetic fixture exports."""

load("@aspect_rules_js//js:defs.bzl", "js_binary", "js_test")
load("//tools/bazel:js.bzl", "copied_source_files")
load("//tools/bazel/audit:sources.bzl", "SOURCE_SUBPACKAGE_AUDIT_EXCLUDES")

def _browser_setup_impl(ctx):
    browser = ctx.toolchains["//tools/bazel/browser:toolchain_type"].browser
    directory = "out" if ctx.attr.mode == "empty" else "fixture_site"
    outputs = [file for file in ctx.attr.site[DefaultInfo].files.to_list() if file.is_directory and file.basename == directory]
    if len(outputs) != 1:
        fail("Expected one %s static export" % directory)
    bootstrap = ctx.actions.declare_file(ctx.label.name + "_bootstrap.mjs")
    config = ctx.actions.declare_file(ctx.label.name + "_config.mjs")
    registry_root = browser.executable.short_path.rsplit("/", 3)[0]
    manifest_path = "website/fixture_manifest.json" if ctx.attr.mode == "fixture" else "website/.generated/content/manifest.json"
    ctx.actions.write(bootstrap, """import { realpathSync } from 'node:fs';
import { cp, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
const require = createRequire(import.meta.url);
if (require('@playwright/test/package.json').version !== %s) throw new Error('Update pinned browser and Playwright together');
const root = resolve(process.env.TEST_SRCDIR, process.env.TEST_WORKSPACE);
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(root, %s);
process.env.CONTENT_MODE = %s;
const reservation = createServer();
await new Promise(done => reservation.listen(0, '127.0.0.1', done));
const port = reservation.address().port;
await new Promise(done => reservation.close(done));
process.env.WEBSITE_TEST_PORT = String(port);
if (%s) {
  process.env.DEPLOYMENT_TEST_REQUIRED = '1';
  process.env.DEPLOYMENT_BASE_URL = 'http://127.0.0.1:' + port;
  process.env.EXPECTED_BUILD_INFO_PATH = resolve(root, %s, 'build-info.json');
  process.env.ALLOW_FIXTURE_DEPLOYMENT_TESTS = 'true';
  if (process.env.CONTENT_MODE === 'fixture') {
    await mkdir('.generated/content', { recursive: true });
    await cp(resolve(root, %s), '.generated/content/manifest.json');
  }
}
const spec = process.argv.indexOf(%s);
if (spec < 0) throw new Error('Missing declared spec');
process.argv[spec] = realpathSync(process.argv[spec]);
await import('@playwright/test/cli');
""" % (
        json.encode(browser.playwright_version),
        json.encode(registry_root),
        json.encode(ctx.attr.mode),
        "true" if ctx.attr.spec.endswith("deployment.spec.ts") else "false",
        json.encode(outputs[0].short_path),
        json.encode(manifest_path),
        json.encode(ctx.attr.spec),
    ))
    ctx.actions.write(config, """import original from '../../playwright.config.ts';
import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
const root = resolve(process.env.TEST_SRCDIR, process.env.TEST_WORKSPACE);
const assets = resolve(root, %s);
const wrangler = resolve(root, %s);
const config = resolve(root, 'website/wrangler.toml');
const port = process.env.WEBSITE_TEST_PORT;
const origin = 'http://127.0.0.1:' + port;
export default {
  ...original,
  testDir: resolve(dirname(realpathSync('playwright.config.ts')), original.testDir),
  outputDir: resolve(process.env.TEST_UNDECLARED_OUTPUTS_DIR, 'playwright'),
  use: { ...original.use, baseURL: origin },
  webServer: {
    ...original.webServer,
    cwd: original.webServer?.cwd ?? process.cwd(),
    command: [wrangler, 'dev', '--config', config, '--assets', assets, '--ip', '127.0.0.1', '--port', port].map(JSON.stringify).join(' '),
    url: origin,
    timeout: 120000,
    reuseExistingServer: false,
  },
};
""" % (json.encode(outputs[0].short_path), json.encode(ctx.executable.wrangler.short_path)))
    return [DefaultInfo(
        files = depset([bootstrap]),
        runfiles = ctx.runfiles(files = [bootstrap, config], transitive_files = browser.files),
    )]

_browser_setup = rule(
    implementation = _browser_setup_impl,
    attrs = {
        "site": attr.label(mandatory = True),
        "mode": attr.string(mandatory = True, values = ["empty", "fixture"]),
        "spec": attr.string(mandatory = True),
        "wrangler": attr.label(mandatory = True, executable = True, cfg = "target"),
    },
    toolchains = ["//tools/bazel/browser:toolchain_type"],
)

def website_browser_test(name, spec, mode, site):
    spec_path = "tests/e2e/" + spec.removeprefix(":")
    _browser_setup(name = name + "_setup", site = site, mode = mode, spec = spec_path, wrangler = "//website/relay:wrangler")
    js_test(
        name = name,
        entry_point = ":" + name + "_setup",
        args = ["test", spec_path, "--config", "tests/e2e/" + name + "_setup_config.mjs"],
        chdir = "website",
        data = [site, "//website/content:browser_inputs", "//website/relay:wrangler", "//website:node_modules/@playwright/test", "//website:node_modules/@axe-core/playwright", spec, "//website:playwright_config", "//website:public_config", "//website:typescript_config", ":" + name + "_setup"] + (["//website:prepare_empty"] if mode == "empty" else []) + (["//website/src/lib/content:publication-state", "//website/content:site_config", "//website/tests/support:deployment_contract"] if spec_path.endswith("deployment.spec.ts") else []),
        env = {"CI": "true", "WRANGLER_SEND_METRICS": "false"},
        patch_node_fs = False,
        size = "large",
        tags = ["browser", "exclusive"],
    )

def _deployment_verifier_impl(ctx):
    browser = ctx.toolchains["//tools/bazel/browser:toolchain_type"].browser
    bootstrap = ctx.actions.declare_file(ctx.label.name + ".mjs")
    config = ctx.actions.declare_file(ctx.label.name + "_config.mjs")
    registry = browser.executable.short_path.rsplit("/", 3)[0]
    ctx.actions.write(bootstrap, """import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
const require = createRequire(import.meta.url);
if (!process.env.DEPLOYMENT_BASE_URL) throw new Error('DEPLOYMENT_BASE_URL is required for live verification');
if (require('@playwright/test/package.json').version !== %s) throw new Error('Update pinned Chromium and Playwright together');
const root = resolve(process.env.JS_BINARY__RUNFILES, %s);
const operator = process.env.BUILD_WORKING_DIRECTORY ?? process.cwd();
for (const name of ['EXPECTED_BUILD_INFO_PATH', 'DEPLOYMENT_CONTRACT_PATH']) {
  if (process.env[name]) process.env[name] = resolve(operator, process.env[name]);
}
process.env.DEPLOYMENT_TEST_REQUIRED = '1';
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(root, %s);
process.env.WEBSITE_VERIFIER_DIRECTORY = operator;
const spec = process.argv.indexOf('tests/e2e/deployment.spec.ts');
process.argv[spec] = realpathSync(resolve(root, 'website/tests/e2e/deployment.spec.ts'));
const config = process.argv.indexOf('--config');
process.argv[config + 1] = resolve(root, 'website/' + process.argv[config + 1]);
process.chdir(operator);
await import('@playwright/test/cli');
""" % (json.encode(browser.playwright_version), json.encode(ctx.workspace_name), json.encode(registry)))
    ctx.actions.write(config, """import original from '../../playwright.config.ts';
import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
const operator = process.env.WEBSITE_VERIFIER_DIRECTORY;
export default {
  ...original,
  testDir: resolve(dirname(realpathSync(new URL('../../playwright.config.ts', import.meta.url))), original.testDir),
  outputDir: resolve(operator, 'test-results'),
  reporter: Array.isArray(original.reporter) ? original.reporter.map(([name, options]) => name === 'html' ? [name, { ...options, outputFolder: resolve(operator, 'playwright-report') }] : [name, options]) : original.reporter,
};
""")
    return [DefaultInfo(files = depset([bootstrap]), runfiles = ctx.runfiles(files = [bootstrap, config], transitive_files = browser.files))]

_deployment_verifier = rule(implementation = _deployment_verifier_impl, toolchains = ["//tools/bazel/browser:toolchain_type"])

def website_deployment_verifier(name):
    _deployment_verifier(name = name + "_setup")
    js_binary(
        name = name,
        entry_point = ":" + name + "_setup",
        args = ["test", "tests/e2e/deployment.spec.ts", "--project", "desktop-chromium", "--config", "tests/e2e/" + name + "_setup_config.mjs"],
        data = ["//website:node_modules/@playwright/test", "//website/src/lib/content:publication-state", "//website/content:site_config", ":deployment.spec.ts", "//website/tests/support:deployment_contract", "//website:playwright_config", "//website:typescript_config", ":" + name + "_setup"],
        patch_node_fs = False,
        visibility = ["//visibility:public"],
    )

def website_sources(children = [], application_excludes = None):
    """Keep source and audit coverage explicit across Website package boundaries."""
    source_excludes = SOURCE_SUBPACKAGE_AUDIT_EXCLUDES + ["BUILD.bazel"]
    copied_source_files(
        name = "files",
        srcs = native.glob(["**"], allow_empty = True, exclude = source_excludes) + [child + ":files" for child in children],
    )
    copied_source_files(
        name = "audit_sources",
        srcs = native.glob(["**"], allow_empty = True, exclude = SOURCE_SUBPACKAGE_AUDIT_EXCLUDES) + [child + ":audit_sources" for child in children],
    )
    native.filegroup(
        name = "source_audit_files",
        srcs = native.glob(["**"], allow_empty = True, exclude = SOURCE_SUBPACKAGE_AUDIT_EXCLUDES) + [child + ":source_audit_files" for child in children],
    )
    copied_source_files(
        name = "lint_sources",
        srcs = native.glob(["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.mjs"], allow_empty = True, exclude = SOURCE_SUBPACKAGE_AUDIT_EXCLUDES) + [child + ":lint_sources" for child in children],
    )
    if application_excludes != None:
        copied_source_files(
            name = "application_files",
            srcs = native.glob(["**"], allow_empty = True, exclude = source_excludes + application_excludes) + [child + ":application_files" for child in children],
        )

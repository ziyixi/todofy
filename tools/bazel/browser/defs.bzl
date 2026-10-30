"""Playwright tests with the declared browser archive and the application's real configuration."""

load("@aspect_rules_js//js:defs.bzl", "js_test")

def _browser_toolchain_impl(ctx):
    return [platform_common.ToolchainInfo(browser = struct(
        files = depset(ctx.files.files),
        executable = ctx.file.executable,
        playwright_version = ctx.attr.playwright_version,
    ))]

browser_toolchain = rule(
    implementation = _browser_toolchain_impl,
    attrs = {
        "files": attr.label_list(allow_files = True, mandatory = True),
        "executable": attr.label(allow_single_file = True, mandatory = True),
        "playwright_version": attr.string(mandatory = True),
    },
)

def _setup_impl(ctx):
    browser = ctx.toolchains["//tools/bazel/browser:toolchain_type"].browser
    bootstrap = ctx.actions.declare_file(ctx.label.name + "_bootstrap.mjs")
    config = ctx.actions.declare_file(ctx.label.name + "_config.mjs")
    registry_root = browser.executable.short_path.rsplit("/", 3)[0]
    ctx.actions.write(bootstrap, """import { resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
if (require('@playwright/test/package.json').version !== %s) {
  throw new Error('Update the browser archive pins alongside the locked Playwright version');
}
if (!process.env.TEST_SRCDIR || !process.env.TEST_WORKSPACE) {
  throw new Error('Run this browser target with bazel test');
}
// Set the registry before loading Playwright, including direct persistent-context launches in specs.
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(process.env.TEST_SRCDIR, process.env.TEST_WORKSPACE, %s);
const specArg = process.argv.indexOf(%s);
if (specArg < 0) throw new Error('Missing declared Playwright spec argument');
process.argv[specArg] = realpathSync(process.argv[specArg]);
await import('@playwright/test/cli');
""" % (json.encode(browser.playwright_version), json.encode(registry_root), json.encode(ctx.attr.spec)))
    ctx.actions.write(config, """import original from './playwright.config.ts';
import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
if (!process.env.TEST_UNDECLARED_OUTPUTS_DIR) throw new Error('Missing Bazel test output directory');
export default {
  ...original,
  // Playwright's discovery skips runfiles symlinks; select the same declared files in the output tree.
  testDir: resolve(dirname(realpathSync('playwright.config.ts')), original.testDir),
  outputDir: resolve(process.env.TEST_UNDECLARED_OUTPUTS_DIR, 'playwright'),
  webServer: {
    ...original.webServer,
    command: JSON.stringify(process.execPath) + ' ' + JSON.stringify('../worker/test/runtime/dev-server.ts'),
  },
};
""")
    return [DefaultInfo(
        files = depset([bootstrap]),
        runfiles = ctx.runfiles(files = [bootstrap, config], transitive_files = browser.files),
    )]

_playwright_setup = rule(
    implementation = _setup_impl,
    attrs = {"spec": attr.string(mandatory = True)},
    toolchains = ["//tools/bazel/browser:toolchain_type"],
)

def tasks_browser_test(name, spec, data = [], **kwargs):
    _playwright_setup(name = name + "_setup", spec = spec)
    js_test(
        name = name,
        entry_point = ":" + name + "_setup",
        args = ["test", spec, "--config", name + "_setup_config.mjs"],
        chdir = native.package_name(),
        data = data + [spec, "playwright.config.ts", ":node_modules/@playwright/test", ":" + name + "_setup"],
        size = "large",
        # Node's TS loader must see the package symlink's canonical path outside node_modules.
        patch_node_fs = False,
        # The original synthetic server and browser fixtures share fixed local ports.
        tags = ["browser", "exclusive"],
        **kwargs
    )

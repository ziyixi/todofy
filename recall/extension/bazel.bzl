"""The existing Orion options browser check on a pinned, isolated WebKit runtime."""

load("@aspect_rules_js//js:defs.bzl", "js_test")

def _webkit_setup_impl(ctx):
    browser = ctx.toolchains["//tools/bazel/browser:webkit_toolchain_type"].browser
    artifacts = [file for file in ctx.attr.artifact[DefaultInfo].files.to_list() if file.is_directory]
    if len(artifacts) != 1:
        fail("Expected the built extension directory")
    output = ctx.actions.declare_file(ctx.label.name + ".mjs")
    registry = browser.executable.short_path.rsplit("/", 2)[0]
    ctx.actions.write(output, """import { cp, chmod, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
if (require('@playwright/test/package.json').version !== %s) throw new Error('Update pinned WebKit and Playwright together');
const root = resolve(process.env.TEST_SRCDIR, process.env.TEST_WORKSPACE);
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(root, %s);
const folder = resolve(process.env.TEST_UNDECLARED_OUTPUTS_DIR, 'extension');
await mkdir(folder, { recursive: true });
await cp(resolve(root, %s), folder, { recursive: true, dereference: true });
await chmod(folder, 0o755);
const { webkit, expect } = await import('@playwright/test');
const { checkOrionOptions } = await import('./test/options-browser.mjs');
const result = await checkOrionOptions({ webkit, expect, folder });
await writeFile(resolve(folder, 'orion-browser-check.json'), JSON.stringify(result, null, 2) + '\\n');
for (const check of result.results) console.log('ok - ' + check.case);
console.log('WebKit: ' + result.results.length + ' passed (' + result.version + ', ' + result.sha + ')');
""" % (json.encode(browser.playwright_version), json.encode(registry), json.encode(artifacts[0].short_path)))
    return [DefaultInfo(
        files = depset([output]),
        runfiles = ctx.runfiles(files = [output], transitive_files = browser.files),
    )]

_webkit_setup = rule(
    implementation = _webkit_setup_impl,
    attrs = {"artifact": attr.label(mandatory = True)},
    toolchains = ["//tools/bazel/browser:webkit_toolchain_type"],
)

def options_browser_test(name):
    _webkit_setup(name = name + "_setup", artifact = ":extension_artifact")
    js_test(
        name = name,
        entry_point = ":" + name + "_setup",
        chdir = "recall/extension",
        data = [":extension_artifact", ":node_modules/@playwright/test", "test/options-browser.mjs", "test/options-browser-fixture.mjs", ":" + name + "_setup"],
        patch_node_fs = False,
        size = "large",
        tags = ["browser", "exclusive"],
    )

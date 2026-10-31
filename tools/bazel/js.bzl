"""JS source providers, project-scoped tests and Vite build recipes."""

load("@aspect_rules_js//js:defs.bzl", "js_library", "js_run_binary")
load("@aspect_rules_js//js:providers.bzl", "JsInfo", "js_info")
load("@aspect_rules_js//npm:providers.bzl", "NpmPackageInfo")
load("@bazel_lib//lib:copy_directory.bzl", "copy_directory_bin_action")
load("@bazel_lib//lib:expand_template.bzl", "expand_template")
load("//proto/bazel:ts_package.bzl", "proto_package")
load("//tools/bazel:paths.bzl", "module_path", "project_path", "relative_path", "source_label")

def ts_source_library(name, srcs, deps = [], **kwargs):
    """Propagate TypeScript source types without compiling or widening deps."""
    js_library(name = name, srcs = srcs, types = srcs, deps = deps, **kwargs)

def copied_source_files(name, srcs, visibility = None, testonly = False):
    """Expose exact owner-copied files, including declarations, as data."""
    ts_source_library(
        name = name + "_copy",
        srcs = srcs,
        testonly = testonly,
        visibility = ["//visibility:private"],
    )
    native.filegroup(
        name = name,
        srcs = [":" + name + "_copy"],
        output_group = "types",
        testonly = testonly,
        visibility = visibility,
    )

def _directory_link(ctx, name, target):
    output = ctx.actions.declare_symlink("node_modules/" + name)
    relative = relative_path(target.path, output.dirname)
    ctx.actions.symlink(output = output, target_path = relative, target_type = "directory")
    return output

def _workspace_package_link_impl(ctx):
    package = ctx.attr.src[NpmPackageInfo]
    directory = package.src
    project = ctx.attr.project or ctx.label.package
    if ctx.attr.src.label.package != project:
        directory = ctx.actions.declare_directory(ctx.label.name + "_package")
        copy_directory_bin_action(
            ctx,
            src = package.src,
            dst = directory,
            copy_directory_bin = ctx.toolchains["@bazel_lib//lib:copy_directory_toolchain_type"].copy_directory_info.bin,
        )
    links = [_directory_link(ctx, package.package, directory)]
    runtime_files = []
    for name in ctx.attr.runtime_dependencies:
        matches = [info for info in package.npm_package_store_infos.to_list() if info.package == name]
        if len(matches) != 1:
            fail("Expected one declared npm dependency for %s, got %s" % (name, len(matches)))
        info = matches[0]
        links.append(_directory_link(ctx, name, info.package_store_directory))
        runtime_files.append(info.transitive_files)
    files = depset(links + [directory], transitive = runtime_files)
    types = depset(transitive = [ctx.attr.src[JsInfo].types, ctx.attr.src[JsInfo].transitive_types]) if JsInfo in ctx.attr.src else depset()
    return [DefaultInfo(files = files), js_info(target = ctx.label, npm_sources = files, types = types, transitive_types = types)]

workspace_package_link = rule(
    implementation = _workspace_package_link_impl,
    attrs = {
        "src": attr.label(mandatory = True, providers = [NpmPackageInfo]),
        "runtime_dependencies": attr.string_list(),
        "project": attr.string(),
    },
    toolchains = ["@bazel_lib//lib:copy_directory_toolchain_type"],
    doc = "Materialize a selected workspace package and its runtime imports for build actions.",
)

def _workspace_link_impl(ctx):
    package = ctx.attr.src[NpmPackageInfo]
    project = ctx.attr.project or ctx.label.package
    path = project + "/node_modules/" + package.package
    links = {path: package.src}
    transitive_files = []
    for dependency in package.npm_package_store_infos.to_list():
        links[project + "/node_modules/" + dependency.package] = dependency.package_store_directory
        transitive_files.append(dependency.transitive_files)
    runfiles = ctx.runfiles(symlinks = links, transitive_files = depset(transitive = transitive_files))
    runfiles = runfiles.merge(ctx.attr.src[DefaultInfo].default_runfiles)
    for dep in ctx.attr.data:
        runfiles = runfiles.merge(dep[DefaultInfo].default_runfiles)
    return [DefaultInfo(
        files = depset([package.src], transitive = [dep[DefaultInfo].files for dep in ctx.attr.data]),
        runfiles = runfiles,
    )]

workspace_link = rule(
    implementation = _workspace_link_impl,
    attrs = {
        "src": attr.label(mandatory = True, providers = [NpmPackageInfo]),
        "data": attr.label_list(),
        "project": attr.string(),
    },
    doc = "Expose a selected workspace npm package in this consumer's isolated test runfiles.",
)

def _vitest_config_impl(ctx):
    output = ctx.actions.declare_file(ctx.label.name + ".mjs")
    config = ctx.file.config
    if config:
        content = "import original from %s;\n" % json.encode(module_path(config.short_path, ctx.label.package))
    else:
        content = "const original = {};\n"
    content += """export default async env => {
  const config = typeof original === 'function' ? await original(env) : await original;
  return { ...config, resolve: { ...config.resolve, preserveSymlinks: true } };
};
"""
    ctx.actions.write(output, content)
    return [DefaultInfo(
        files = depset([output]),
        runfiles = ctx.runfiles(files = [output] + ([config] if config else [])),
    )]

_vitest_config = rule(
    implementation = _vitest_config_impl,
    attrs = {"config": attr.label(allow_single_file = True)},
)

vite_config = _vitest_config

def vitest_test(name, runner, tests, data = [], args = [], config = None, project = None, **kwargs):
    """Run explicit test files using the caller's lockfile-generated Vitest binary."""
    project = native.package_name() if project == None else project
    if config == None and project == native.package_name():
        config_names = [
            "vitest.config.ts",
            "vitest.config.mts",
            "vitest.config.js",
            "vitest.config.mjs",
            "vite.config.ts",
            "vite.config.mts",
            "vite.config.js",
            "vite.config.mjs",
        ]
        existing = native.glob(config_names, allow_empty = True)
        for path in config_names:
            if path in existing:
                config = path
                break
    config = source_label(config) if config else None
    _vitest_config(name = name + "_config", config = config)
    files = [source_label(test) for test in tests]
    config_path = relative_path(native.package_name() + "/" + name + "_config.mjs", project)
    runner(
        name = name,
        args = ["run"] + [project_path(test, project) for test in tests] + args + ["--config", config_path],
        chdir = project,
        data = {item: True for item in data + files + ([config] if config else []) + ["//" + project + ":node_modules/vitest", ":" + name + "_config"]}.keys(),
        **kwargs
    )

def proto_vitest_test(name, runner, tests, deps, data = [], project = None, **kwargs):
    """Run a file-level test with only its declared proto libraries and runtime inputs."""
    proto_package(name = name + "_proto", deps = deps)
    workspace_link(name = name + "_proto_link", src = ":" + name + "_proto", project = project or native.package_name())
    vitest_test(
        name = name,
        runner = runner,
        tests = tests,
        data = deps + data + [":" + name + "_proto_link"],
        project = project,
        **kwargs
    )

def workerd_vitest_test(name, runner, tests, deps = [], data = [], tags = ["workerd"], project = None, lib = None, runtime_helpers = None, config = None, package_json = None, **kwargs):
    """Run the existing whole-Worker harness with its shared runtime inputs."""
    moved = project != None
    project = project or native.package_name()
    parent = "//" + project + ":"
    proto_vitest_test(
        name = name,
        runner = runner,
        tests = tests,
        deps = [lib or parent + "lib"] + deps,
        data = [
            parent + "application_sources",
            runtime_helpers or ("//" + project + "/test:runtime_helpers" if moved else parent + "runtime_helpers"),
            parent + "edge_auth_types_link",
            parent + "node_modules/esbuild",
            parent + "node_modules/miniflare",
            package_json or parent + ("package_json" if moved else "package.json"),
        ] + data,
        config = config or parent + ("runtime_test_config" if moved else "vitest.runtime.config.ts"),
        project = project,
        size = "large",
        tags = tags,
        **kwargs
    )

def _vite_build_config_impl(ctx):
    output = ctx.actions.declare_file(ctx.label.name + ".mjs")
    config_path = ctx.file.config.short_path[len(ctx.label.package) + 1:]
    content = """import original from %s;
import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
export default async env => {
  const config = typeof original === 'function' ? await original(env) : await original;
  const result = {
    ...config,
    root: dirname(realpathSync('index.html')),
    build: { ...config.build, outDir: resolve(%s) },
  };
  if (__BAZEL_STAMPED__ && Object.hasOwn(config.define ?? {}, 'import.meta.env.VITE_BUILD_SHA')) {
    const sha = '__BAZEL_BUILD_SHA__';
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('Stamped UI requires a full Git SHA in --embed_label');
    result.define = { ...config.define, 'import.meta.env.VITE_BUILD_SHA': JSON.stringify(sha) };
  }
""" % (json.encode("./" + config_path), json.encode(ctx.attr.out_dir))
    postbuild = ctx.file.postbuild
    if postbuild:
        postbuild_path = postbuild.short_path[len(ctx.label.package) + 1:]
        if postbuild.basename == "js-budget.mjs":
            check = """const checks = await import(%s);
        const problem = checks.jsBudgetProblem(checks.jsSize(resolve(%s, 'assets')));
        if (problem !== null) throw new Error(problem);""" % (json.encode("./" + postbuild_path), json.encode(ctx.attr.out_dir))
        else:
            check = """const check = spawnSync(process.execPath, ['--preserve-symlinks-main', resolve(%s)], { stdio: 'inherit' });
        if (check.error) throw check.error;
        if (check.status !== 0) throw new Error('Postbuild check failed: ' + %s);""" % (json.encode(postbuild_path), json.encode(postbuild_path))
        content += """  result.plugins = [...(config.plugins ?? []), {
    name: 'bazel-postbuild-checks',
    async writeBundle() {
        %s
    },
  }];
""" % check
    content += "  return result;\n};\n"
    ctx.actions.write(output, content)
    return [DefaultInfo(files = depset([output]))]

_vite_build_template = rule(
    implementation = _vite_build_config_impl,
    attrs = {
        "config": attr.label(mandatory = True, allow_single_file = True),
        "out_dir": attr.string(default = "dist"),
        "postbuild": attr.label(allow_single_file = True),
    },
    doc = "Adapt the app's Vite build and existing checks to declared canonical paths.",
)

def vite_build_config(name, config, out_dir = "dist", postbuild = None, stamp = -1):
    """Stamp only the terminal Vite configuration, retaining stable ordinary builds."""
    _vite_build_template(
        name = name + "_template",
        config = config,
        out_dir = out_dir,
        postbuild = postbuild,
    )
    expand_template(
        name = name,
        template = ":" + name + "_template",
        out = name + ".mjs",
        substitutions = {"__BAZEL_STAMPED__": "false", "__BAZEL_BUILD_SHA__": ""},
        stamp_substitutions = {"__BAZEL_STAMPED__": "true", "__BAZEL_BUILD_SHA__": "{{BUILD_EMBED_LABEL}}"},
        stamp = stamp,
    )

def vite_bundle(name, tool, deps, data = [], out_dir = "dist", postbuild = None, stamp = -1):
    """Bundle a Vite entrypoint with its declared dependencies and original postbuild checks."""
    config_name = name + "_config"
    vite_build_config(
        name = config_name,
        config = "vite.config.ts",
        out_dir = out_dir,
        postbuild = postbuild,
        stamp = stamp,
    )
    js_run_binary(
        name = name,
        tool = tool,
        srcs = deps + data + ["index.html", "package.json", "vite.config.ts", ":" + config_name],
        args = ["build", "--config", config_name + ".mjs"],
        chdir = native.package_name(),
        out_dirs = [out_dir.split("/")[0]],
        include_types = True,
        include_transitive_types = True,
        patch_node_fs = False,
    )

"""Shared invocation for the repository's file-level Vitest targets."""

load("@aspect_rules_js//npm:providers.bzl", "NpmPackageInfo")
load("@aspect_rules_js//js:providers.bzl", "js_info")
load("@bazel_lib//lib:copy_directory.bzl", "copy_directory_bin_action")
load("//proto/bazel:ts_package.bzl", "proto_package")

def _directory_link(ctx, name, target):
    output = ctx.actions.declare_symlink("node_modules/" + name)
    source_parts = target.path.split("/")
    output_parts = output.dirname.split("/")
    common = 0
    for index in range(min(len(source_parts), len(output_parts))):
        if source_parts[index] != output_parts[index]:
            break
        common += 1
    relative = "../" * (len(output_parts) - common) + "/".join(source_parts[common:])
    ctx.actions.symlink(output = output, target_path = relative, target_type = "directory")
    return output

def _workspace_package_link_impl(ctx):
    package = ctx.attr.src[NpmPackageInfo]
    directory = package.src
    if ctx.attr.src.label.package != ctx.label.package:
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
    return [DefaultInfo(files = files), js_info(target = ctx.label, npm_sources = files)]

workspace_package_link = rule(
    implementation = _workspace_package_link_impl,
    attrs = {
        "src": attr.label(mandatory = True, providers = [NpmPackageInfo]),
        "runtime_dependencies": attr.string_list(),
    },
    toolchains = ["@bazel_lib//lib:copy_directory_toolchain_type"],
    doc = "Materialize a selected workspace package and its runtime imports for build actions.",
)

def _workspace_link_impl(ctx):
    package = ctx.attr.src[NpmPackageInfo]
    path = ctx.label.package + "/node_modules/" + package.package
    links = {path: package.src}
    transitive_files = []
    for dependency in package.npm_package_store_infos.to_list():
        links[ctx.label.package + "/node_modules/" + dependency.package] = dependency.package_store_directory
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
    },
    doc = "Expose a selected workspace npm package in this consumer's isolated test runfiles.",
)

def _vitest_config_impl(ctx):
    output = ctx.actions.declare_file(ctx.label.name + ".mjs")
    config = ctx.file.config
    if config:
        config_path = config.short_path[len(ctx.label.package) + 1:]
        content = "import original from %s;\n" % json.encode("./" + config_path)
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

def vitest_test(name, runner, tests, data = [], args = [], config = None, **kwargs):
    """Run explicit test files using the caller's lockfile-generated Vitest binary."""
    if config == None:
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
    _vitest_config(name = name + "_config", config = config)
    runner(
        name = name,
        args = ["run"] + tests + args + ["--config", name + "_config.mjs"],
        chdir = native.package_name(),
        data = {item: True for item in data + tests + ([config] if config else []) + [":node_modules/vitest", ":" + name + "_config"]}.keys(),
        **kwargs
    )

def proto_vitest_test(name, runner, tests, deps, data = [], **kwargs):
    """Run a file-level test with only its declared proto libraries and runtime inputs."""
    proto_package(name = name + "_proto", deps = deps)
    workspace_link(name = name + "_proto_link", src = ":" + name + "_proto")
    vitest_test(
        name = name,
        runner = runner,
        tests = tests,
        data = deps + data + [":" + name + "_proto_link"],
        **kwargs
    )

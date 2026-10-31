"""Run the locked ESLint CLI over exact child-owned source files."""

load("@aspect_rules_js//js:defs.bzl", "js_test")
load("//tools/bazel:paths.bzl", "relative_path", "source_label")

def _eslint_inputs_impl(ctx):
    files = sorted({relative_path(file.short_path, ctx.attr.project): True for file in ctx.files.sources}.keys())
    args = ["--config", relative_path(ctx.file.config.short_path, ctx.attr.project)] + ctx.attr.args
    ctx.actions.write(ctx.outputs.out, json.encode({"args": args, "files": files}))
    return [DefaultInfo(files = depset([ctx.outputs.out]))]

_eslint_inputs = rule(
    implementation = _eslint_inputs_impl,
    attrs = {
        "sources": attr.label_list(allow_files = True),
        "args": attr.string_list(),
        "config": attr.label(mandatory = True, allow_single_file = True),
        "project": attr.string(mandatory = True),
    },
    outputs = {"out": "%{name}.json"},
)

def eslint_test(name, runner, sources, config = "eslint.config.js", data = [], args = [], project = None, **kwargs):
    """Expand declared source groups and invoke the original CLI binary."""
    project = native.package_name() if project == None else project
    config = source_label(config)
    sources = [source_label(source) for source in sources]
    _eslint_inputs(
        name = name + "_inputs",
        sources = sources,
        project = project,
        config = config,
        args = args,
        testonly = True,
    )
    runner(
        name = name + "_cli",
        chdir = project,
        data = {Label(source_label(item)): True for item in sources + [config] + data}.keys(),
        include_types = kwargs.get("include_types", True),
        include_transitive_types = kwargs.get("include_transitive_types", True),
        patch_node_fs = kwargs.get("patch_node_fs", True),
        testonly = True,
        visibility = ["//visibility:private"],
    )
    kwargs.setdefault("include_types", True)
    kwargs.setdefault("include_transitive_types", True)
    kwargs.setdefault("size", "large")
    tags = ["lint"] + kwargs.pop("tags", [])
    js_test(
        name = name,
        entry_point = "//tools/bazel/lint:run_eslint",
        args = ["$(rootpath :" + name + "_inputs)", "$(rootpath :" + name + "_cli)"],
        chdir = project,
        data = [":" + name + "_inputs", ":" + name + "_cli"],
        tags = tags,
        **kwargs
    )

"""A generated-only tree for raw pnpm/uv consumers of the canonical Bazel outputs."""

load("@aspect_rules_js//npm:providers.bzl", "NpmPackageInfo")
load("@rules_python//python:py_info.bzl", "PyInfo")

def _materialized_impl(ctx):
    tree = ctx.actions.declare_directory(ctx.label.name)
    package = ctx.attr.typescript[NpmPackageInfo].src
    python = depset(transitive = [target[PyInfo].transitive_sources for target in ctx.attr.python])
    generated_python = [file for file in python.to_list() if not file.is_source]
    args = ctx.actions.args()
    args.add("--typescript", package.path)
    args.add("--out", tree.path)
    for file in generated_python:
        args.add("--python", file.short_path.removeprefix("proto/python/src/ziyixi_proto/") + "=" + file.path)
    for file in ctx.files.inputs:
        if file.short_path.startswith("proto/"):
            name = file.short_path.removeprefix("proto/")
        else:
            name = "../" + file.short_path
        args.add("--input", name + "=" + file.path)
    ctx.actions.run(
        executable = ctx.attr._tool[DefaultInfo].files_to_run,
        arguments = [args],
        inputs = depset([package] + generated_python + ctx.files.inputs),
        outputs = [tree],
        mnemonic = "ProtoMaterialization",
    )
    return [DefaultInfo(files = depset([tree]))]

materialized_proto = rule(
    implementation = _materialized_impl,
    attrs = {
        "typescript": attr.label(mandatory = True, providers = [NpmPackageInfo]),
        "python": attr.label_list(mandatory = True, providers = [PyInfo]),
        "inputs": attr.label_list(allow_files = True),
        "_tool": attr.label(default = "//proto/tools:materialize", executable = True, cfg = "exec"),
    },
)

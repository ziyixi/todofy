"""Assemble only the proto libraries a consumer imports under their existing npm paths."""

load("@aspect_rules_js//js:providers.bzl", "JsInfo", "js_info")
load("@aspect_rules_js//npm:defs.bzl", "npm_package")
load("@aspect_rules_js//npm:providers.bzl", "NpmPackageInfo")

def _wire_anchor_impl(ctx):
    files = depset(transitive = [
        source_files
        for dep in ctx.attr.deps
        if JsInfo in dep
        for source_files in [dep[JsInfo].transitive_sources, dep[JsInfo].transitive_types]
    ])
    modules = {}
    for file in files.to_list():
        if not file.short_path.startswith("proto/ts/"):
            continue
        path = file.short_path.removeprefix("proto/ts/")
        if path.endswith("_wire.d.ts"):
            modules[path.removesuffix(".d.ts")] = True
        elif path.endswith("_wire.ts"):
            modules[path.removesuffix(".ts")] = True
    output = ctx.actions.declare_file(ctx.label.name + ".d.ts")
    imports = ["import type {} from '@ziyixi/proto/%s';" % module for module in sorted(modules)]
    ctx.actions.write(output, "\n".join(imports) + "\n" if imports else "export {};\n")
    return [DefaultInfo(files = depset([output]))]

_wire_anchor = rule(
    implementation = _wire_anchor_impl,
    attrs = {"deps": attr.label_list()},
)

def _typed_package_impl(ctx):
    package = ctx.attr.package
    return [
        package[DefaultInfo],
        package[NpmPackageInfo],
        js_info(target = ctx.label, types = ctx.attr.anchor[DefaultInfo].files),
    ]

_typed_package = rule(
    implementation = _typed_package_impl,
    attrs = {
        "package": attr.label(mandatory = True, providers = [NpmPackageInfo]),
        "anchor": attr.label(mandatory = True),
    },
)

def proto_package(name, deps, **kwargs):
    npm_package(
        name = name + "_npm",
        out = name,
        package = "@ziyixi/proto",
        srcs = ["//proto/ts:package.json"] + deps,
        root_paths = ["proto/ts"],
        include_srcs_packages = ["proto/ts"],
        **kwargs
    )
    _wire_anchor(name = name + "_wire_types", deps = deps)
    _typed_package(name = name, package = ":" + name + "_npm", anchor = ":" + name + "_wire_types", **kwargs)

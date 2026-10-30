"""Assemble only the proto libraries a consumer imports under their existing npm paths."""

load("@aspect_rules_js//npm:defs.bzl", "npm_package")

def proto_package(name, deps, **kwargs):
    npm_package(
        name = name,
        package = "@ziyixi/proto",
        srcs = ["//proto/ts:package.json"] + deps,
        root_paths = ["proto/ts"],
        include_srcs_packages = ["proto/ts"],
        **kwargs
    )

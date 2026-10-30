"""The three existing offline Python image probes as local Linux tests."""

load("@rules_python//python:defs.bzl", "py_test")
load("//tools/bazel/audit:sources.bzl", "source_manifest")

def container_image_test(name, service, sources):
    source_manifest(name = name + "_sources", srcs = sources)
    py_test(
        name = name,
        srcs = ["//tools/bazel/python:container_test.py"],
        main = "//tools/bazel/python:container_test.py",
        args = [
            "--service",
            service,
            "--image",
            "$(rootpath :" + service + ")",
            "--manifest",
            "$(rootpath :" + name + "_sources)",
        ],
        data = [":" + service, ":" + name + "_sources"],
        legacy_create_init = False,
        size = "large",
        tags = ["container", "exclusive", "local", "no-sandbox", "no-cache"],
        target_compatible_with = ["@platforms//os:linux", "@platforms//cpu:x86_64"],
    )

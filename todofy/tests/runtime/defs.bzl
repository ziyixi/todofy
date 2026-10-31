"""Run Todofy scenarios through their existing workerd staging runner."""

load("@rules_python//python:defs.bzl", "py_test")

_MAIN = "//tools/bazel/python:todofy_runtime_main.py"
_CONFIG = "//todofy:pyproject.toml"

def todofy_runtime_test(name, source, data, **kwargs):
    """Keep one scenario file in its own native Bazel test process."""
    py_test(
        name = name,
        srcs = [source, _MAIN],
        args = [
            "-c",
            "$(rootpath %s)" % _CONFIG,
            "-p",
            "no:cacheprovider",
            "-p",
            "xdist.plugin",
            "-p",
            "xdist.looponfail",
            "$(rootpath %s)" % source,
        ],
        data = [_CONFIG] + data,
        legacy_create_init = False,
        main = _MAIN,
        **kwargs
    )

"""Fixed runners for explicitly declared Python tests and lint checks."""

load("@rules_python//python:defs.bzl", "py_binary", "py_test")

_PYTEST_MAIN = "//tools/bazel/python:pytest_main.py"
_UNITTEST_MAIN = "//tools/bazel/python:unittest_main.py"
_RUFF_MAIN = "//tools/bazel/python:check_ruff.py"
_RUFF = "@python_deps//ruff:data"

def pytest_test(name, srcs, config, plugins = [], args = [], data = [], env = {}, deps = [], **kwargs):
    """Run explicit pytest selectors with the repository's locked runner."""
    plugin_args = []
    for plugin in plugins:
        plugin_args.extend(["-p", plugin])
    py_test(
        name = name,
        srcs = srcs + [_PYTEST_MAIN],
        args = ["-c", "$(rootpath %s)" % config, "-p", "no:cacheprovider"] + plugin_args + args,
        data = [config] + data,
        env = env,
        deps = deps + ["@python_deps//pytest"],
        legacy_create_init = False,
        main = _PYTEST_MAIN,
        **kwargs
    )

def unittest_test(name, srcs, modules, args = [], **kwargs):
    """Run the one explicitly declared module through unittest discovery."""
    if len(modules) != 1:
        fail("unittest_test requires exactly one module")
    py_test(
        name = name,
        srcs = srcs + [_UNITTEST_MAIN],
        args = modules + args,
        legacy_create_init = False,
        main = _UNITTEST_MAIN,
        **kwargs
    )

def ruff_test(name, command, config, paths, data = [], **kwargs):
    """Check declared paths using Ruff without a cache."""
    py_test(
        name = name,
        srcs = [_RUFF_MAIN],
        args = [_rootpath(_RUFF), _rootpath(config), command] + (["--check"] if command == "format" else []) + paths,
        data = [config, _RUFF] + data,
        legacy_create_init = False,
        main = _RUFF_MAIN,
        **kwargs
    )

def ruff_binary(name, command, config, paths, data = [], **kwargs):
    """Run Ruff's local editing command with the same declared toolchain."""
    py_binary(
        name = name,
        srcs = [_RUFF_MAIN],
        args = [_rootpath(_RUFF), _rootpath(config), command] + paths,
        data = [config, _RUFF] + data,
        legacy_create_init = False,
        main = _RUFF_MAIN,
        **kwargs
    )

def _rootpath(label):
    return "$(rootpath %s)" % label

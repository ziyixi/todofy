"""Run the locked ESLint engine with the application's original configuration and explicit sources."""

def eslint_test(name, runner, sources, config = "eslint.config.js", data = [], **kwargs):
    kwargs.setdefault("include_types", True)
    kwargs.setdefault("include_transitive_types", True)
    runner(
        name = name,
        args = ["--config", config] + sources,
        chdir = native.package_name(),
        data = {path: True for path in sources + [config] + data}.keys(),
        size = "large",
        tags = ["lint"],
        **kwargs
    )

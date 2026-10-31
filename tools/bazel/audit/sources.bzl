"""Public repository sources used by the existing whole-repository audits."""

SOURCE_AUDIT_EXCLUDES = [
    "**/.git",
    "**/.git/**",
    "bazel-*",
    "bazel-*/**",
    "**/node_modules/**",
    "**/.pnpm-store/**",
    "**/.venv*/**",
    "**/__pycache__/**",
    "**/*.pyc",
    "**/*.egg-info/**",
    "**/.pytest_cache/**",
    "**/.ruff_cache/**",
    "**/.mypy_cache/**",
    "**/.wrangler/**",
    "**/.terraform/**",
    "**/.cache/**",
    "**/build/**",
    "**/dist/**",
    "**/out/**",
    "**/.next/**",
    "**/.generated/**",
    "**/python_modules/**",
    "**/.tools/**",
    "**/.generate-*/**",
    "**/.generate.lock/**",
    "**/.generated.json*",
    "**/test-results/**",
    "**/playwright-report/**",
    "**/coverage/**",
    "**/design-qa-artifacts/**",
    "**/.artifacts/**",
    "**/tmp/**",
    "**/.data*/**",
    "**/.demo*/**",
    "**/.codex-auth/**",
    "**/codex-auth/**",
    "**/.env",
    "**/.env.*",
    "**/.dev.vars",
    "**/.dev.vars.*",
    "**/auth.json*",
    "**/credentials*.json",
    "**/*.pem",
    "**/*.key",
    "**/*.p12",
    "**/*.pfx",
    "**/id_rsa",
    "**/id_ed25519",
    "**/*.sqlite*",
    "**/*.db",
    "**/*.db-shm",
    "**/*.db-wal",
    "**/*.eml",
    "**/*.tfstate*",
    "**/*.tfplan*",
    "**/tfplan*",
    "**/*.tfvars",
    "**/*.tfvars.json",
    "**/crash.log",
    "**/crash.*.log",
    "**/wrangler.production.ci.json",
    "**/wrangler.production.secrets.json",
    "**/wrangler.test-run-*.json",
    "**/.DS_Store",
    "**/*.log",
    "**/*.tsbuildinfo",
    "**/.idea/**",
    "**/.vscode/**",
    "**/*.swp",
    "**/*.swo",
]

# The repository-root Bazel output links are not exclusions for source files
# such as a child package's scripts/bazel-build.mjs.
SOURCE_SUBPACKAGE_AUDIT_EXCLUDES = [pattern for pattern in SOURCE_AUDIT_EXCLUDES if pattern.startswith("**/")]

def source_audit_files(patterns = ["*"], deps = [], exclude = SOURCE_AUDIT_EXCLUDES):
    """Collect the repository's public source and example-file audit inputs."""
    native.filegroup(
        name = "source_audit_files",
        srcs = native.glob(patterns, allow_empty = True, exclude = exclude) + native.glob(
            [".env.example", ".env.*.example", ".dev.vars.example"],
            allow_empty = True,
        ) + deps,
        visibility = ["//visibility:public"],
    )

def _source_manifest_impl(ctx):
    files = ctx.attr.srcs[DefaultInfo].files.to_list()
    for source in files:
        if not source.is_source or source.short_path.startswith("../"):
            fail("Repository audits accept workspace source files only: " + source.short_path)
    ctx.actions.write(ctx.outputs.out, json.encode(sorted([source.short_path for source in files])))
    return [DefaultInfo(files = depset([ctx.outputs.out]), runfiles = ctx.runfiles(files = files))]

source_manifest = rule(
    implementation = _source_manifest_impl,
    attrs = {"srcs": attr.label(mandatory = True)},
    outputs = {"out": "%{name}.json"},
)

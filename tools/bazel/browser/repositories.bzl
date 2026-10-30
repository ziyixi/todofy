"""Official Chromium headless-shell archives paired with locked Playwright 1.63.0."""

_ARCHIVES = {
    "mac_arm64": struct(
        platform = "mac-arm64",
        sha256 = "89d80a6d26ccd0ccfd51e22d9e1297283862af2b0cd91dce07459b35ca0059f2",
    ),
    "linux_amd64": struct(
        platform = "linux64",
        sha256 = "a9da028861a0cf789ff25c2fed45f5f1aaf969ed9247835b6a7821a4f7af9d1d",
    ),
}

def _chromium_archive_impl(ctx):
    archive = _ARCHIVES[ctx.attr.platform]
    directory = "chrome-headless-shell-" + archive.platform
    ctx.download_and_extract(
        url = "https://cdn.playwright.dev/builds/cft/153.0.8010.12/" + archive.platform + "/" + directory + ".zip",
        sha256 = archive.sha256,
        output = "chromium_headless_shell-1243",
    )
    executable = "chromium_headless_shell-1243/" + directory + "/chrome-headless-shell"
    ctx.file("BUILD.bazel", """package(default_visibility = ["//visibility:public"])
exports_files([%r])
filegroup(name = "files", srcs = glob(["chromium_headless_shell-1243/**"]))
""" % executable)

chromium_archive = repository_rule(
    implementation = _chromium_archive_impl,
    attrs = {"platform": attr.string(mandatory = True, values = _ARCHIVES.keys())},
)

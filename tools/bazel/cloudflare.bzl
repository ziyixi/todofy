"""The common Wrangler dry-run and Cloudflare release archive layout."""

load("@aspect_rules_js//js:defs.bzl", "js_run_binary")
load("@rules_pkg//pkg:mappings.bzl", "pkg_files", "strip_prefix")
load("@rules_pkg//pkg:tar.bzl", "pkg_tar")

def worker_artifact(name, srcs, tool, config = ":config", web = None, web_prefix = "web/dist", args = [], visibility = None, bundle_visibility = None):
    """Build the existing Worker/config/UI tarball from explicit application inputs."""
    bundle_kwargs = {"visibility": bundle_visibility} if bundle_visibility != None else {}
    js_run_binary(
        name = "worker_bundle",
        srcs = srcs,
        args = ["deploy", "--dry-run", "--config", "wrangler.toml", "--outdir", "worker_bundle"] + args,
        chdir = native.package_name(),
        env = {"CI": "true", "WRANGLER_SEND_METRICS": "false"},
        include_transitive_types = True,
        include_types = True,
        out_dirs = ["worker_bundle"],
        tool = tool,
        **bundle_kwargs
    )
    pkg_files(
        name = "worker_files",
        srcs = [":worker_bundle"],
        prefix = "worker",
        strip_prefix = strip_prefix.from_pkg("worker_bundle"),
    )
    pkg_files(
        name = "config_files",
        srcs = [config],
        strip_prefix = strip_prefix.from_pkg(),
    )
    files = [":config_files", ":worker_files"]
    if web != None:
        pkg_files(
            name = "web_files",
            srcs = [web],
            prefix = web_prefix,
            strip_prefix = strip_prefix.from_root(Label(web).package + "/dist"),
        )
        files = [":config_files", ":web_files", ":worker_files"]
    archive_kwargs = {"visibility": visibility} if visibility != None else {}
    pkg_tar(
        name = name,
        srcs = files,
        extension = "tar.gz",
        stamp = 0,
        **archive_kwargs
    )

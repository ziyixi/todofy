"""The exact Google APIs sources already pinned by proto/buf.lock."""

_GOOGLEAPIS_ARCHIVES = {
    "c17df5b2beca46928cc87d5656bd5343": struct(
        sha256 = "1315dd905a4acad93c42ea7ad642cc6f1150837944ed338c6ebdf772c7e093c5",
        digest = "b5:648a01e0170d4512dea7d564016165decd1ed6e34bef79fe54753e51ad7e27545709ad9157d7551270147d551155c595a2fb0bf5bb33b1c83040ddbce915c604",
    ),
}

_GOOGLE = {
    "google/api/annotations.proto": ["google/api/http.proto", "google/protobuf/descriptor.proto"],
    "google/api/client.proto": ["google/api/launch_stage.proto", "google/protobuf/descriptor.proto", "google/protobuf/duration.proto"],
    "google/api/field_behavior.proto": ["google/protobuf/descriptor.proto"],
    "google/api/field_info.proto": ["google/protobuf/descriptor.proto"],
    "google/api/http.proto": [],
    "google/api/launch_stage.proto": [],
    "google/api/resource.proto": ["google/protobuf/descriptor.proto"],
    "google/rpc/code.proto": [],
    "google/rpc/error_details.proto": ["google/protobuf/duration.proto"],
    "google/rpc/status.proto": ["google/protobuf/any.proto"],
}

def _name(path):
    return path.removesuffix(".proto").replace("/", "_") + "_proto"

def _googleapis_impl(repository_ctx):
    lock = repository_ctx.path(repository_ctx.attr.buf_lock)
    # Reading the label's contents makes lock changes invalidate the fetched repository.
    repository_ctx.read(lock)
    system = "darwin" if repository_ctx.os.name == "mac os x" else repository_ctx.os.name
    architecture = {"aarch64": "arm64", "arm64": "arm64", "x86_64": "amd64", "amd64": "amd64"}.get(repository_ctx.os.arch)
    platform = system + "_" + (architecture or "unsupported")
    attribute = "_yq_" + platform
    if not hasattr(repository_ctx.attr, attribute):
        fail("buf.lock validation does not support host platform " + platform)
    yq = repository_ctx.path(getattr(repository_ctx.attr, attribute))
    result = repository_ctx.execute([yq, "-o=json", ".", lock])
    if result.return_code:
        fail("Could not parse the authoritative buf.lock: " + result.stderr)
    config = json.decode(result.stdout)
    modules = [dep for dep in config.get("deps", []) if dep.get("name") == "buf.build/googleapis/googleapis"]
    if config.get("version") != "v2" or len(modules) != 1:
        fail("buf.lock must contain one v2 googleapis dependency")
    commit = modules[0].get("commit")
    archive = _GOOGLEAPIS_ARCHIVES.get(commit)
    if archive == None or modules[0].get("digest") != archive.digest:
        fail("buf.lock googleapis commit/digest has no matching pinned archive SHA-256; update proto/bazel/repositories.bzl with the verified archive")
    repository_ctx.download_and_extract(
        url = "https://buf.build/googleapis/googleapis/archive/" + commit + ".tar.gz",
        sha256 = archive.sha256,
    )
    lines = [
        'load("@protobuf//bazel:proto_library.bzl", "proto_library")',
        'package(default_visibility = ["//visibility:public"])',
    ]
    for path, imports in _GOOGLE.items():
        deps = [
            "@protobuf//:" + imported.removesuffix(".proto").split("/")[-1] + "_proto" if imported.startswith("google/protobuf/") else ":" + _name(imported)
            for imported in imports
        ]
        lines.append("proto_library(name = %r, srcs = [%r], deps = %r)" % (_name(path), path, deps))
    repository_ctx.file("BUILD.bazel", "\n".join(lines) + "\n")

googleapis_repository = repository_rule(
    implementation = _googleapis_impl,
    attrs = {
        "buf_lock": attr.label(default = "//proto:buf.lock", allow_single_file = True),
        "_yq_darwin_arm64": attr.label(default = "@yq_darwin_arm64//:yq", allow_single_file = True),
        "_yq_darwin_amd64": attr.label(default = "@yq_darwin_amd64//:yq", allow_single_file = True),
        "_yq_linux_amd64": attr.label(default = "@yq_linux_amd64//:yq", allow_single_file = True),
        "_yq_linux_arm64": attr.label(default = "@yq_linux_arm64//:yq", allow_single_file = True),
    },
)

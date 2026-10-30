"""Files that complement the existing pinned Python container base."""

def _runtime_tree_impl(ctx):
    output = ctx.actions.declare_directory(ctx.label.name)
    args = ctx.actions.args()
    args.add("--base", ctx.file.base.path)
    args.add("--service", ctx.attr.service)
    args.add("--out", output.path)
    ctx.actions.run(
        executable = ctx.executable._tool,
        arguments = [args],
        inputs = [ctx.file.base],
        outputs = [output],
        mnemonic = "PythonImageRuntime",
    )
    return [DefaultInfo(files = depset([output]))]

python_runtime_tree = rule(
    implementation = _runtime_tree_impl,
    attrs = {
        "base": attr.label(allow_single_file = True, mandatory = True),
        "service": attr.string(values = ["codex-gateway", "newsletter", "platform"], mandatory = True),
        "_tool": attr.label(default = Label("//tools/bazel/images:runtime_tree"), executable = True, cfg = "exec"),
    },
)

def _image_identity_impl(ctx):
    tree = ctx.actions.declare_directory(ctx.label.name)
    labels = ctx.actions.declare_file(ctx.label.name + ".labels")
    args = ctx.actions.args()
    args.add("--status", ctx.info_file)
    inputs = [ctx.info_file]
    if ctx.file.profile:
        args.add("--profile", ctx.file.profile)
        inputs.append(ctx.file.profile)
    if ctx.file.resources:
        args.add("--resources", ctx.file.resources)
        inputs.append(ctx.file.resources)
    args.add("--out", tree.path)
    args.add("--labels", labels)
    ctx.actions.run(
        executable = ctx.executable._tool,
        arguments = [args],
        inputs = inputs,
        outputs = [tree, labels],
        mnemonic = "PythonImageIdentity",
    )
    return [
        DefaultInfo(files = depset([tree])),
        OutputGroupInfo(labels = depset([labels])),
    ]

gateway_image_identity = rule(
    implementation = _image_identity_impl,
    attrs = {
        "profile": attr.label(allow_single_file = True, mandatory = True),
        "resources": attr.label(allow_single_file = True, mandatory = True),
        "_tool": attr.label(default = Label("//tools/bazel/images:gateway_identity"), executable = True, cfg = "exec"),
    },
)

newsletter_image_identity = rule(
    implementation = _image_identity_impl,
    attrs = {
        "profile": attr.label(allow_single_file = True, mandatory = True),
        "resources": attr.label(allow_single_file = True, mandatory = True),
        "_tool": attr.label(default = Label("//tools/bazel/images:newsletter_identity"), executable = True, cfg = "exec"),
    },
)

platform_image_identity = rule(
    implementation = _image_identity_impl,
    attrs = {
        "profile": attr.label(allow_single_file = True),
        "resources": attr.label(allow_single_file = True),
        "_tool": attr.label(default = Label("//tools/bazel/images:platform_identity"), executable = True, cfg = "exec"),
    },
)

def _platform_resources_impl(ctx):
    output = ctx.actions.declare_file(ctx.label.name + ".json")
    args = ctx.actions.args()
    args.add("--kubectl", ctx.file.kubectl.path)
    args.add_all(ctx.files.manifests, before_each = "--manifest")
    args.add("--out", output)
    ctx.actions.run(
        executable = ctx.executable._tool,
        arguments = [args],
        inputs = ctx.files.manifests,
        tools = [ctx.file.kubectl],
        outputs = [output],
        mnemonic = "PlatformManifestResources",
    )
    return [DefaultInfo(files = depset([output]))]

platform_image_resources = rule(
    implementation = _platform_resources_impl,
    attrs = {
        "manifests": attr.label_list(allow_files = True, mandatory = True),
        "kubectl": attr.label(allow_single_file = True, mandatory = True, cfg = "exec"),
        "_tool": attr.label(default = Label("//tools/bazel/images:platform_resources"), executable = True, cfg = "exec"),
    },
)

def _newsletter_healthcheck_impl(ctx):
    output = ctx.actions.declare_directory(ctx.label.name)
    digest = ctx.actions.declare_file(ctx.label.name + ".digest")
    base = ctx.attr.base[DefaultInfo]
    args = ctx.actions.args()
    args.add("--base", ctx.file.base.path)
    args.add("--dockerfile", ctx.file.dockerfile)
    args.add("--out", output.path)
    args.add("--digest", digest)
    ctx.actions.run(
        executable = ctx.executable._tool,
        arguments = [args],
        inputs = depset([ctx.file.base, ctx.file.dockerfile], transitive = [base.default_runfiles.files]),
        outputs = [output, digest],
        mnemonic = "NewsletterImageHealthcheck",
    )
    return [
        DefaultInfo(files = depset([output]), runfiles = ctx.runfiles(transitive_files = base.default_runfiles.files)),
        OutputGroupInfo(digest = depset([digest])),
    ]

newsletter_healthcheck = rule(
    implementation = _newsletter_healthcheck_impl,
    attrs = {
        "base": attr.label(allow_single_file = True, mandatory = True),
        "dockerfile": attr.label(allow_single_file = True, mandatory = True),
        "_tool": attr.label(default = Label("//tools/bazel/images:newsletter_healthcheck"), executable = True, cfg = "exec"),
    },
)

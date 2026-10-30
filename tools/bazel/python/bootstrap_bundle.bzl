"""Render the existing public VPS bootstrap bundle with declared inputs."""

def _bootstrap_bundle_impl(ctx):
    sources = ctx.attr.srcs[DefaultInfo].files.to_list()
    manifest = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    images = ctx.actions.declare_file(ctx.label.name + ".images.json")
    output = ctx.actions.declare_directory(ctx.label.name)
    ctx.actions.write(manifest, json.encode(sorted([source.short_path for source in sources])))
    ctx.actions.write(images, json.encode({
        "newsletter": ctx.var.get("TODOFY_NEWSLETTER_IMAGE", ""),
        "platform": ctx.var.get("TODOFY_PLATFORM_IMAGE", ""),
        "codex-gateway": ctx.var.get("TODOFY_CODEX_GATEWAY_IMAGE", ""),
    }))
    args = ctx.actions.args()
    args.add("--manifest", manifest)
    args.add("--images", images)
    args.add("--status", ctx.info_file)
    args.add("--kubectl", ctx.executable._kubectl)
    args.add("--out", output.path)
    ctx.actions.run(
        executable = ctx.executable._tool,
        arguments = [args],
        inputs = depset(sources + [manifest, images, ctx.info_file]),
        tools = [ctx.attr._kubectl[DefaultInfo].files_to_run],
        outputs = [output],
        mnemonic = "VpsBootstrapBundle",
    )
    return [DefaultInfo(files = depset([output]))]

bootstrap_bundle = rule(
    implementation = _bootstrap_bundle_impl,
    attrs = {
        "srcs": attr.label(mandatory = True),
        "_tool": attr.label(default = Label("//tools/bazel/python:bootstrap_bundle_tool"), executable = True, cfg = "exec"),
        "_kubectl": attr.label(default = Label("//tools/bazel/images:kubectl"), executable = True, cfg = "exec"),
    },
)

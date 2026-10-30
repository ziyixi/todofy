"""Package-scoped code generation from real proto_library descriptor closures."""

load("@protobuf//bazel/common:proto_info.bzl", "ProtoInfo")

def _generate_impl(ctx):
    outputs = []
    descriptors = depset(transitive = [dep[ProtoInfo].transitive_descriptor_sets for dep in ctx.attr.protos])
    args = ctx.actions.args()
    args.add("--format", ctx.attr.format)
    args.add("--package", ctx.attr.proto_package)
    args.add("--buf", ctx.executable._buf)
    configs = []
    if ctx.attr.format == "ts":
        args.add("--plugin", ctx.executable._plugin)
        args.add("--config", ctx.file._generation_config)
        configs.append(ctx.file._generation_config)
    for source in ctx.attr.sources:
        args.add("--source", source)
    unknown = [path for path in ctx.attr.output_paths if path not in ctx.attr.outs]
    if unknown:
        fail("output_paths keys must name declared outputs: " + ", ".join(unknown))
    for path in ctx.attr.outs:
        output = ctx.actions.declare_file(path)
        outputs.append(output)

        # outs is a set-like Bazel field and formatters may reorder it.
        # Bind generator names by output path, never by a parallel list's index.
        args.add("--output", ctx.attr.output_paths.get(path, path) + "=" + output.path)
    args.add_all(descriptors, before_each = "--descriptor")
    generator = getattr(ctx.attr, "_" + ctx.attr.format + "_generator")
    ctx.actions.run(
        executable = generator[DefaultInfo].files_to_run,
        arguments = [args],
        inputs = depset(configs, transitive = [descriptors]),
        tools = [target[DefaultInfo].files_to_run for target in ([ctx.attr._buf, ctx.attr._plugin] if ctx.attr.format == "ts" else [ctx.attr._buf])],
        outputs = outputs,
        env = {"BAZEL_BINDIR": ctx.bin_dir.path, "JS_BINARY__NO_CD_BINDIR": "1"},
        mnemonic = "Proto" + ctx.attr.format.capitalize(),
        progress_message = "Generating %s for %s" % (ctx.attr.format, ctx.attr.proto_package),
    )
    return [DefaultInfo(files = depset(outputs))]

proto_codegen = rule(
    implementation = _generate_impl,
    attrs = {
        "protos": attr.label_list(providers = [ProtoInfo], mandatory = True),
        "proto_package": attr.string(mandatory = True),
        "format": attr.string(values = ["ts", "python", "schema"], mandatory = True),
        "sources": attr.string_list(mandatory = True),
        "outs": attr.string_list(mandatory = True),
        "output_paths": attr.string_dict(),
        "_ts_generator": attr.label(default = "//proto/tools:bazel_ts_codegen", executable = True, cfg = "exec"),
        "_python_generator": attr.label(default = "//proto/tools:bazel_python_codegen", executable = True, cfg = "exec"),
        "_schema_generator": attr.label(default = "//proto/tools:bazel_schema_codegen", executable = True, cfg = "exec"),
        "_buf": attr.label(default = "//tools/bazel:buf", executable = True, cfg = "exec"),
        "_plugin": attr.label(default = "//tools/bazel:protoc-gen-es", executable = True, cfg = "exec"),
        "_generation_config": attr.label(default = "//proto:buf.gen.yaml", allow_single_file = True),
    },
)

def _python_namespace_impl(ctx):
    outputs = [ctx.actions.declare_file(path + "/__init__.py") for path in ctx.attr.paths]
    for output in outputs:
        ctx.actions.write(output, "")
    return [DefaultInfo(files = depset(outputs))]

python_namespace = rule(
    implementation = _python_namespace_impl,
    attrs = {"paths": attr.string_list(mandatory = True)},
)

def _proto_image_impl(ctx):
    descriptors = depset(transitive = [dep[ProtoInfo].transitive_descriptor_sets for dep in ctx.attr.protos])
    args = ctx.actions.args()
    args.add("--buf", ctx.executable._buf)
    args.add("--out", ctx.outputs.out)
    args.add_all(descriptors, before_each = "--descriptor")
    args.add_all(ctx.attr.sources, before_each = "--source")
    ctx.actions.run(
        executable = ctx.attr._generator[DefaultInfo].files_to_run,
        arguments = [args],
        inputs = descriptors,
        tools = [ctx.attr._buf[DefaultInfo].files_to_run],
        outputs = [ctx.outputs.out],
        env = {"BAZEL_BINDIR": ctx.bin_dir.path, "JS_BINARY__NO_CD_BINDIR": "1"},
        mnemonic = "ProtoImage",
    )

proto_image = rule(
    implementation = _proto_image_impl,
    attrs = {
        "protos": attr.label_list(providers = [ProtoInfo], mandatory = True),
        "sources": attr.string_list(mandatory = True),
        "out": attr.output(mandatory = True),
        "_generator": attr.label(default = "//proto/tools:bazel_image", executable = True, cfg = "exec"),
        "_buf": attr.label(default = "//tools/bazel:buf", executable = True, cfg = "exec"),
    },
)

def _proto_sources_impl(ctx):
    return [DefaultInfo(files = depset(transitive = [dep[ProtoInfo].transitive_sources for dep in ctx.attr.protos]))]

proto_source_files = rule(
    implementation = _proto_sources_impl,
    attrs = {"protos": attr.label_list(providers = [ProtoInfo], mandatory = True)},
)

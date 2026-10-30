"""Expose the fixed Node toolchain to Python subprocess tests."""

load("@rules_nodejs//nodejs:toolchain.bzl", "NodeInfo")

def _node_binary_impl(ctx):
    runtime = ctx.attr.runtime[NodeInfo].node
    if runtime == None:
        fail("Python tests require the repository's downloaded Node toolchain")
    output = ctx.actions.declare_file("node")
    ctx.actions.symlink(output = output, target_file = runtime, is_executable = True)
    return [DefaultInfo(files = depset([output]))]

node_binary = rule(
    implementation = _node_binary_impl,
    attrs = {"runtime": attr.label(default = Label("@rules_nodejs//nodejs:current_node_toolchain"), providers = [NodeInfo])},
)

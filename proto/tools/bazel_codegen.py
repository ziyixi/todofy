"""Run the existing generators against one proto_library import closure."""

from __future__ import annotations

import argparse
import importlib
import json
from pathlib import Path
import subprocess
import tempfile


def typescript_template(config: Path, plugin: Path, output: Path) -> dict:
    """Keep the authoritative plugin options, adapting its executable and output to the action sandbox."""
    yaml = importlib.import_module("yaml")
    template = yaml.safe_load(config.read_text(encoding="utf-8"))
    if set(template) != {"version", "plugins"} or template["version"] != "v2" or len(template["plugins"]) != 1:
        raise ValueError("Bazel generation requires the current v2 single-plugin buf.gen.yaml")
    configured = template["plugins"][0]
    if configured.get("local") != ["node", "node_modules/@bufbuild/protoc-gen-es/bin/protoc-gen-es"] or configured.get("out") != "ts":
        raise ValueError("buf.gen.yaml must use the pinned local protobuf-es plugin and the ts package output")
    template["plugins"] = [{**configured, "local": str(plugin.resolve()), "out": str(output)}]
    return template


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--format", choices=("ts", "python", "schema"), required=True)
    parser.add_argument("--package", required=True)
    parser.add_argument("--buf", type=Path, required=True)
    parser.add_argument("--plugin", type=Path)
    parser.add_argument("--config", type=Path)
    parser.add_argument("--wire-runtime")
    parser.add_argument("--schema-identity")
    parser.add_argument("--schema-title", default="")
    parser.add_argument("--schema-root", default="")
    parser.add_argument("--descriptor", type=Path, action="append", default=[])
    parser.add_argument("--source", action="append", default=[])
    parser.add_argument("--output", action="append", default=[])
    args = parser.parse_args()
    buf = str(args.buf.resolve())
    with tempfile.TemporaryDirectory(prefix="proto-codegen-") as temporary:
        root = Path(temporary)
        descriptor = root / "image.binpb"
        # Each proto_library descriptor set owns only its direct sources. Concatenating
        # their repeated FileDescriptorProto fields produces the whole import closure.
        descriptor.write_bytes(b"".join(path.read_bytes() for path in args.descriptor))
        image_input = f"{descriptor}#format=binpb"
        image = json.loads(subprocess.check_output([buf, "build", image_input, "-o", "-#format=json"]))
        packages = {args.package}
        if args.format == "ts":
            assert args.plugin is not None and args.config is not None
            template = typescript_template(args.config, args.plugin, root / "ts")
            command = [buf, "generate", image_input, "--template", json.dumps(template)]
            for source in args.source:
                command += ["--path", source]
            subprocess.run(command, check=True)
            generated = {
                path.relative_to(root / "ts").as_posix(): path.read_text(encoding="utf-8")
                for path in (root / "ts").rglob("*.ts")
            }
            if any(mapping.split("=", 1)[0].endswith("_wire.ts") for mapping in args.output):
                generated.update(
                    importlib.import_module("gen_wire_ts").generate(image, packages, wire_runtime=args.wire_runtime)
                )
        elif args.format == "python":
            generated = importlib.import_module("gen_py").generate(image, packages)
        else:
            # Published $defs retain their existing file order even when this
            # package is compiled without the rest of the module's import graph.
            order = {source: index for index, source in enumerate(args.source)}
            image["file"].sort(key=lambda file: (order.get(file["name"], len(order)), file["name"]))
            generator = importlib.import_module("gen_schema")
            targets = None
            if args.schema_identity is not None:
                if len(args.output) != 1:
                    raise ValueError("An explicit schema target requires exactly one output")
                path = args.output[0].split("=", 1)[0]
                targets = (
                    generator.Target(args.package, path, args.schema_identity, args.schema_title, root=args.schema_root),
                )
            generated = generator.generate(image, packages, targets=targets)
        for mapping in args.output:
            name, destination = mapping.split("=", 1)
            target = Path(destination)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(generated[name], encoding="utf-8", newline="\n")


if __name__ == "__main__":
    main()

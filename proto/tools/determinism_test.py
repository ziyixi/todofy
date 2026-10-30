"""Run the canonical generators twice and compare their bytes with the Bazel materialized modules."""

import argparse
import json
import os
import subprocess
import tempfile
from pathlib import Path

import gen_py
import gen_schema
import gen_wire_ts
from bazel_codegen import typescript_template

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--buf", type=Path, required=True)
    parser.add_argument("--plugin", type=Path, required=True)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--image", type=Path, required=True)
    parser.add_argument("--google-rpc-image", type=Path, required=True)
    parser.add_argument("--materialized", type=Path, required=True)
    args = parser.parse_args()
    os.environ.setdefault("BAZEL_BINDIR", ".")
    os.environ["JS_BINARY__NO_CD_BINDIR"] = "1"
    image = json.loads(subprocess.check_output([str(args.buf), "build", str(args.image), "-o", "-#format=json"]))
    runs = []
    with tempfile.TemporaryDirectory(prefix="proto-determinism-") as temporary:
        # The runtime fixture marks every Google file as an import. Package codegen receives raw
        # FileDescriptorSets, so promote the same three google.rpc sources for this comparison.
        rpc = json.loads(args.google_rpc_image.read_text())
        for file in rpc["file"]:
            file["bufExtension"]["isImport"] = not file["name"].startswith("google/rpc/")
        rpc_image = Path(temporary) / "rpc.json"
        rpc_image.write_text(json.dumps(rpc))
        for index in range(2):
            output = Path(temporary) / str(index)
            template = typescript_template(args.config, args.plugin, output)
            subprocess.run([str(args.buf), "generate", str(args.image), "--template", json.dumps(template)], check=True)
            subprocess.run(
                [str(args.buf), "generate", str(rpc_image) + "#format=json", "--template", json.dumps(template)],
                check=True,
            )
            generated = {"ts/" + path.relative_to(output).as_posix(): path.read_text() for path in output.rglob("*.ts")}
            generated.update({"ts/" + name: text for name, text in gen_wire_ts.generate(image).items()})
            generated.update({"py/" + name: text for name, text in gen_py.generate(image).items()})
            generated.update({"schema/" + Path(name).name: text for name, text in gen_schema.generate(image).items()})
            runs.append(generated)
    if runs[0] != runs[1]:
        raise SystemExit("Identical generator inputs produced different bytes")
    count = 0
    for path in args.materialized.rglob("*"):
        if path.is_file() and path.name != "manifest.json":
            name = path.relative_to(args.materialized).as_posix()
            if path.read_text() != runs[0].get(name):
                raise SystemExit(f"{name}: materialized bytes differ from the canonical generator")
            count += 1
    print(f"{count} materialized modules match two canonical generator runs")

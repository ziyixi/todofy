"""Assemble a Buf image from explicit proto_library descriptors without network access."""

import argparse
import json
from pathlib import Path
import subprocess
import tempfile


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--buf", type=Path, required=True)
    parser.add_argument("--descriptor", type=Path, action="append", default=[])
    parser.add_argument("--source", action="append", default=[])
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    buf = str(args.buf.resolve())
    with tempfile.TemporaryDirectory(prefix="proto-image-") as temporary:
        root = Path(temporary)
        descriptor = root / "descriptors.binpb"
        descriptor.write_bytes(b"".join(path.read_bytes() for path in args.descriptor))
        image = json.loads(subprocess.check_output([buf, "build", f"{descriptor}#format=binpb", "-o", "-#format=json"]))
        sources = set(args.source)
        for file in image["file"]:
            file.setdefault("bufExtension", {})["isImport"] = file["name"] not in sources
        converted = root / "image.json"
        converted.write_text(json.dumps(image), encoding="utf-8")
        output = str(args.out) + ("#format=json" if args.out.suffix == ".json" else "")
        subprocess.run([buf, "build", f"{converted}#format=json", "-o", output], check=True)

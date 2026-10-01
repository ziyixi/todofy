"""PEP 517 build backend of ``ziyixi-proto`` (proto/README.md, How it works). Standard library only.

uv builds this local package whenever it installs it (``uv sync``, ``uv run``) and rebuilds it when one of
the ``[tool.uv] cache-keys`` in pyproject.toml changes. Every build first makes the generated modules under
src/ziyixi_proto/ current, then only packages files:

- ``build_wheel`` (``uv sync`` in an app, ``pywrangler sync`` vendoring it into a Python Worker): a
  wheel with a copy of src/ziyixi_proto, generated modules included.
- ``build_editable`` (only for an explicit editable install, ``uv pip install -e proto/python``): a wheel
  with one ``.pth`` file that puts src/ on sys.path.

"Current" means the stamp proto/tools/ensure.mjs writes (proto/.generated.json) matches the inputs and the
generated files. This module checks the stamp itself, hashing exactly as ensure.mjs does, and runs
ensure.mjs (Node.js) only when it does not match. That matters for pywrangler: it builds the wheel inside
Pyodide, which cannot start processes, after ``uv sync`` on the host has already generated everything.
The wheels are reproducible (fixed timestamps, sorted entries).
"""

import base64
import hashlib
import json
import os
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

NAME = "ziyixi_proto"
VERSION = "0.0.0"
HERE = Path(__file__).resolve().parent
PROTO = HERE.parent
SRC = HERE / "src"
ENSURE = PROTO / "tools" / "ensure.mjs"
STAMP = PROTO / ".generated.json"
# The output roots of ensure.mjs: every directory directly inside them is generated.
TARGETS = (PROTO / "ts", SRC / NAME)
STAMP_VERSION = 1
TAG = "py3-none-any"
# 1980-01-01, the earliest time a zip entry can carry: the same input gives the same bytes.
EPOCH = (1980, 1, 1, 0, 0, 0)


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _proto_files(excluded: set[str]) -> list[str]:
    """Every .proto file of the module, relative to proto/ (ensure.mjs protoFiles)."""
    found = []
    for directory, subdirectories, files in os.walk(PROTO):
        top = Path(directory) == PROTO
        subdirectories[:] = [d for d in subdirectories if not d.startswith(".") and not (top and d in excluded)]
        relative = Path(directory).relative_to(PROTO).parts
        found += ["/".join((*relative, name)) for name in files if name.endswith(".proto") and not name.startswith(".")]
    return sorted(found)


def _generated_files() -> dict[str, str]:
    """Relative path -> sha256 of every generated file (ensure.mjs outputsHashes)."""
    found = {}
    for root in TARGETS:
        if not root.is_dir():
            continue
        for path in root.rglob("*"):
            relative = path.relative_to(root).parts
            if path.is_file() and len(relative) > 1 and "__pycache__" not in relative:
                found[path.relative_to(PROTO).as_posix()] = _sha256(path.read_bytes())
    return found


def is_current() -> bool:
    """True when the stamp matches every input and every generated file (ensure.mjs isCurrent)."""
    try:
        stamp = json.loads(STAMP.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    if not isinstance(stamp, dict) or stamp.get("version") != STAMP_VERSION:
        return False
    digest = hashlib.sha256()
    try:
        for name in [*_proto_files(set(stamp["excluded"])), *stamp["input_files"]]:
            digest.update(f"{name}\0".encode())
            digest.update((PROTO / name).read_bytes())
            digest.update(b"\0")
    except (KeyError, OSError, TypeError):
        return False
    outputs = stamp.get("outputs")
    return digest.hexdigest() == stamp.get("inputs") and bool(outputs) and outputs == _generated_files()


def _ensure_generated() -> None:
    if is_current():
        return
    if sys.platform == "emscripten":
        raise RuntimeError(
            "ziyixi-proto: the generated code is not current and Pyodide cannot run proto/tools/ensure.mjs; "
            "run `npm run ensure` in proto/ on the host, then retry"
        )
    node = shutil.which("node")
    if node is None:
        raise RuntimeError("ziyixi-proto: Node.js is not on PATH; it runs proto/tools/ensure.mjs (proto/README.md)")
    # gen_py.py runs on this interpreter; ensure.mjs logs to stderr, which uv shows when a build fails.
    env = dict(os.environ, PROTO_PYTHON=sys.executable)
    subprocess.run([node, str(ENSURE)], check=True, env=env, stdout=sys.stderr)
    if not is_current():
        raise RuntimeError("ziyixi-proto: proto/tools/ensure.mjs ran but its stamp does not match")


def _metadata() -> str:
    return (
        "Metadata-Version: 2.1\n"
        f"Name: {NAME.replace('_', '-')}\n"
        f"Version: {VERSION}\n"
        "Summary: Generated wire JSON types of the proto/ IDL and their stdlib-only codec\n"
        "Requires-Python: >=3.12\n"
    )


def _record_line(path: str, data: bytes) -> str:
    digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode()
    return f"{path},sha256={digest},{len(data)}"


def _package_files() -> list[tuple[str, bytes]]:
    files = []
    for path in sorted((SRC / NAME).rglob("*.py")):
        if "__pycache__" not in path.parts:
            files.append((path.relative_to(SRC).as_posix(), path.read_bytes()))
    return files


def _write_wheel(directory: str, files: list[tuple[str, bytes]]) -> str:
    dist_info = f"{NAME}-{VERSION}.dist-info"
    wheel_file = f"Wheel-Version: 1.0\nGenerator: proto/python/build_backend.py\nRoot-Is-Purelib: true\nTag: {TAG}\n"
    entries = [*files, (f"{dist_info}/METADATA", _metadata().encode()), (f"{dist_info}/WHEEL", wheel_file.encode())]
    record = "".join(f"{_record_line(path, data)}\n" for path, data in entries) + f"{dist_info}/RECORD,,\n"
    entries.append((f"{dist_info}/RECORD", record.encode()))
    name = f"{NAME}-{VERSION}-{TAG}.whl"
    with zipfile.ZipFile(Path(directory) / name, "w") as wheel:
        for path, data in entries:
            info = zipfile.ZipInfo(path, date_time=EPOCH)
            info.external_attr = 0o644 << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            wheel.writestr(info, data)
    return name


def get_requires_for_build_wheel(config_settings=None):
    return []


def get_requires_for_build_editable(config_settings=None):
    return []


def build_wheel(wheel_directory, config_settings=None, metadata_directory=None):
    _ensure_generated()
    return _write_wheel(wheel_directory, _package_files())


def build_editable(wheel_directory, config_settings=None, metadata_directory=None):
    _ensure_generated()
    # A plain path line: Python, pytest and static analysers (Pylance, pyright) all follow it.
    return _write_wheel(wheel_directory, [(f"_{NAME}_editable.pth", f"{SRC}\n".encode())])

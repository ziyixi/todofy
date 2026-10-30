"""PEP 517 build backend of ``ziyixi-proto`` (proto/README.md, How it works). Standard library only.

uv builds this local package whenever it installs it (``uv sync``, ``uv run``) and rebuilds it when one of
the ``[tool.uv] cache-keys`` in pyproject.toml changes. Every build first makes the generated modules under
src/ziyixi_proto/ current, then only packages files:

- ``build_wheel`` (``uv sync`` in an app, ``pywrangler sync`` vendoring it into a Python Worker): a
  wheel with a copy of src/ziyixi_proto, generated modules included, except the packages only proto/'s own
  tests use (TEST_ONLY_PACKAGES: the runtimes' fixtures), which never reach a Worker.
- ``build_editable`` (only for an explicit editable install, ``uv pip install -e proto/python``): a wheel
  with one ``.pth`` file that puts src/ on sys.path.

Host builds materialize the canonical Bazel outputs through proto/tools/ensure.mjs. Pyodide cannot start
processes, so its build verifies the materialized input and output hashes supplied by the host instead.
The wheels are reproducible (fixed timestamps, sorted entries).
"""

import base64
import hashlib
import json
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
STAMP_VERSION = 2
TAG = "py3-none-any"
# Generated top-level packages that are test fixtures (tools/gen_py.py PYTHON_PACKAGES marks them False):
# generated for proto/test/python, never put in the wheel.
TEST_ONLY_PACKAGES = ("prototest",)
# 1980-01-01, the earliest time a zip entry can carry: the same input gives the same bytes.
EPOCH = (1980, 1, 1, 0, 0, 0)


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _generated_files() -> dict[str, str]:
    """Relative path -> sha256 of the materialized modules, excluding installed dependencies."""
    found = {}
    for root in TARGETS:
        if not root.is_dir():
            continue
        for path in root.rglob("*"):
            relative = path.relative_to(root).parts
            if path.is_file() and len(relative) > 1 and not {"__pycache__", "node_modules"}.intersection(relative):
                found[path.relative_to(PROTO).as_posix()] = _sha256(path.read_bytes())
    return found


def is_current() -> bool:
    """True when the Bazel manifest matches its declared inputs and every materialized module."""
    try:
        stamp = json.loads(STAMP.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    if not isinstance(stamp, dict) or stamp.get("version") != STAMP_VERSION:
        return False
    try:
        inputs = stamp["inputs"]
        if not isinstance(inputs, dict) or not inputs:
            return False
        if any(_sha256((PROTO / name).read_bytes()) != expected for name, expected in inputs.items()):
            return False
    except (KeyError, OSError, TypeError):
        return False
    outputs = stamp.get("outputs")
    return bool(outputs) and outputs == _generated_files()


def _ensure_generated() -> None:
    if sys.platform == "emscripten":
        if is_current():
            return
        raise RuntimeError(
            "ziyixi-proto: the generated code is not current and Pyodide cannot run proto/tools/ensure.mjs; "
            "run `npm run ensure` in proto/ on the host, then retry"
        )
    node = shutil.which("node")
    if node is None:
        raise RuntimeError("ziyixi-proto: Node.js is not on PATH; it runs proto/tools/ensure.mjs (proto/README.md)")
    subprocess.run([node, str(ENSURE)], check=True, stdout=sys.stderr)
    if not is_current():
        raise RuntimeError("ziyixi-proto: proto/tools/ensure.mjs ran but its stamp does not match")


def _metadata() -> str:
    return (
        "Metadata-Version: 2.1\n"
        f"Name: {NAME.replace('_', '-')}\n"
        f"Version: {VERSION}\n"
        "Summary: Generated wire JSON types of the proto/ IDL and their stdlib-only codec\n"
        "Requires-Python: >=3.14\n"
    )


def _record_line(path: str, data: bytes) -> str:
    digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode()
    return f"{path},sha256={digest},{len(data)}"


def _package_files(src: Path = SRC) -> list[tuple[str, bytes]]:
    """(wheel path, bytes) of every module the wheel ships: the package without __pycache__ and test fixtures."""
    files = []
    for path in sorted((src / NAME).rglob("*.py")):
        parts = path.relative_to(src / NAME).parts
        if "__pycache__" not in parts and parts[0] not in TEST_ONLY_PACKAGES:
            files.append((path.relative_to(src).as_posix(), path.read_bytes()))
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

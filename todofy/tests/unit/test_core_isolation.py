"""core/ must run on host CPython: stdlib and relative imports only, plus ``ziyixi_proto`` (the generated wire
JSON types of the proto/ IDL, proto/README.md), which is itself stdlib only."""

import ast
import sys
from pathlib import Path

import pytest
import ziyixi_proto

CORE = Path(__file__).parents[2] / "worker" / "todofy" / "core"
PROTO = Path(ziyixi_proto.__file__).parent
# The one package core/ may import besides the standard library: [project] dependencies has nothing else.
ALLOWED = {"ziyixi_proto"}


def _roots(path: Path) -> list[str]:
    roots = []
    for node in ast.walk(ast.parse(path.read_text())):
        if isinstance(node, ast.Import):
            roots += [alias.name.split(".")[0] for alias in node.names]
        elif isinstance(node, ast.ImportFrom) and node.level == 0:
            roots.append((node.module or "").split(".")[0])
    return roots


@pytest.mark.parametrize("path", sorted(CORE.rglob("*.py")), ids=lambda p: str(p.relative_to(CORE)))
def test_core_imports_only_the_standard_library(path):
    for root in _roots(path):
        assert root in sys.stdlib_module_names | ALLOWED, f"{path} imports {root}"


@pytest.mark.parametrize("path", sorted(PROTO.rglob("*.py")), ids=lambda p: str(p.relative_to(PROTO)))
def test_the_generated_package_imports_only_the_standard_library(path):
    """The installed ziyixi_proto (hand-written codec and generated modules) is what pywrangler vendors."""
    for root in _roots(path):
        assert root in sys.stdlib_module_names | ALLOWED, f"{path} imports {root}"

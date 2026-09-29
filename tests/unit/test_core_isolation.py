"""core/ must run on host CPython: stdlib and relative imports only."""

import ast
import sys
from pathlib import Path

import pytest

CORE = Path(__file__).parents[2] / "worker" / "todofy" / "core"


@pytest.mark.parametrize("path", sorted(CORE.rglob("*.py")), ids=lambda p: str(p.relative_to(CORE)))
def test_core_imports_only_the_standard_library(path):
    for node in ast.walk(ast.parse(path.read_text())):
        if isinstance(node, ast.Import):
            roots = [alias.name.split(".")[0] for alias in node.names]
        elif isinstance(node, ast.ImportFrom) and node.level == 0:
            roots = [(node.module or "").split(".")[0]]
        else:
            continue
        for root in roots:
            assert root in sys.stdlib_module_names, f"{path} imports {root}"

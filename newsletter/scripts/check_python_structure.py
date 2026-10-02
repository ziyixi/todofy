"""Check a few explicit Google-style and repository dependency boundaries.

This is deliberately not an import resolver or a general-purpose linter.
It parses source without importing application code or third-party packages.
"""

import ast
from collections.abc import Iterable
import dataclasses
import pathlib

_DIRECT_IMPORTS = frozenset(
    {
        "typing",
        "typing_extensions",
        "collections.abc",
        "__future__",
    }
)
_EXTERNAL_MODULES = frozenset(
    {
        "ziyixi_protos.newsletter.editorial_pb2",
        "google.protobuf.message",
        "google.protobuf.json_format",
        "fastapi.responses",
        "fastapi.testclient",
    }
)
# This bootstrap runs under -I without package imports; only its public
# composition module and dedicated launch-boundary tests may bridge into it.
_PRIVATE_BRIDGES = {
    "src/newsletter/codex_runtime.py": {"newsletter._codex_runtime"},
    "tests/test_codex_runtime.py": {"newsletter._codex_runtime"},
}


@dataclasses.dataclass(frozen=True)
class Finding:
    """One deterministic source location and its violated project rule."""

    line: int
    code: str
    detail: str


def module_names(root: pathlib.Path) -> set[str]:
    """Index only repository Python modules, without executing imports."""
    names = set(_EXTERNAL_MODULES)
    for prefix in (root / "src", root):
        folders = (
            (prefix / "newsletter",)
            if prefix.name == "src"
            else (
                prefix / "tests",
                prefix / "scripts",
            )
        )
        for folder in folders:
            for path in folder.rglob("*.py"):
                parts = list(path.relative_to(prefix).with_suffix("").parts)
                if parts[-1] == "__init__":
                    parts.pop()
                names.add(".".join(parts))
    return names


def _import_findings(
    node: ast.Import | ast.ImportFrom, modules: set[str], filename: str
) -> Iterable[Finding]:
    origin = ""
    if isinstance(node, ast.ImportFrom):
        origin = node.module or ""
    for name in node.names:
        target = f"{origin}.{name.name}" if origin else name.name
        if any(part.startswith("test_") for part in target.split(".")):
            yield Finding(
                node.lineno,
                "BOUNDARY",
                "import tests/support, not test modules",
            )
        private = any(
            part.startswith("_") and part != "__future__"
            for part in target.split(".")
        )
        if private and target not in _PRIVATE_BRIDGES.get(filename, set()):
            yield Finding(
                node.lineno,
                "PRIVATE_IMPORT",
                "private name belongs to its module",
            )
        if (
            isinstance(node, ast.ImportFrom)
            and origin not in _DIRECT_IMPORTS
            and (node.level or target not in modules)
        ):
            yield Finding(
                node.lineno,
                "MODULE_IMPORT",
                "import a module, not its objects",
            )
        if (
            filename.startswith("src/newsletter/")
            and filename
            not in {
                "src/newsletter/app.py",
                "src/newsletter/cli.py",
            }
            and (
                target in {"newsletter.app", "newsletter.cli"}
                or origin in {"newsletter.app", "newsletter.cli"}
            )
        ):
            yield Finding(
                node.lineno, "LAYER", "core must not import HTTP or CLI"
            )


def _base_exception_names(tree: ast.Module) -> set[str]:
    """Resolve only explicit builtins imports used in exception clauses."""
    names = {"BaseException", "builtins.BaseException"}
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name == "builtins":
                    names.add(f"{alias.asname or alias.name}.BaseException")
        elif isinstance(node, ast.ImportFrom) and node.module == "builtins":
            for alias in node.names:
                if alias.name == "BaseException":
                    names.add(alias.asname or alias.name)
    return names


def inspect_source(
    source: str, *, filename: str, modules: set[str]
) -> list[Finding]:
    """Return violations of the documented structural subset."""
    findings: list[Finding] = []
    tree = ast.parse(source, filename=filename)
    base_exception_names = _base_exception_names(tree)
    for node in ast.walk(tree):
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            findings.extend(_import_findings(node, modules, filename))
        elif isinstance(node, ast.IfExp):
            if any(
                isinstance(child, ast.IfExp)
                for child in ast.walk(node)
                if child is not node
            ):
                findings.append(
                    Finding(
                        node.lineno, "NESTED_TERNARY", "use explicit branches"
                    )
                )
        elif isinstance(node, ast.ExceptHandler):
            if node.type is None:
                findings.append(
                    Finding(
                        node.lineno, "BARE_EXCEPT", "name expected exceptions"
                    )
                )
            elif base_exception_names & {
                ast.unparse(item)
                for item in ast.walk(node.type)
                if isinstance(item, (ast.Name, ast.Attribute))
            }:
                tail = node.body[-1]
                if (
                    not isinstance(tail, ast.Raise)
                    or tail.exc is not None
                    or any(
                        isinstance(item, (ast.Return, ast.Break, ast.Continue))
                        for statement in node.body
                        for item in ast.walk(statement)
                    )
                ):
                    findings.append(
                        Finding(
                            node.lineno,
                            "BASE_EXCEPTION",
                            "cleanup must unconditionally re-raise",
                        )
                    )
    return findings


def main() -> int:
    """Check hand-written Python and report safe, relative source locations."""
    root = pathlib.Path(__file__).resolve().parents[1]
    modules = module_names(root)
    failed = False
    for folder in ("src", "scripts", "tests"):
        for path in sorted((root / folder).rglob("*.py")):
            relative = path.relative_to(root).as_posix()
            for item in inspect_source(
                path.read_text(encoding="utf-8"),
                filename=relative,
                modules=modules,
            ):
                print(f"{relative}:{item.line}: {item.code} {item.detail}")
                failed = True
    return int(failed)


if __name__ == "__main__":
    raise SystemExit(main())

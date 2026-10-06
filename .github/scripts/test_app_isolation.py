"""Apps never import one another: python3 -m unittest discover -s .github/scripts

Root AGENTS.md: an app imports only its own code and the shared code in proto/ (the npm package @ziyixi/proto and the
Python package ziyixi-proto), contracts/ and packages/. tools/ is test, build and deploy tooling: an app's tests and
its build and deploy scripts may import it, the sources it ships never do. That is also what lets a tools/ change
deploy nothing (ci_changes.classify). The website is stricter: of the shared code it uses only proto/.

For every app of the service catalog this resolves
- the relative imports of its TypeScript and JavaScript files (static, re-export, side-effect, dynamic, require),
- the paths its Python files add to sys.path or load with importlib's spec_from_file_location, and
- the local dependencies of its package.json files (file:, link:), the "paths" and "extends" of its tsconfig files
  and the path sources and workspace members of its pyproject.toml files,
and requires every target to lie in the app itself or in a directory the app may use. A bare npm specifier resolves
to an installed package, so the package.json and tsconfig checks cover it. Needs Python 3.11+ (tomllib), as CI's
ubuntu-24.04 python3 has; standard library only.
"""

import ast
import json
import os
import re
import subprocess
import sys
import unittest
from pathlib import Path, PurePosixPath

try:
    import tomllib
except ModuleNotFoundError:
    if os.environ.get("GITHUB_ACTIONS") == "true":
        raise
    raise unittest.SkipTest(
        f"test_app_isolation needs Python 3.11+ (tomllib), this is {sys.version.split()[0]}: "
        "uv run --no-project --python 3.12 python -m unittest discover -s .github/scripts"
    ) from None

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "tools" / "service-catalog"))
from catalog import load_catalog  # noqa: E402

APPS = tuple(load_catalog(REPO).apps)
SHARED = {"proto", "contracts", "packages"}
# The website's own boundary (docs/architecture.md, Website): no contract and no shared package.
SHARED_FOR = {"website": {"proto"}}
TOOLS = "tools"
# Directories whose files never reach a bundle or an image: only these may import tools/.
NOT_SHIPPED = {"test", "tests", "__tests__", "scripts", "deploy"}
SCRIPT_SUFFIXES = {".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"}

# A relative specifier after `from`, `import`, `import(` or `require(`.
JS_IMPORT = re.compile(r"""(?:\bfrom|\bimport|\brequire)\s*\(?\s*['"](\.{1,2}/[^'"\n]*)['"]""")
PATH_CALLS = {"Path", "pathlib.Path", "str", "os.fspath", "os.path.abspath", "os.path.realpath"}
JSON_STRING = r'"(?:\\.|[^"\\])*"'


def tracked_files() -> list[PurePosixPath]:
    """Committed and new (not ignored) files, so generated code and node_modules are never read."""
    out = subprocess.run(
        ["git", "-C", str(REPO), "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
        check=True,
        capture_output=True,
    ).stdout.decode()
    return [PurePosixPath(name) for name in out.split("\0") if name and (REPO / name).is_file()]


def js_imports(text: str) -> list[str]:
    return JS_IMPORT.findall(text)


class Unresolved(Exception):
    """A path expression this static reader does not follow."""


class Unanchored(Exception):
    """A path built from a function parameter, such as pytest's tmp_path."""


PARAMETER, OPAQUE = object(), object()


def python_paths(source: str, file: Path) -> list[Path]:
    """Every path a module adds to sys.path or loads with spec_from_file_location.

    Names are followed in source order within their scope (ROOT = Path(__file__).resolve().parents[2], or
    ROOT: Path = ..., then path /= "x"). A path built from a function parameter (pytest's tmp_path) is not the
    module's own reach and is skipped. Any other form, a name bound by a tuple, for, with or import among them, raises
    Unresolved, so a new way of reaching another directory is looked at instead of passing silently.
    """

    def constant(node: ast.expr) -> str:
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            return node.value
        raise Unresolved(ast.unparse(node))

    def evaluate(node: ast.expr, scope: dict, depth: int = 0) -> Path:
        if depth > 50:
            raise Unresolved(ast.unparse(node))
        if isinstance(node, ast.Name):
            if node.id == "__file__":
                return file
            bound = scope.get(node.id, OPAQUE)
            if bound is PARAMETER:
                raise Unanchored(node.id)
            if bound is OPAQUE:
                raise Unresolved(node.id)
            return evaluate(bound, scope, depth + 1)
        if isinstance(node, ast.Call):
            function = ast.unparse(node.func)
            if function in PATH_CALLS and len(node.args) == 1:
                return evaluate(node.args[0], scope, depth + 1)
            if function == "os.path.dirname" and len(node.args) == 1:
                return evaluate(node.args[0], scope, depth + 1).parent
            if function == "os.path.join" and node.args:
                return evaluate(node.args[0], scope, depth + 1).joinpath(*map(constant, node.args[1:]))
            if isinstance(node.func, ast.Attribute):
                base, method = node.func.value, node.func.attr
                if method in {"resolve", "absolute"} and not node.args:
                    return evaluate(base, scope, depth + 1)
                if method == "with_name" and len(node.args) == 1:
                    return evaluate(base, scope, depth + 1).with_name(constant(node.args[0]))
                if method == "joinpath":
                    return evaluate(base, scope, depth + 1).joinpath(*map(constant, node.args))
        if isinstance(node, ast.Attribute) and node.attr == "parent":
            return evaluate(node.value, scope, depth + 1).parent
        if isinstance(node, ast.Subscript) and isinstance(node.value, ast.Attribute) and node.value.attr == "parents":
            if isinstance(node.slice, ast.Constant) and isinstance(node.slice.value, int):
                return evaluate(node.value.value, scope, depth + 1).parents[node.slice.value]
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Div):
            return evaluate(node.left, scope, depth + 1) / constant(node.right)
        raise Unresolved(ast.unparse(node))

    found: list[Path] = []

    class Reader(ast.NodeVisitor):
        def __init__(self):
            # A name maps to the expression it was last assigned, PARAMETER or OPAQUE; a missing name is OPAQUE.
            self.scope: dict[str, object] = {}

        def visit_FunctionDef(self, node):
            outer = self.scope
            # Closures see the module's names; parameters shadow them with an unknown value.
            self.scope = {**outer, **{arg.arg: PARAMETER for arg in ast.walk(node.args) if isinstance(arg, ast.arg)}}
            self.generic_visit(node)
            self.scope = outer

        visit_AsyncFunctionDef = visit_FunctionDef
        visit_Lambda = visit_FunctionDef

        # Any binding not followed below (a tuple target, for, with, an import) leaves its names OPAQUE.
        def visit_Name(self, node):
            if isinstance(node.ctx, ast.Store):
                self.scope[node.id] = OPAQUE

        def visit_alias(self, node):
            self.scope[node.asname or node.name.split(".")[0]] = OPAQUE

        def visit_Assign(self, node):
            self.generic_visit(node)
            for target in node.targets:
                if isinstance(target, ast.Name):
                    self.scope[target.id] = node.value

        def visit_AnnAssign(self, node):
            self.generic_visit(node)
            if isinstance(node.target, ast.Name) and node.value:
                self.scope[node.target.id] = node.value

        visit_NamedExpr = visit_AnnAssign

        def visit_AugAssign(self, node):
            previous = self.scope.get(node.target.id, OPAQUE) if isinstance(node.target, ast.Name) else OPAQUE
            self.generic_visit(node)
            if isinstance(previous, ast.expr):
                self.scope[node.target.id] = ast.BinOp(previous, node.op, node.value)
            elif isinstance(node.target, ast.Name):
                self.scope[node.target.id] = previous

        def visit_Call(self, node):
            self.generic_visit(node)
            function = ast.unparse(node.func)
            if function == "sys.path.insert" and len(node.args) == 2:
                argument = node.args[1]
            elif function == "sys.path.append" and len(node.args) == 1:
                argument = node.args[0]
            elif function.endswith("spec_from_file_location") and len(node.args) >= 2:
                argument = node.args[1]
            else:
                return
            try:
                found.append(Path(os.path.normpath(evaluate(argument, self.scope))))
            except Unanchored:
                pass

    Reader().visit(ast.parse(source))
    return found


def violation(app: str, importer: PurePosixPath, target: Path) -> str | None:
    """Why `importer` (repository-relative, inside `app`) may not reach `target` (absolute), or None."""
    if not target.is_relative_to(REPO):
        return "leaves the repository"
    parts = target.relative_to(REPO).parts
    top = parts[0] if parts else ""
    if top == app or top in SHARED_FOR.get(app, SHARED):
        return None
    if top == TOOLS:
        return None if NOT_SHIPPED & set(importer.parts[1:-1]) else "ships, so it may not import tools/"
    return f"reaches {top or 'the repository root'}/"


def jsonc(text: str) -> dict:
    """tsconfig files are JSON with comments and trailing commas; strings such as "@/*" stay as they are."""
    text = re.sub(rf"({JSON_STRING})|/\*.*?\*/|//[^\n]*", lambda m: m.group(1) or "", text, flags=re.DOTALL)
    return json.loads(re.sub(rf"({JSON_STRING})|,(\s*[}}\]])", lambda m: m.group(1) or m.group(2), text))


def local_dependencies(name: PurePosixPath) -> list[tuple[str, Path]]:
    """(what, absolute target) of every local dependency, path alias or extended config a manifest declares."""
    path = REPO / name
    found = []
    if name.name == "package.json":
        data = json.loads(path.read_text())
        for section in ("dependencies", "devDependencies", "optionalDependencies", "peerDependencies"):
            for package, spec in data.get(section, {}).items():
                local = re.fullmatch(r"(?:file|link):(.+)", spec)
                if local:
                    found.append((package, path.parent / local.group(1)))
    elif re.fullmatch(r"tsconfig[\w.-]*\.json", name.name):
        data = jsonc(path.read_text())
        options = data.get("compilerOptions", {})
        base = path.parent / options.get("baseUrl", ".")
        for alias, targets in options.get("paths", {}).items():
            found += [(alias, base / target) for target in targets]
        extends = data.get("extends", [])
        for extended in [extends] if isinstance(extends, str) else extends:
            if extended.startswith("."):
                found.append(("extends", path.parent / extended))
    elif name.name == "pyproject.toml":
        uv = tomllib.loads(path.read_text()).get("tool", {}).get("uv", {})
        for package, source in uv.get("sources", {}).items():
            if isinstance(source, dict) and "path" in source:
                found.append((package, path.parent / source["path"]))
        found += [("workspace", path.parent / member) for member in uv.get("workspace", {}).get("members", [])]
    return [(what, Path(os.path.normpath(target))) for what, target in found]


class AppIsolation(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.files = [name for name in tracked_files() if name.parts[0] in APPS]
        cls.script_imports = {}
        for name in cls.files:
            if name.suffix in SCRIPT_SUFFIXES:
                path = REPO / name
                specifiers = js_imports(path.read_text(errors="ignore"))
                cls.script_imports[name] = [Path(os.path.normpath(path.parent / s)) for s in specifiers]

    def assertAllowed(self, importer: PurePosixPath, target: Path, verb: str):
        reason = violation(importer.parts[0], importer, target)
        if reason:
            self.fail(f"{importer} {verb} {os.path.relpath(target, REPO)}, which {reason}")

    def test_scripts_import_only_their_app_and_the_shared_code(self):
        for name, targets in self.script_imports.items():
            for target in targets:
                with self.subTest(file=str(name), target=str(target)):
                    self.assertAllowed(name, target, "imports")
        # A pattern that silently matched nothing would pass the loop above.
        self.assertGreater(sum(map(len, self.script_imports.values())), 500)

    def test_only_tests_and_scripts_import_a_tool(self):
        """The apps' CPU tests and bundle budgets do import tools/ (the scan sees them), and each target exists."""
        importers = {
            str(name): [target for target in targets if target.is_relative_to(REPO / TOOLS)]
            for name, targets in self.script_imports.items()
        }
        for name in (
            "lab/worker/test/runtime/cpu.test.ts",
            "flowday/worker/test/runtime/cpu.test.ts",
            "mail-hero/cloudflare/test/cpu/native-ops-cpu.test.mjs",
            "dashboard/worker/test/runtime/cpu.test.ts",
            "lab/deploy/bundle-size.mjs",
            "lab/web/scripts/js-budget.mjs",
            "flowday/worker/scripts/bundle-size.mjs",
            "flowday/web/scripts/js-budget.mjs",
            "mail-hero/deploy/bundle-size.mjs",
            "dashboard/deploy/bundle-size.mjs",
        ):
            self.assertTrue(importers.get(name), name)
        for name, targets in importers.items():
            for target in targets:
                with self.subTest(file=name, target=str(target)):
                    self.assertTrue(target.is_file())

    def test_python_reaches_only_its_app_and_the_shared_code(self):
        reached = set()
        for name in self.files:
            if name.suffix != ".py":
                continue
            path = REPO / name
            with self.subTest(file=str(name)):
                try:
                    targets = python_paths(path.read_text(), path)
                except Unresolved as error:
                    self.fail(f"{name}: cannot follow {error}; build the path from Path(__file__) and string parts")
                for target in targets:
                    self.assertAllowed(name, target, "loads")
                    reached.add(target.relative_to(REPO).as_posix())
        # The website relay's secret retirement uses the shared release tooling (a deploy script).
        self.assertIn("tools/cloud-release", reached)

    def test_local_dependencies_are_the_shared_code(self):
        declared = 0
        for name in self.files:
            for what, target in local_dependencies(name):
                with self.subTest(file=str(name), dependency=what):
                    self.assertAllowed(name, target, f"declares {what} at")
                declared += 1
        self.assertGreater(declared, 20)


class Rules(unittest.TestCase):
    """The readers and the rule on synthetic inputs, so a regression in them cannot pass the checks above vacuously."""

    def test_the_import_pattern_finds_every_relative_form(self):
        text = (
            "import { connectCpuMeter } from '../../../../tools/workerd-cpu/workerd-cpu.mts';\n"
            "import {\n  checkWorkerBundle,\n} from '../../tools/bundle-size/bundle-size.mjs'\n"
            "export * from './local.ts'\n"
            "import './side-effect.css'\n"
            "const x = await import('../tools/x.mjs')\n"
            'const y = require("../y.cjs")\n'
            "import { z } from '@ziyixi/proto/ts/z'\n"
            "import { w } from 'vitest'\n"
        )
        self.assertEqual(
            js_imports(text),
            [
                "../../../../tools/workerd-cpu/workerd-cpu.mts",
                "../../tools/bundle-size/bundle-size.mjs",
                "./local.ts",
                "./side-effect.css",
                "../tools/x.mjs",
                "../y.cjs",
            ],
        )

    def test_python_paths_follow_the_usual_spellings(self):
        file = REPO / "website" / "relay" / "deploy" / "retire.py"
        source = (
            "import importlib.util, os, sys\n"
            "from pathlib import Path\n"
            "ROOT = Path(__file__).resolve().parents[3]\n"
            "sys.path.insert(0, str(ROOT / 'tools/cloud-release'))\n"
            "TYPED: Path = Path(__file__).resolve().parents[3]\n"
            "sys.path.insert(0, str(TYPED / 'todofy' / 'core'))\n"
            "sys.path.append(os.path.join(os.path.dirname(__file__), 'lib'))\n"
            "importlib.util.spec_from_file_location('m', Path(__file__).with_name('m.py'))\n"
            "def load(tmp_path):\n"
            "    path = Path(__file__).parents[3]\n"
            "    path /= 'mail-hero/x.py'\n"
            "    importlib.util.spec_from_file_location('x', path)\n"
            "    importlib.util.spec_from_file_location('t', tmp_path / 'scratch.py')\n"
        )
        self.assertEqual(
            python_paths(source, file),
            [
                REPO / "tools" / "cloud-release",
                REPO / "todofy" / "core",
                file.parent / "lib",
                file.with_name("m.py"),
                REPO / "mail-hero" / "x.py",
            ],
        )
        # Bindings the reader does not follow fail loudly instead of passing as if they were a parameter.
        for binding in (
            "ROOT, HERE = Path(__file__).resolve().parents[3], Path(__file__).parent",
            "from paths import ROOT",
            "for ROOT in [Path(__file__).parents[3]]: pass",
            "with open(__file__) as ROOT: pass",
            "ROOT = Path(__file__)\nROOT, _ = somewhere()",
        ):
            with self.subTest(binding=binding), self.assertRaises(Unresolved):
                source = f"import sys\nfrom pathlib import Path\n{binding}\nsys.path.insert(0, str(ROOT / 'x'))\n"
                python_paths(source, file)
        with self.assertRaises(Unresolved):
            python_paths("import sys\nsys.path.insert(0, somewhere())\n", file)

    def test_tsconfig_comments_and_trailing_commas(self):
        text = '{\n  // comment\n  "compilerOptions": {"paths": {"@/*": ["./src/*"],}, /* block */},\n}\n'
        self.assertEqual(jsonc(text), {"compilerOptions": {"paths": {"@/*": ["./src/*"]}}})

    def test_the_rule(self):
        cases = {
            ("lab", "lab/worker/src/a.ts", "lab/web/src/b.ts"): None,
            ("lab", "lab/worker/src/a.ts", "proto/ts/x.ts"): None,
            ("lab", "lab/worker/src/a.ts", "contracts/ops-v1/ops-v1.ts"): None,
            ("lab", "lab/worker/src/a.ts", "packages/edge-auth/src/index.ts"): None,
            ("lab", "lab/worker/test/a.test.ts", "tools/workerd-cpu/workerd-cpu.mts"): None,
            ("lab", "lab/deploy/bundle-size.mjs", "tools/bundle-size/bundle-size.mjs"): None,
            ("lab", "lab/worker/src/a.ts", "tools/bundle-size/bundle-size.mjs"): "ships, so it may not import tools/",
            ("lab", "lab/worker/src/a.ts", "todofy/gateway/src/ops.ts"): "reaches todofy/",
            ("lab", "lab/worker/test/a.test.ts", "dashboard/worker/test/fake.ts"): "reaches dashboard/",
            ("lab", "lab/worker/src/a.ts", ".github/scripts/x.py"): "reaches .github/",
            ("website", "website/src/a.ts", "proto/ts/x.ts"): None,
            ("website", "website/src/a.ts", "contracts/ops-v1/ops-v1.ts"): "reaches contracts/",
            ("website", "website/src/a.ts", "packages/edge-auth/src/index.ts"): "reaches packages/",
            ("website", "website/relay/deploy/x.py", "tools/cloud-release"): None,
        }
        for (app, importer, target), expected in cases.items():
            with self.subTest(importer=importer, target=target):
                self.assertEqual(violation(app, PurePosixPath(importer), REPO / target), expected)
        self.assertEqual(violation("lab", PurePosixPath("lab/a.ts"), REPO.parent / "elsewhere"), "leaves the repository")

    def test_every_catalog_app_is_scanned(self):
        tops = {name.parts[0] for name in tracked_files()}
        self.assertLessEqual(set(APPS), tops)
        self.assertGreaterEqual(len(APPS), 11)


if __name__ == "__main__":
    unittest.main()

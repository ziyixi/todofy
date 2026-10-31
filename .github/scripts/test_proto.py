"""The rules of proto/ (proto/README.md, Rules) that live outside the buf module.

Repository audit checks of workspace wiring and native proto dependency declarations.

- One version: buf, protoc-gen-es and the protobuf-es runtime use exact root catalog versions and one
  workspace lock; the runtime equals the generator's version. No app has its own
  @bufbuild/protobuf: apps import the runtime from @ziyixi/proto/protobuf, which resolves proto's copy, so
  every bundle holds exactly the runtime the generator targets.
- Wiring: every TypeScript user links @ziyixi/proto with workspace:* and runs proto/tools/ensure.mjs as its
  postinstall; every Python user takes ziyixi-proto from the root workspace as a non-editable source.
- Freshness: every npm script that compiles, tests, type-aware lints, bundles or serves the generated code (tsc,
  vitest, eslint, wrangler, vite) in a TypeScript user, or in a package whose sources import a user's sources, runs
  ensure.mjs first as its pre-script, so a pull or branch switch that changes a .proto file cannot leave stale
  generated types behind (uv's cache keys do the same for Python).
- Bazel proto_library sources and dependencies match every IDL import; native root :check closures and
  Target Determinator select affected checks and release facades. No application reachability map is maintained.
- Generated code is never committed and is ignored; uv's cache keys cover every input ensure.mjs hashes.
- Sources: a .proto file holds no invisible character but the space and the line feed (no other Unicode space,
  line or paragraph separator, control or format character): a pattern writes one as a \\u escape, so a reviewer
  sees it and every tool counts the same lines.
- api-linter: one exact version in the shared root Go module (go.mod pins it and the Go toolchain,
  go.sum every checksum); Bazel builds it and checks its embedded annotations against the locked descriptor image.
"""

import ast
import json
import os
import re
import subprocess
import sys
import unicodedata
import unittest
from pathlib import Path

import yaml

try:
    import tomllib
except ModuleNotFoundError:
    if os.environ.get("GITHUB_ACTIONS") == "true":
        raise
    raise unittest.SkipTest(
        f"test_proto needs Python 3.11+ (tomllib), this is {sys.version.split()[0]}: "
        "uv run --locked --only-group ci python -m unittest discover -s .github/scripts"
    ) from None

sys.path.insert(0, str(Path(__file__).parent))

REPO = Path(__file__).absolute().parents[2]
PROTO = REPO / "proto"
TOOLCHAIN = ("@bufbuild/buf", "@bufbuild/protoc-gen-es", "@bufbuild/protobuf")
RUNTIME = "@bufbuild/protobuf"
TS_PACKAGE = "@ziyixi/proto"
PY_PACKAGE = "ziyixi-proto"
ENSURE = PROTO / "tools" / "ensure.mjs"
# Script commands that read the generated code (compile, test, type-aware lint, bundle or serve it); the script's
# pre-script must run ensure.mjs. `vite\b` does not match vitest (the s is a word character). Node itself reads it
# through type stripping: its test runner (Mail Hero's tests import the ops-v1 sources) and a TypeScript script.
READS_GENERATED = re.compile(
    r"(^|[\s;&|(])(tsc|vitest|wrangler|eslint|vite|node\s+--test|node\s+\S+\.m?ts)\b"
)
RELATIVE_IMPORT = re.compile(r"""(?:\bfrom|\bimport)\s*\(?\s*['"](\.\.?/[^'"]+)['"]""")
EXACT = re.compile(r"\d+\.\d+\.\d+")
SKIP_PARTS = {"node_modules", ".venv", ".venv-workers", "python_modules", ".wrangler"}
API_LINTER = "github.com/googleapis/api-linter/v2"
LINTER_TOOLS = PROTO / "tools" / "api-linter"
WORKFLOW = REPO / ".github" / "workflows" / "ci.yml"


def tracked(pattern: str) -> list[Path]:
    """Files matching a git pathspec glob that are or can be committed (not ignored: never installed or
    generated copies)."""
    out = subprocess.run(
        [
            "git",
            "-C",
            str(REPO),
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
            "--",
            pattern,
        ],
        check=True,
        capture_output=True,
    ).stdout.decode()
    return [
        REPO / name
        for name in out.split("\0")
        if name and (REPO / name).is_file() and not SKIP_PARTS & set(Path(name).parts)
    ]


def app_of(path: Path) -> str:
    return path.relative_to(REPO).parts[0]


def consuming_apps(manifest: Path) -> set[str]:
    """Attribute shared TypeScript and Python descriptor imports to actual workspace consumers."""
    if app_of(manifest) != "packages":
        return {app_of(manifest)}
    python = manifest.name == "pyproject.toml"
    name = (
        tomllib.loads(manifest.read_text())["project"]["name"]
        if python
        else json.loads(manifest.read_text())["name"]
    )
    result = set()
    for candidate in tracked("*pyproject.toml" if python else "*package.json"):
        if app_of(candidate) in {"packages", "proto"}:
            continue
        if python:
            dependencies = (
                tomllib.loads(candidate.read_text())
                .get("project", {})
                .get("dependencies", [])
            )
            if name in {
                re.split(r"[\s<>=!~;\[]", dependency, maxsplit=1)[0]
                for dependency in dependencies
            }:
                result.add(app_of(candidate))
        else:
            dependencies = json.loads(candidate.read_text()).get("dependencies", {})
            if name in dependencies or any(
                isinstance(spec, str)
                and spec.startswith("file:")
                and (candidate.parent / spec[5:]).resolve() == manifest.parent.resolve()
                for spec in dependencies.values()
            ):
                result.add(app_of(candidate))
    return result


def ts_users() -> dict[Path, dict]:
    """package.json (outside proto/) -> its data, for every manifest that depends on @ziyixi/proto."""
    found = {}
    for manifest in tracked("*package.json"):
        if manifest.name != "package.json" or app_of(manifest) == "proto":
            continue
        data = json.loads(manifest.read_text())
        if any(
            TS_PACKAGE in data.get(section, {})
            for section in ("dependencies", "devDependencies")
        ):
            found[manifest] = data
    return found


def importers_of(users: dict[Path, dict]) -> dict[Path, dict]:
    """package.json -> its data, for every other package whose own sources import a user's sources by a
    relative path (it compiles the generated code too, resolved through that user's node_modules)."""
    roots = [manifest.parent for manifest in users]
    found = {}
    for manifest in tracked("*package.json"):
        if (
            manifest.name != "package.json"
            or app_of(manifest) == "proto"
            or manifest in users
        ):
            continue
        base = manifest.parent
        sources = [
            *tracked(f"{base.relative_to(REPO)}/*.ts"),
            *tracked(f"{base.relative_to(REPO)}/*.tsx"),
        ]
        for source in sources:
            targets = [
                (source.parent / spec).resolve()
                for spec in RELATIVE_IMPORT.findall(source.read_text())
            ]
            if any(
                target.is_relative_to(root) and not target.is_relative_to(base)
                for target in targets
                for root in roots
            ):
                found[manifest] = json.loads(manifest.read_text())
                break
    return found


def py_users() -> dict[Path, dict]:
    """pyproject.toml (outside proto/) -> its data, for every project that depends on ziyixi-proto."""
    found = {}
    for pyproject in tracked("*pyproject.toml"):
        if pyproject.name != "pyproject.toml" or app_of(pyproject) == "proto":
            continue
        data = tomllib.loads(pyproject.read_text())
        names = [*data.get("project", {}).get("dependencies", [])]
        for group in data.get("dependency-groups", {}).values():
            names += [item for item in group if isinstance(item, str)]
        if any(
            re.split(r"[\s<>=!~;\[]", name, maxsplit=1)[0] == PY_PACKAGE
            for name in names
        ):
            found[pyproject] = data
    return found


# A specifier of @ziyixi/proto in an import or export statement (the statement's start decides type-only).
TS_FROM = re.compile(
    r"""\bfrom\s*['"](@ziyixi/proto(?:/[^'"]*)?)['"]|^\s*import\s*['"](@ziyixi/proto(?:/[^'"]*)?)['"]""",
    re.MULTILINE,
)


def ts_proto_imports(text: str) -> list[tuple[str, bool]]:
    """(specifier, type only) of every static import or re-export from @ziyixi/proto in a source file."""
    found = []
    for match in TS_FROM.finditer(text):
        if match.group(2) is not None:
            found.append((match.group(2), False))  # `import '...'`: run for its effects
            continue
        start = (
            max(
                text.rfind("\nimport", 0, match.start()),
                text.rfind("\nexport", 0, match.start()),
            )
            + 1
        )
        statement = text[start : match.start()]
        found.append(
            (
                match.group(1),
                re.match(r"\s*(import|export)\s+type\b", statement) is not None,
            )
        )
    return found


def production_sources(manifest: Path) -> list[Path]:
    """The TypeScript a package ships: src/** and its relay/src/** when the same manifest builds both Workers, without
    tests (*.test.*) or helpers (test/ and __tests__/)."""
    base = manifest.parent
    roots = [base / "src"]
    if (base / "relay" / "src").is_dir():
        roots.append(base / "relay" / "src")
    return [
        path
        for root in roots
        for path in sorted(root.rglob("*.ts*"))
        if ".test." not in path.name
        and not {"test", "__tests__", "node_modules"}
        & set(path.relative_to(base).parts)
    ]


def py_production_sources(pyproject: Path) -> list[Path]:
    """Production Python: a Worker's base_dir, or the independent VPS package's src/."""
    config_path = pyproject.parent / "wrangler.toml"
    if config_path.is_file():
        config = tomllib.loads(config_path.read_text())
        root = pyproject.parent / config.get("base_dir", ".")
    else:
        root = pyproject.parent / "src"
        if not root.is_dir():
            raise AssertionError(
                "a VPS Python proto user must have an explicit src/ package"
            )
    return sorted(root.rglob("*.py"))


def proto_metadata(package: str) -> dict:
    build = PROTO / package / "BUILD.bazel"
    calls = [
        node
        for node in ast.walk(ast.parse(build.read_text()))
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id == "proto_library"
    ]
    if len(calls) != 1:
        raise AssertionError(f"{package}: expected one package-scoped proto_library")
    return {item.arg: ast.literal_eval(item.value) for item in calls[0].keywords}


def value_importers() -> dict[str, set[str]]:
    """App -> direct generated-module imports in production, without inferring affected applications."""
    found: dict[str, set[str]] = {}
    for manifest, data in ts_users().items():
        if TS_PACKAGE not in data.get("dependencies", {}):
            continue
        for source in production_sources(manifest):
            for specifier, type_only in ts_proto_imports(source.read_text()):
                if not type_only:
                    for app in consuming_apps(manifest):
                        found.setdefault(app, set()).update(
                            {"ts", f"proto/{specifier.removeprefix(TS_PACKAGE + '/')}"}
                        )
    for pyproject, data in py_users().items():
        if not py_bundled(data):
            continue
        for source in py_production_sources(pyproject):
            for module in re.findall(
                r"^\s*(?:from|import)\s+(ziyixi_proto(?:\.\w+)*)\b",
                source.read_text(),
                re.MULTILINE,
            ):
                for app in consuming_apps(pyproject):
                    found.setdefault(app, set()).update(
                        {"python", "proto/" + "/".join(module.split(".")[1:])}
                    )
    return {
        app: {re.sub(r"_(?:pb|wire)(?:\.ts)?$", ".proto", path) for path in paths}
        for app, paths in found.items()
    }


def py_bundled(data: dict) -> bool:
    return any(
        re.split(r"[\s<>=!~;\[]", name, maxsplit=1)[0] == PY_PACKAGE
        for name in data["project"]["dependencies"]
    )


class OneVersion(unittest.TestCase):
    def setUp(self):
        self.manifest = json.loads((PROTO / "package.json").read_text())
        self.catalog = yaml.safe_load((REPO / "pnpm-workspace.yaml").read_text())[
            "catalog"
        ]
        self.lock = yaml.safe_load((REPO / "pnpm-lock.yaml").read_text())

    def test_the_toolchain_is_pinned_in_the_shared_catalog(self):
        pins = self.manifest["dependencies"]
        for name in TOOLCHAIN:
            with self.subTest(package=name):
                self.assertEqual(pins[name], "catalog:")
                self.assertRegex(self.catalog[name], rf"^{EXACT.pattern}$")
                self.assertEqual(
                    self.lock["catalogs"]["default"][name]["version"],
                    self.catalog[name],
                )
                self.assertEqual(
                    self.lock["importers"]["proto"]["dependencies"][name][
                        "version"
                    ].split("(", 1)[0],
                    self.catalog[name],
                )

    def test_the_runtime_is_the_generators_version(self):
        self.assertEqual(self.catalog[RUNTIME], self.catalog["@bufbuild/protoc-gen-es"])
        version = self.lock["importers"]["proto"]["dependencies"][
            "@bufbuild/protoc-gen-es"
        ]["version"]
        generator = self.lock["snapshots"]["@bufbuild/protoc-gen-es@" + version]
        dependencies = {
            **generator.get("dependencies", {}),
            **generator.get("optionalDependencies", {}),
        }
        self.assertEqual(dependencies[RUNTIME], self.catalog[RUNTIME])

    def test_the_lock_has_one_runtime_version(self):
        copies = [key for key in self.lock["packages"] if key.startswith(RUNTIME + "@")]
        self.assertEqual(copies, [RUNTIME + "@" + self.catalog[RUNTIME]])
        runtime = self.lock["importers"]["proto/ts"]["dependencies"][RUNTIME]
        self.assertEqual(
            runtime, {"specifier": "catalog:", "version": self.catalog[RUNTIME]}
        )

    def test_no_app_has_its_own_runtime_or_generator(self):
        """Only proto owns the runtime; applications import it through @ziyixi/proto/protobuf."""
        for path in tracked("*package.json"):
            if app_of(path) == "proto":
                continue
            with self.subTest(file=str(path.relative_to(REPO))):
                text = path.read_text()
                for name in TOOLCHAIN:
                    self.assertNotIn(
                        f'"{name}"',
                        text,
                        f"import it from {TS_PACKAGE}/protobuf instead",
                    )


class ApiLinter(unittest.TestCase):
    def setUp(self):
        self.go_mod = (REPO / "go.mod").read_text()

    def build_rule(self, build: Path, kind: str, name: str) -> dict[str, ast.expr]:
        calls = [
            node
            for node in ast.walk(ast.parse(build.read_text()))
            if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id == kind
            and any(
                item.arg == "name" and ast.literal_eval(item.value) == name
                for item in node.keywords
            )
        ]
        self.assertEqual(len(calls), 1, f"{build}: expected one {kind} named {name}")
        return {item.arg: item.value for item in calls[0].keywords}

    def test_one_exact_version_and_toolchain_in_the_root_module(self):
        self.assertIn("module github.com/ziyixi/todofy\n", self.go_mod)
        self.assertEqual(
            sorted(
                str(path.relative_to(REPO))
                for path in tracked("*")
                if path.name in {"go.mod", "go.sum"}
            ),
            ["go.mod", "go.sum"],
        )
        self.assertIn(f"tool {API_LINTER}/cmd/api-linter\n", self.go_mod)
        versions = re.findall(
            rf"^\s*{re.escape(API_LINTER)} (v\S+)", self.go_mod, re.MULTILINE
        )
        self.assertEqual(len(versions), 1, versions)
        self.assertRegex(versions[0], rf"^v{EXACT.pattern}$")
        self.assertRegex(
            self.go_mod,
            r"(?m)^toolchain go\d+\.\d+\.\d+$",
            "pin the Go toolchain exactly",
        )
        go_sum = (REPO / "go.sum").read_text()
        self.assertIn(f"{API_LINTER} {versions[0]} h1:", go_sum)
        self.assertIn(f"{API_LINTER} {versions[0]}/go.mod h1:", go_sum)

    def test_bazel_uses_the_shared_root_go_module(self):
        module = (REPO / "MODULE.bazel").read_text()
        self.assertIn('go_mod = "//:go.mod"', module)
        toolchain = re.search(r"(?m)^toolchain go(\d+\.\d+\.\d+)$", self.go_mod)[1]
        self.assertIn(f'go_sdk.download(version = "{toolchain}")', module)
        build = (LINTER_TOOLS / "BUILD.bazel").read_text()
        self.assertIn(
            "@com_github_googleapis_api_linter_v2//cmd/api-linter:api-linter", build
        )
        root_build = (REPO / "BUILD.bazel").read_text()
        self.assertIn('"go.mod"', root_build)
        self.assertIn('"go.sum"', root_build)

    def test_the_linter_checks_its_annotations_against_the_locked_descriptor(self):
        runner = (PROTO / "tools/bazel_checks.py").read_text()
        self.assertLess(
            runner.index("args.googleapis_check, str(args.image)"),
            runner.index("args.api_linter,"),
        )
        rule = self.build_rule(PROTO / "tools/BUILD.bazel", "py_test", "api_lint_test")
        args = [
            node.value
            for node in ast.walk(rule["args"])
            if isinstance(node, ast.Constant) and isinstance(node.value, str)
        ]
        self.assertEqual(
            args[args.index("--googleapis-check") + 1],
            "$(location //proto/tools/api-linter/googleapis:googleapis-check)",
        )
        self.assertEqual(args[args.index("--image") + 1], "$(location //proto:image)")
        data = ast.literal_eval(rule["data"])
        self.assertIn("//proto:image", data)
        self.assertIn("//proto/tools/api-linter/googleapis:googleapis-check", data)
        check = (LINTER_TOOLS / "googleapis/main.go").read_text()
        self.assertIn(
            '_ "google.golang.org/genproto/googleapis/api/annotations"', check
        )
        self.assertRegex(
            self.go_mod,
            r"(?m)^\tgoogle\.golang\.org/genproto/googleapis/api v0\.0\.0-\d{14}-[0-9a-f]{12}$",
        )
        self.assertIn("buf.lock", self.go_mod)

    def test_nothing_else_installs_it(self):
        offenders = []
        for path in tracked("*"):
            skipped = (
                path.is_relative_to(LINTER_TOOLS) or path == Path(__file__).absolute()
            )
            if skipped or path.suffix in {".md", ".sum"} or not path.is_file():
                continue
            text = path.read_text(errors="ignore")
            if re.search(
                r"api-linter(/v2)?(/cmd/api-linter)?@|go install\b[^\n]*api-linter",
                text,
            ):
                offenders.append(str(path.relative_to(REPO)))
        self.assertEqual(offenders, [])

    def test_public_proto_check_covers_linter_and_annotation_agreement(self):
        build = PROTO / "BUILD.bazel"
        check = self.build_rule(build, "test_suite", "check")
        self.assertIn(":tests", ast.literal_eval(check["tests"]))
        suite = self.build_rule(build, "test_suite", "tests")
        for label in (
            "//proto/tools:api_lint_test",
            "//proto/tools/api-linter/googleapis:googleapis_test",
        ):
            self.assertIn(label, ast.literal_eval(suite["tests"]))
        public_linter = self.build_rule(build, "test_suite", "api_lint_test")
        self.assertEqual(
            ast.literal_eval(public_linter["tests"]), ["//proto/tools:api_lint_test"]
        )
        self.assertEqual(
            json.loads((PROTO / "package.json").read_text())["scripts"]["test"],
            "bazel test //proto:check",
        )


class Users(unittest.TestCase):
    def test_typescript_users_link_the_package_and_generate_on_install(self):
        users = ts_users()
        self.assertTrue(users, "no TypeScript user of @ziyixi/proto")
        lock = yaml.safe_load((REPO / "pnpm-lock.yaml").read_text())
        for manifest, data in users.items():
            with self.subTest(manifest=str(manifest.relative_to(REPO))):
                spec = (
                    data.get("dependencies", {}).get(TS_PACKAGE)
                    or data["devDependencies"][TS_PACKAGE]
                )
                self.assertEqual(spec, "workspace:*")
                postinstall = data.get("scripts", {}).get("postinstall", "")
                match = re.fullmatch(r"node (\S+/tools/ensure\.mjs)", postinstall)
                self.assertIsNotNone(
                    match,
                    f"postinstall must be exactly `node <...>/proto/tools/ensure.mjs`: {postinstall!r}",
                )
                self.assertEqual((manifest.parent / match.group(1)).resolve(), ENSURE)
                importer = lock["importers"][
                    manifest.parent.relative_to(REPO).as_posix()
                ]
                dependencies = {
                    **importer.get("dependencies", {}),
                    **importer.get("devDependencies", {}),
                }
                dependency = dependencies[TS_PACKAGE]
                self.assertEqual(dependency["specifier"], "workspace:*")
                self.assertTrue(dependency["version"].startswith("link:"))
                self.assertEqual(
                    (
                        manifest.parent / dependency["version"].removeprefix("link:")
                    ).resolve(),
                    PROTO / "ts",
                )

    def test_bazel_imports_the_shared_root_lock(self):
        module = (REPO / "MODULE.bazel").read_text()
        self.assertIn('pnpm_lock = "//:pnpm-lock.yaml"', module)
        self.assertFalse(tracked("*package-lock.json"))

    def test_scripts_that_read_the_generated_code_regenerate_it_first(self):
        users = ts_users()
        importers = importers_of(users)
        # The watch app's UI calls watch.ui.v1 through the generated client: a user itself.
        self.assertIn(
            REPO / "watch" / "web" / "package.json",
            users,
            "the watch app's UI depends on @ziyixi/proto",
        )
        for manifest, data in {**users, **importers}.items():
            scripts = data.get("scripts", {})
            for name, command in scripts.items():
                if name.startswith(("pre", "post")) or not READS_GENERATED.search(
                    command
                ):
                    continue
                with self.subTest(
                    manifest=str(manifest.relative_to(REPO)), script=name
                ):
                    match = re.fullmatch(
                        r"node (\S+/tools/ensure\.mjs)", scripts.get(f"pre{name}", "")
                    )
                    self.assertIsNotNone(
                        match, f'add "pre{name}": "node <...>/proto/tools/ensure.mjs"'
                    )
                    self.assertEqual(
                        (manifest.parent / match.group(1)).resolve(), ENSURE
                    )

    def test_the_freshness_rule_names_every_tool_that_reads_the_generated_code(self):
        """eslint reads the generated types through typescript-eslint's project service, vite compiles them, Node's test
        runner and a TypeScript script load them by type stripping."""
        for command in (
            "tsc --noEmit",
            "tsc --noEmit && tsc --noEmit -p test/runtime/tsconfig.json",
            "vitest run --config vitest.runtime.config.ts",
            "wrangler deploy --dry-run",
            "eslint .",
            "npm run check && eslint src",
            "vite",
            "tsc --noEmit && vite build && node scripts/check-dist.mjs",
            "node --test test/*.test.mjs",
            "node --test --test-concurrency=1 test/cpu/*.test.mjs",
            "node scripts/report.ts",
            "node tools/check.mts --write",
        ):
            with self.subTest(command=command):
                self.assertRegex(command, READS_GENERATED)
        for command in (
            "node scripts/check-dist.mjs",
            "prettier --check .",
            "node ../../proto/tools/ensure.mjs",
            "my-eslint-report",
            "node test/contract-fixtures.mjs --write",
            "nodemon --test",
        ):
            with self.subTest(command=command):
                self.assertNotRegex(command, READS_GENERATED)

    def test_python_users_build_the_shared_workspace_package_not_editable(self):
        users = py_users()
        self.assertTrue(users, "no Python user of ziyixi-proto")
        workspace = tomllib.loads((REPO / "pyproject.toml").read_text())["tool"]["uv"]
        self.assertEqual(
            workspace["sources"][PY_PACKAGE], {"workspace": True, "editable": False}
        )
        self.assertIn("proto/python", workspace["workspace"]["members"])
        lock = tomllib.loads((REPO / "uv.lock").read_text())
        package = next(
            package for package in lock["package"] if package["name"] == PY_PACKAGE
        )
        self.assertEqual(package["source"], {"directory": "proto/python"})
        for pyproject, data in users.items():
            with self.subTest(pyproject=str(pyproject.relative_to(REPO))):
                self.assertIn(
                    pyproject.parent.relative_to(REPO).as_posix(),
                    workspace["workspace"]["members"],
                )
                self.assertNotIn(
                    PY_PACKAGE, data.get("tool", {}).get("uv", {}).get("sources", {})
                )
                self.assertFalse((pyproject.parent / "uv.lock").exists())

    def test_a_python_worker_regenerates_when_its_node_toolchain_installs(self):
        """pywrangler vendors ziyixi-proto from proto/'s source tree inside Pyodide, which cannot generate,
        and uv may install the package from its wheel cache without regenerating that tree (after `git clean
        -fdX`, for example). The npm install every pywrangler command needs (wrangler) regenerates it."""
        users = {
            path: data
            for path, data in py_users().items()
            if py_bundled(data) and (path.parent / "wrangler.toml").is_file()
        }
        self.assertTrue(users, "no Python Worker bundles ziyixi-proto")
        for pyproject in users:
            with self.subTest(pyproject=str(pyproject.relative_to(REPO))):
                manifest = json.loads((pyproject.parent / "package.json").read_text())
                match = re.fullmatch(
                    r"node (\S+/tools/ensure\.mjs)",
                    manifest.get("scripts", {}).get("postinstall", ""),
                )
                self.assertIsNotNone(
                    match, 'add "postinstall": "node <...>/proto/tools/ensure.mjs"'
                )
                self.assertEqual((pyproject.parent / match.group(1)).resolve(), ENSURE)

    def test_proto_libraries_declare_every_idl_import_edge(self):
        for build in tracked("proto/**/BUILD.bazel"):
            calls = [
                node
                for node in ast.walk(ast.parse(build.read_text()))
                if isinstance(node, ast.Call)
                and isinstance(node.func, ast.Name)
                and node.func.id == "proto_library"
            ]
            for call in calls:
                metadata = {
                    item.arg: ast.literal_eval(item.value) for item in call.keywords
                }
                sources = {build.parent / source for source in metadata["srcs"]}
                imports = {
                    name
                    for source in sources
                    for name in re.findall(
                        r'^import "([^"]+)";', source.read_text(), re.MULTILINE
                    )
                }
                expected = set()
                for name in imports:
                    if name.startswith("google/protobuf/"):
                        expected.add("@protobuf//:" + Path(name).stem + "_proto")
                    elif name.startswith("google/"):
                        expected.add(
                            "@googleapis//:"
                            + name.removesuffix(".proto").replace("/", "_")
                            + "_proto"
                        )
                    elif PROTO / name not in sources:
                        expected.add("//proto/" + str(Path(name).parent) + ":proto")
                with self.subTest(package=str(build.parent.relative_to(REPO))):
                    self.assertEqual(set(metadata.get("deps", [])), expected)
                    self.assertEqual(metadata["strip_import_prefix"], "/proto")

    def test_each_idl_package_has_a_native_proto_library(self):
        sources = [
            path
            for path in tracked("proto/**/*.proto")
            if "node_modules" not in path.parts
        ]
        self.assertTrue(sources)
        for source in sources:
            with self.subTest(source=str(source.relative_to(PROTO))):
                build = source.parent / "BUILD.bazel"
                self.assertTrue(
                    build.is_file(), "IDL packages declare their own Bazel boundary"
                )
                self.assertIn(
                    source.name,
                    proto_metadata(source.parent.relative_to(PROTO).as_posix())["srcs"],
                )

    def test_shared_message_dependencies_are_real_bazel_edges(self):
        self.assertIn(
            "//proto/platform/runtime/v1:proto",
            proto_metadata("fleet/telemetry/v1")["deps"],
        )
        self.assertIn(
            "//proto/common/wire/v1:proto",
            proto_metadata("platform/runtime/v1")["deps"],
        )
        self.assertNotIn(
            "//proto/website/sync/v1:proto", proto_metadata("ops/v1")["deps"]
        )

    def test_vps_python_proto_user_has_independent_source_and_local_dependency(self):
        platform = REPO / "platform/pyproject.toml"
        data = tomllib.loads(platform.read_text())
        self.assertTrue(py_bundled(data))
        workspace = tomllib.loads((REPO / "pyproject.toml").read_text())["tool"]["uv"]
        self.assertEqual(
            workspace["sources"][PY_PACKAGE], {"workspace": True, "editable": False}
        )
        self.assertEqual(
            data["project"]["scripts"]["personal-cloud"], "personal_cloud.__main__:main"
        )
        self.assertFalse((platform.parent / "wrangler.toml").exists())
        self.assertTrue(
            all(
                source.is_relative_to(platform.parent / "src")
                for source in py_production_sources(platform)
            )
        )

    def test_the_website_manifest_covers_its_separate_relay_bundle(self):
        manifest = REPO / "website" / "package.json"
        sources = production_sources(manifest)
        self.assertIn(REPO / "website" / "relay" / "src" / "status.ts", sources)
        self.assertFalse(
            [
                path
                for path in sources
                if "tests" in path.parts or "node_modules" in path.parts
            ]
        )
        values = {
            name
            for path in sources
            for name, type_only in ts_proto_imports(path.read_text())
            if not type_only
        }
        self.assertIn("@ziyixi/proto/website/sync/v1/sync_pb", values)
        self.assertIn("@ziyixi/proto/ops/v1/ops_pb", values)

    def test_website_sync_has_direct_and_shared_descriptor_consumers(self):
        imports = value_importers()
        direct = {
            app
            for app, paths in imports.items()
            if "proto/website/sync/v1/sync.proto" in paths
        }
        self.assertEqual(direct, {"website", "dashboard"})
        self.assertIn(
            "proto/dashboard/mcp/v1/home_service.proto", imports["personal-mcp"]
        )
        self.assertIn(
            "//proto/dashboard/ui/v1:proto", proto_metadata("dashboard/mcp/v1")["deps"]
        )
        self.assertIn(
            "//proto/website/sync/v1:proto", proto_metadata("dashboard/ui/v1")["deps"]
        )
        self.assertNotIn(
            "//proto/website/sync/v1:proto", proto_metadata("ops/v1")["deps"]
        )

    def test_type_only_imports_are_told_apart(self):
        text = (
            "import type { A } from '@ziyixi/proto/a/v1/a_pb'\n"
            "import { b } from '@ziyixi/proto/b/v1/b_pb'\n"
            "import {\n  type C,\n  d,\n} from '@ziyixi/proto/c'\n"
            "export type { E } from '@ziyixi/proto/e'\n"
            "import '@ziyixi/proto/f'\n"
        )
        self.assertEqual(
            ts_proto_imports(text),
            [
                ("@ziyixi/proto/a/v1/a_pb", True),
                ("@ziyixi/proto/b/v1/b_pb", False),
                ("@ziyixi/proto/c", False),
                ("@ziyixi/proto/e", True),
                ("@ziyixi/proto/f", False),
            ],
        )

    def test_a_test_only_user_has_no_production_import(self):
        """A test-only dependency cannot appear in a production bundle."""
        for manifest, data in ts_users().items():
            if TS_PACKAGE in data.get("dependencies", {}):
                continue
            for source in production_sources(manifest):
                with self.subTest(file=str(source.relative_to(REPO))):
                    self.assertNotIn(f"'{TS_PACKAGE}", source.read_text())
                    self.assertNotIn(f'"{TS_PACKAGE}', source.read_text())
        for pyproject, data in py_users().items():
            if py_bundled(data):
                continue
            config = tomllib.loads((pyproject.parent / "wrangler.toml").read_text())
            for source in sorted(
                (pyproject.parent / config.get("base_dir", ".")).rglob("*.py")
            ):
                with self.subTest(file=str(source.relative_to(REPO))):
                    self.assertNotRegex(
                        source.read_text(),
                        r"^\s*(from|import)\s+ziyixi_proto\b",
                        re.MULTILINE,
                    )


# Unicode categories a .proto source may not hold literally (besides the space and the line feed): spaces, line and
# paragraph separators (U+2028 and U+2029 end a line for Python's splitlines and for JavaScript), controls (a tab
# too: buf format writes spaces), format characters (U+FEFF, zero-width joiners), private-use and unassigned code
# points.
INVISIBLE = frozenset({"Zs", "Zl", "Zp", "Cc", "Cf", "Co", "Cn"})


def invisible_characters(text: str) -> list[tuple[int, str]]:
    """(line, U+XXXX) of every character of ``text`` that a .proto source may not hold literally."""
    return [
        (text.count("\n", 0, i) + 1, f"U+{ord(char):04X}")
        for i, char in enumerate(text)
        if char not in " \n" and unicodedata.category(char) in INVISIBLE
    ]


class Sources(unittest.TestCase):
    def test_no_proto_source_holds_an_invisible_character(self):
        sources = tracked("*.proto")
        self.assertTrue(
            any(
                path.parts[-4:] == ("todofy", "report", "v1", "report.proto")
                for path in sources
            )
        )
        for path in sources:
            with self.subTest(file=str(path.relative_to(REPO))):
                self.assertEqual(
                    invisible_characters(path.read_text(encoding="utf-8")),
                    [],
                    "write it as a \\u escape",
                )

    def test_the_check_sees_what_a_reviewer_cannot(self):
        text = 'pattern: "[ \\u00A0\u00a0\u2028\t]" // 报税\n\ufeffx'
        self.assertEqual(
            invisible_characters(text),
            [(1, "U+00A0"), (1, "U+2028"), (1, "U+0009"), (2, "U+FEFF")],
        )


class Generated(unittest.TestCase):
    def test_no_generated_file_is_committed(self):
        committed = [
            str(path.relative_to(REPO))
            for path in tracked("proto/ts") + tracked("proto/python/src/ziyixi_proto")
        ]
        roots = ("proto/ts/", "proto/python/src/ziyixi_proto/")
        nested = [
            name
            for name in committed
            if "/" in name.removeprefix(next(r for r in roots if name.startswith(r)))
        ]
        self.assertEqual(
            nested,
            [],
            "every directory under the package roots is generated (proto/.gitignore)",
        )

    def test_generated_paths_are_ignored(self):
        for path in (
            "proto/ts/tasks/inbox/v1/task_inbox_pb.ts",
            "proto/python/src/ziyixi_proto/todofy/mail/v1/mail_service_pb.py",
            "proto/.generated.json",
        ):
            with self.subTest(path=path):
                result = subprocess.run(
                    ["git", "-C", str(REPO), "check-ignore", "-q", "--no-index", path],
                    check=False,
                )
                self.assertEqual(result.returncode, 0, f"{path} must be ignored")

    def test_uv_cache_covers_bazel_inputs_and_the_materialized_manifest(self):
        keys = {
            key["file"]
            for key in tomllib.loads((PROTO / "python/pyproject.toml").read_text())[
                "tool"
            ]["uv"]["cache-keys"]
        }
        self.assertLessEqual(
            {
                "../.generated.json",
                "../**/*.proto",
                "../**/BUILD.bazel",
                "../bazel/*.bzl",
                "../buf.gen.yaml",
                "../buf.lock",
                "../../MODULE.bazel",
                "../../MODULE.bazel.lock",
                "../../.bazelrc",
                "../../.bazelversion",
                "../tools/*.py",
                "../tools/ensure.mjs",
                "../ts/*.ts",
                "../../uv.lock",
                "src/ziyixi_proto/py.typed",
            },
            keys,
        )

    def test_development_entry_only_materializes_canonical_bazel_outputs(self):
        ensure = ENSURE.read_text()
        self.assertIn("bazel(['build', '//proto:materialized'])", ensure)
        for obsolete in (
            "toolCommands",
            "check-deterministic",
            "pnpm install",
            "buf generate",
            "gen_py.py",
        ):
            self.assertNotIn(obsolete, ensure)
        build = (PROTO / "BUILD.bazel").read_text()
        self.assertIn('typescript = "//proto/ts:pkg"', build)
        self.assertIn('name = "materialized"', build)


if __name__ == "__main__":
    unittest.main()

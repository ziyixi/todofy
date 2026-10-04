"""The rules of proto/ (proto/README.md, Rules) that live outside the buf module.

python3 -m unittest discover -s .github/scripts (the Changes job, every push) and
python3 -m unittest discover -s .github/scripts -p test_proto.py (the Proto checks job). Standard library only.

- One version: buf, protoc-gen-es and the protobuf-es runtime are pinned exactly, in proto/package.json and
  its lockfile only; the runtime equals the generator's version and is installed once. No app has its own
  @bufbuild/protobuf: apps import the runtime from @ziyixi/proto/protobuf, which resolves proto's copy, so
  every bundle holds exactly the runtime the generator targets.
- Wiring: every TypeScript user depends on "file:<...>/proto/ts" and runs proto/tools/ensure.mjs as its
  postinstall; every Python user takes ziyixi-proto from proto/python as a non-editable path source.
- Freshness: every npm script that compiles, tests, type-aware lints, bundles or serves the generated code (tsc,
  vitest, eslint, wrangler, vite) in a TypeScript user, or in a package whose sources import a user's sources, runs
  ensure.mjs first as its pre-script, so a pull or branch switch that changes a .proto file cannot leave stale
  generated types behind (uv's cache keys do the same for Python).
- ci_changes.PROTO_USERS lists exactly those users, each with the languages its production bundles compile
  in (a TypeScript "dependencies" entry with a value import in production code, a Python [project]
  dependency); a user marked test-only has no production import of it; ci_changes.PROTO_PACKAGES names
  exactly the apps whose production code imports each package's generated code (type-only imports compile to
  nothing), so a proto/ change deploys only the bundles it reaches.
- Generated code is never committed and is ignored; uv's cache keys cover every input ensure.mjs hashes.
- Sources: a .proto file holds no invisible character but the space and the line feed (no other Unicode space,
  line or paragraph separator, control or format character): a pattern writes one as a \\u escape, so a reviewer
  sees it and every tool counts the same lines.
- api-linter: one exact version, in the Go tool module proto/tools/api-linter only (go.mod pins it and
  the Go toolchain, go.sum every checksum); scripts/api-lint.sh builds it from there, and the Proto checks
  job installs exactly that toolchain and runs the script. Nothing else installs api-linter.
"""

import json
import os
import re
import subprocess
import sys
import unicodedata
import unittest
from pathlib import Path

try:
    import tomllib
except ModuleNotFoundError:
    if os.environ.get("GITHUB_ACTIONS") == "true":
        raise
    raise unittest.SkipTest(
        f"test_proto needs Python 3.11+ (tomllib), this is {sys.version.split()[0]}: "
        "uv run --no-project --python 3.12 python -m unittest discover -s .github/scripts"
    ) from None

sys.path.insert(0, str(Path(__file__).parent))
import ci_changes  # noqa: E402

REPO = Path(__file__).resolve().parents[2]
PROTO = REPO / "proto"
TOOLCHAIN = ("@bufbuild/buf", "@bufbuild/protoc-gen-es", "@bufbuild/protobuf")
RUNTIME = "@bufbuild/protobuf"
TS_PACKAGE = "@ziyixi/proto"
PY_PACKAGE = "ziyixi-proto"
ENSURE = PROTO / "tools" / "ensure.mjs"
# Script commands that read the generated code (compile, test, type-aware lint, bundle or serve it); the script's
# pre-script must run ensure.mjs. `vite\b` does not match vitest (the s is a word character). Node itself reads it
# through type stripping: its test runner (Mail Hero's tests import the ops-v1 sources) and a TypeScript script.
READS_GENERATED = re.compile(r"(^|[\s;&|(])(tsc|vitest|wrangler|eslint|vite|node\s+--test|node\s+\S+\.m?ts)\b")
RELATIVE_IMPORT = re.compile(r"""(?:\bfrom|\bimport)\s*\(?\s*['"](\.\.?/[^'"]+)['"]""")
EXACT = re.compile(r"\d+\.\d+\.\d+")
SKIP_PARTS = {"node_modules", ".venv", ".venv-workers", "python_modules", ".wrangler"}
API_LINTER = "github.com/googleapis/api-linter/v2"
LINTER_MODULE = PROTO / "tools" / "api-linter"
WORKFLOW = REPO / ".github" / "workflows" / "ci.yml"


def tracked(pattern: str) -> list[Path]:
    """Files matching a git pathspec glob that are or can be committed (not ignored: never installed or
    generated copies)."""
    out = subprocess.run(
        ["git", "-C", str(REPO), "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", pattern],
        check=True,
        capture_output=True,
    ).stdout.decode()
    return [REPO / name for name in out.split("\0") if name and not SKIP_PARTS & set(Path(name).parts)]


def app_of(path: Path) -> str:
    return path.relative_to(REPO).parts[0]


def ts_users() -> dict[Path, dict]:
    """package.json (outside proto/) -> its data, for every manifest that depends on @ziyixi/proto."""
    found = {}
    for manifest in tracked("*package.json"):
        if manifest.name != "package.json" or app_of(manifest) == "proto":
            continue
        data = json.loads(manifest.read_text())
        if any(TS_PACKAGE in data.get(section, {}) for section in ("dependencies", "devDependencies")):
            found[manifest] = data
    return found


def importers_of(users: dict[Path, dict]) -> dict[Path, dict]:
    """package.json -> its data, for every other package whose own sources import a user's sources by a
    relative path (it compiles the generated code too, resolved through that user's node_modules)."""
    roots = [manifest.parent for manifest in users]
    found = {}
    for manifest in tracked("*package.json"):
        if manifest.name != "package.json" or app_of(manifest) == "proto" or manifest in users:
            continue
        base = manifest.parent
        sources = [*tracked(f"{base.relative_to(REPO)}/*.ts"), *tracked(f"{base.relative_to(REPO)}/*.tsx")]
        for source in sources:
            targets = [(source.parent / spec).resolve() for spec in RELATIVE_IMPORT.findall(source.read_text())]
            if any(target.is_relative_to(root) and not target.is_relative_to(base) for target in targets for root in roots):
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
        if any(re.split(r"[\s<>=!~;\[]", name, maxsplit=1)[0] == PY_PACKAGE for name in names):
            found[pyproject] = data
    return found


# A specifier of @ziyixi/proto in an import or export statement (the statement's start decides type-only).
TS_FROM = re.compile(r"""\bfrom\s*['"](@ziyixi/proto(?:/[^'"]*)?)['"]|^\s*import\s*['"](@ziyixi/proto(?:/[^'"]*)?)['"]""", re.MULTILINE)


def ts_proto_imports(text: str) -> list[tuple[str, bool]]:
    """(specifier, type only) of every static import or re-export from @ziyixi/proto in a source file."""
    found = []
    for match in TS_FROM.finditer(text):
        if match.group(2) is not None:
            found.append((match.group(2), False))  # `import '...'`: run for its effects
            continue
        start = max(text.rfind("\nimport", 0, match.start()), text.rfind("\nexport", 0, match.start())) + 1
        statement = text[start : match.start()]
        found.append((match.group(1), re.match(r"\s*(import|export)\s+type\b", statement) is not None))
    return found


# A Next.js app (FlowDay's UI) keeps the code it ships in these top-level directories instead of src/.
NEXT_SOURCE_DIRS = ("app", "components", "features", "lib")


def production_sources(manifest: Path) -> list[Path]:
    """The TypeScript a package ships: src/** (or Next.js sources) and its relay/src/** when the same manifest
    builds both Workers, without tests (*.test.*) or helpers (test/ and __tests__/)."""
    base = manifest.parent
    roots = [base / "src"] if (base / "src").is_dir() else [base / name for name in NEXT_SOURCE_DIRS if (base / name).is_dir()]
    if (base / "relay" / "src").is_dir():
        roots.append(base / "relay" / "src")
    return [
        path
        for root in roots
        for path in sorted(root.rglob("*.ts*"))
        if ".test." not in path.name and not {"test", "__tests__", "node_modules"} & set(path.relative_to(base).parts)
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
            raise AssertionError("a VPS Python proto user must have an explicit src/ package")
    return sorted(root.rglob("*.py"))


def proto_import_closure(paths: set[str], root: Path = PROTO) -> set[str]:
    """Descriptors compile their imported message packages into a bundle, including shared runtime types."""
    sources = {"proto/" + path.relative_to(root).as_posix(): path for path in root.rglob("*.proto")
               if not {"node_modules", "ts", "python", ".generate"} & set(path.relative_to(root).parts)
               and not any(part.startswith(".") for part in path.relative_to(root).parts)}
    graph = {name: {"proto/" + imported for imported in re.findall(r'^\s*import(?:\s+(?:public|weak))?\s+"([^"\n]+)"',
                                                               path.read_text(), re.M)}
             for name, path in sources.items()}
    pending = []
    for imported in paths:
        if not imported.startswith("proto/") or imported in {"proto/ts", "proto/python"}:
            continue
        stem = re.sub(r"_(?:pb|wire)(?:\.ts)?$", "", imported)
        exact = stem + ".proto"
        if exact in sources:
            pending.append(exact)
        else:
            pending.extend(name for name in sources if name.startswith(imported.rstrip("/") + "/"))
    result, visited = set(paths), set()
    while pending:
        current = pending.pop()
        if current in visited:
            continue
        visited.add(current)
        result.add(current)
        pending.extend(dependency for dependency in graph.get(current, ()) if dependency in sources)
    return result


def value_importers() -> dict[str, set[str]]:
    """App -> the proto/ paths (a package directory, or a language: "ts", "python") its production bundles import."""
    found: dict[str, set[str]] = {}
    for manifest, data in ts_users().items():
        if TS_PACKAGE not in data.get("dependencies", {}):
            continue
        for source in production_sources(manifest):
            for specifier, type_only in ts_proto_imports(source.read_text()):
                if not type_only:
                    found.setdefault(app_of(manifest), set()).update({"ts", f"proto/{specifier.removeprefix(TS_PACKAGE + '/')}"})
    for pyproject, data in py_users().items():
        if not py_bundled(data):
            continue
        for source in py_production_sources(pyproject):
            for module in re.findall(r"^\s*(?:from|import)\s+(ziyixi_proto(?:\.\w+)*)", source.read_text(), re.MULTILINE):
                found.setdefault(app_of(pyproject), set()).update({"python", "proto/" + "/".join(module.split(".")[1:])})
    return {app: proto_import_closure(paths) for app, paths in found.items()}


def py_bundled(data: dict) -> bool:
    return any(re.split(r"[\s<>=!~;\[]", name, maxsplit=1)[0] == PY_PACKAGE for name in data["project"]["dependencies"])


class OneVersion(unittest.TestCase):
    def setUp(self):
        self.manifest = json.loads((PROTO / "package.json").read_text())
        self.lock = json.loads((PROTO / "package-lock.json").read_text())

    def test_the_toolchain_is_pinned_exactly_in_proto_only(self):
        pins = self.manifest["dependencies"]
        for name in TOOLCHAIN:
            with self.subTest(package=name):
                self.assertRegex(pins.get(name, ""), EXACT, f"{name} must be an exact version in proto/package.json")
                self.assertEqual(self.lock["packages"][f"node_modules/{name}"]["version"], pins[name])
        self.assertEqual(self.lock["packages"][""]["dependencies"], pins)

    def test_the_runtime_is_the_generators_version(self):
        pins = self.manifest["dependencies"]
        self.assertEqual(pins[RUNTIME], pins["@bufbuild/protoc-gen-es"])
        generator = self.lock["packages"]["node_modules/@bufbuild/protoc-gen-es"]
        self.assertEqual(generator["dependencies"][RUNTIME], pins[RUNTIME])

    def test_the_runtime_is_installed_once(self):
        copies = [
            key
            for key in self.lock["packages"]
            if key == f"node_modules/{RUNTIME}" or key.endswith(f"/node_modules/{RUNTIME}")
        ]
        self.assertEqual(copies, [f"node_modules/{RUNTIME}"])

    def test_no_app_has_its_own_runtime_or_generator(self):
        """An app's own copy would be a second runtime in its bundle, at a version nobody checks."""
        for path in [*tracked("*package.json"), *tracked("*package-lock.json")]:
            if app_of(path) == "proto":
                continue
            with self.subTest(file=str(path.relative_to(REPO))):
                text = path.read_text()
                for name in TOOLCHAIN:
                    self.assertNotIn(f'"{name}"', text, f"import it from {TS_PACKAGE}/protobuf instead")
                    self.assertNotIn(f"node_modules/{name}", text)


class ApiLinter(unittest.TestCase):
    def setUp(self):
        self.go_mod = (LINTER_MODULE / "go.mod").read_text()

    def test_one_exact_version_and_toolchain_in_the_tool_module(self):
        self.assertIn(f"tool {API_LINTER}/cmd/api-linter\n", self.go_mod)
        versions = re.findall(rf"^\s*{re.escape(API_LINTER)} (v\S+)", self.go_mod, re.MULTILINE)
        self.assertEqual(len(versions), 1, versions)
        self.assertRegex(versions[0], rf"^v{EXACT.pattern}$")
        self.assertRegex(self.go_mod, r"(?m)^toolchain go\d+\.\d+\.\d+$", "pin the Go toolchain exactly")
        go_sum = (LINTER_MODULE / "go.sum").read_text()
        self.assertIn(f"{API_LINTER} {versions[0]} h1:", go_sum)
        self.assertIn(f"{API_LINTER} {versions[0]}/go.mod h1:", go_sum)

    def test_the_script_builds_from_the_module_without_changing_it(self):
        script = (PROTO / "scripts" / "api-lint.sh").read_text()
        build = f"go -C tools/api-linter build -mod=readonly -o ../../.tools/api-linter {API_LINTER}/cmd/api-linter"
        self.assertIn(build, script)
        scripts = json.loads((PROTO / "package.json").read_text())["scripts"]
        self.assertEqual(scripts["api-lint"], "sh scripts/api-lint.sh")

    def test_the_linters_googleapis_is_checked_against_buf_lock_before_it_runs(self):
        """api-linter interprets the google.api annotations with the genproto code compiled into it, buf compiles the
        module against buf.lock's googleapis: tools/api-linter/googleapis fails unless both carry the same files."""
        script = (PROTO / "scripts" / "api-lint.sh").read_text()
        for line in (
            "go -C tools/api-linter test -mod=readonly ./googleapis\n",
            "go -C tools/api-linter build -mod=readonly -o ../../.tools/googleapis-check ./googleapis\n",
            '.tools/googleapis-check "$work/image.binpb"\n',
        ):
            with self.subTest(line=line):
                self.assertIn(line, script)
        self.assertLess(script.index(".tools/googleapis-check \""), script.index("if .tools/api-linter "))
        # The check compares against the packages api-linter v2 imports; genproto is a direct, exact requirement of
        # the tool module, so a bump is a reviewed change of go.mod.
        check = (LINTER_MODULE / "googleapis" / "main.go").read_text()
        self.assertIn('_ "google.golang.org/genproto/googleapis/api/annotations"', check)
        self.assertRegex(self.go_mod, r"(?m)^\tgoogle\.golang\.org/genproto/googleapis/api v0\.0\.0-\d{14}-[0-9a-f]{12}$")
        self.assertIn("buf.lock", self.go_mod)

    def test_nothing_else_installs_it(self):
        offenders = []
        for path in tracked("*"):
            skipped = path.is_relative_to(LINTER_MODULE) or path == Path(__file__).resolve()
            if skipped or path.suffix in {".md", ".sum"} or not path.is_file():
                continue
            text = path.read_text(errors="ignore")
            if re.search(r"api-linter(/v2)?(/cmd/api-linter)?@|go install\b[^\n]*api-linter", text):
                offenders.append(str(path.relative_to(REPO)))
        self.assertEqual(offenders, [])

    def test_the_proto_checks_job_installs_the_modules_toolchain_and_runs_the_linter(self):
        job = WORKFLOW.read_text().split("\n  proto-checks:\n", 1)[1].split("\n  gate:\n", 1)[0]
        self.assertIn("go-version-file: proto/tools/api-linter/go.mod", job)
        self.assertIn("cache-dependency-path: proto/tools/api-linter/go.sum", job)
        self.assertNotIn("go-version:", job)
        self.assertIn("run: npm run api-lint", job)


class Users(unittest.TestCase):
    def test_typescript_users_link_the_package_and_generate_on_install(self):
        users = ts_users()
        self.assertTrue(users, "no TypeScript user of @ziyixi/proto")
        for manifest, data in users.items():
            with self.subTest(manifest=str(manifest.relative_to(REPO))):
                spec = data.get("dependencies", {}).get(TS_PACKAGE) or data["devDependencies"][TS_PACKAGE]
                self.assertTrue(spec.startswith("file:"), spec)
                self.assertEqual((manifest.parent / spec.removeprefix("file:")).resolve(), PROTO / "ts")
                postinstall = data.get("scripts", {}).get("postinstall", "")
                match = re.fullmatch(r"node (\S+/tools/ensure\.mjs)", postinstall)
                self.assertIsNotNone(
                    match, f"postinstall must be exactly `node <...>/proto/tools/ensure.mjs`: {postinstall!r}"
                )
                self.assertEqual((manifest.parent / match.group(1)).resolve(), PROTO / "tools" / "ensure.mjs")
                if data.get("packageManager", "").startswith("pnpm@"):
                    # pnpm file: copies a package; the explicit native override must keep generated sources
                    # and the one runtime in proto/'s canonical tree, as npm's file: symlink does.
                    target = "link:" + spec.removeprefix("file:")
                    workspace = (manifest.parent / "pnpm-workspace.yaml").read_text()
                    self.assertRegex(workspace, rf"(?m)^overrides:\n  ['\"]?{re.escape(TS_PACKAGE)}['\"]?: ['\"]?{re.escape(target)}['\"]?$")
                    lock = (manifest.parent / "pnpm-lock.yaml").read_text()
                    importer = lock.split("\nimporters:\n", 1)[1].split("\npackages:\n", 1)[0]
                    dependency = re.search(rf"(?m)^      ['\"]{re.escape(TS_PACKAGE)}['\"]:\n        specifier: ([^\n]+)\n        version: ([^\n]+)$", importer)
                    self.assertIsNotNone(dependency, "the pnpm importer must lock the shared proto dependency")
                    self.assertEqual(dependency.group(1), target)
                    self.assertEqual(dependency.group(2), target)
                    self.assertNotIn(f"{TS_PACKAGE}@file:", lock, "pnpm must not copy the canonical proto package")
                else:
                    lock = json.loads((manifest.parent / "package-lock.json").read_text())
                    self.assertEqual(
                        lock["packages"][f"node_modules/{TS_PACKAGE}"],
                        {"resolved": spec.removeprefix("file:"), "link": True},
                    )

    def test_jobs_that_install_a_user_key_their_npm_cache_on_the_proto_lockfile(self):
        """Installing a TypeScript user runs proto/tools/ensure.mjs, which installs proto/'s own packages: a job whose npm
        cache is keyed on a user's lockfile must also key it on proto/package-lock.json, or a proto lockfile change
        restores a stale cache and downloads proto's packages on every run."""
        user_locks = {str((manifest.parent / "package-lock.json").relative_to(REPO)) for manifest in ts_users()}
        lines = WORKFLOW.read_text().splitlines()
        blocks = []
        for index, line in enumerate(lines):
            key, _, value = line.strip().partition("cache-dependency-path:")
            if key != "" or not _:
                continue
            if value.strip() not in ("|", ""):
                blocks.append((index + 1, {value.strip()}))
                continue
            indent = len(line) - len(line.lstrip())
            paths = set()
            for follow in lines[index + 1 :]:
                if not follow.strip() or len(follow) - len(follow.lstrip()) <= indent:
                    break
                paths.add(follow.strip())
            blocks.append((index + 1, paths))
        self.assertTrue(blocks, "no cache-dependency-path in ci.yml")
        for line_number, paths in blocks:
            if paths & user_locks:
                with self.subTest(line=line_number):
                    self.assertIn("proto/package-lock.json", paths, sorted(paths))

    def test_scripts_that_read_the_generated_code_regenerate_it_first(self):
        users = ts_users()
        importers = importers_of(users)
        # Lab's UI calls lab.ui.v1 through the generated client: a user itself (it also imports limits.ts).
        self.assertIn(REPO / "lab" / "web" / "package.json", users, "Lab's UI depends on @ziyixi/proto")
        for manifest, data in {**users, **importers}.items():
            scripts = data.get("scripts", {})
            for name, command in scripts.items():
                if name.startswith(("pre", "post")) or not READS_GENERATED.search(command):
                    continue
                with self.subTest(manifest=str(manifest.relative_to(REPO)), script=name):
                    match = re.fullmatch(r"node (\S+/tools/ensure\.mjs)", scripts.get(f"pre{name}", ""))
                    self.assertIsNotNone(match, f"add \"pre{name}\": \"node <...>/proto/tools/ensure.mjs\"")
                    self.assertEqual((manifest.parent / match.group(1)).resolve(), ENSURE)

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

    def test_python_users_build_the_package_from_proto_not_editable(self):
        users = py_users()
        self.assertTrue(users, "no Python user of ziyixi-proto")
        for pyproject, data in users.items():
            with self.subTest(pyproject=str(pyproject.relative_to(REPO))):
                source = data["tool"]["uv"]["sources"][PY_PACKAGE]
                # pywrangler vendors [project] dependencies from this same source: a Worker needs the files.
                self.assertEqual(set(source), {"path"}, "a plain path source: not editable, no other keys")
                self.assertEqual((pyproject.parent / source["path"]).resolve(), PROTO / "python")
                lock = (pyproject.parent / "uv.lock").read_text()
                self.assertIn(
                    f'name = "{PY_PACKAGE}"\nversion = "0.0.0"\nsource = {{ directory = "{source["path"]}" }}', lock
                )

    def test_a_python_worker_regenerates_when_its_node_toolchain_installs(self):
        """pywrangler vendors ziyixi-proto from proto/'s source tree inside Pyodide, which cannot generate,
        and uv may install the package from its wheel cache without regenerating that tree (after `git clean
        -fdX`, for example). The npm install every pywrangler command needs (wrangler) regenerates it."""
        users = {path: data for path, data in py_users().items()
                 if py_bundled(data) and (path.parent / "wrangler.toml").is_file()}
        self.assertTrue(users, "no Python Worker bundles ziyixi-proto")
        for pyproject in users:
            with self.subTest(pyproject=str(pyproject.relative_to(REPO))):
                manifest = json.loads((pyproject.parent / "package.json").read_text())
                match = re.fullmatch(r"node (\S+/tools/ensure\.mjs)", manifest.get("scripts", {}).get("postinstall", ""))
                self.assertIsNotNone(match, "add \"postinstall\": \"node <...>/proto/tools/ensure.mjs\"")
                self.assertEqual((pyproject.parent / match.group(1)).resolve(), ENSURE)

    def test_proto_users_matches_the_manifests_and_sources(self):
        """Every user is listed, with exactly the languages its production bundles take from proto/."""
        # Todofy takes both: todofy-core vendors the Python package, and its gateway (the transcoder of todofy.ui.v1)
        # and UI (the client) bundle the TypeScript runtime and generated code.
        for manifest in (REPO / "todofy" / "gateway" / "package.json", REPO / "todofy" / "web" / "package.json"):
            self.assertIn(TS_PACKAGE, json.loads(manifest.read_text())["dependencies"])
        users = {app_of(path) for path in [*ts_users(), *py_users()]}
        imports = value_importers()
        derived = {app: {lang for lang in imports.get(app, set()) if lang in ("ts", "python")} for app in users}
        self.assertEqual(derived, {app: set(languages) for app, languages in ci_changes.PROTO_USERS.items()})
        self.assertLessEqual(set(derived), set(ci_changes.APPS))

    def test_proto_packages_name_exactly_their_importers(self):
        """ci_changes.PROTO_PACKAGES: the apps whose production code imports each package's generated code."""
        imports = value_importers()
        for package, importers in ci_changes.PROTO_PACKAGES.items():
            with self.subTest(package=package):
                actual = {app for app, paths in imports.items() if any(path.startswith(package) for path in paths)}
                self.assertEqual(actual, set(importers))

    def test_proto_dependencies_include_foreign_shared_message_packages(self):
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name, text in {"fleet/telemetry/v1/report.proto": 'import "platform/runtime/v1/runtime.proto";',
                               "platform/runtime/v1/runtime.proto": 'import "common/wire/v1/wire.proto";',
                               "common/wire/v1/wire.proto": ''}.items():
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(text)
            closure = proto_import_closure({"ts", "proto/fleet/telemetry/v1/report_pb.ts"}, root)
            self.assertIn("proto/platform/runtime/v1/runtime.proto", closure)
            self.assertIn("proto/common/wire/v1/wire.proto", closure)
            self.assertIn("ts", closure)

    def test_vps_python_proto_user_has_independent_source_and_local_dependency(self):
        platform = REPO / "platform/pyproject.toml"
        data = tomllib.loads(platform.read_text())
        self.assertTrue(py_bundled(data))
        self.assertEqual(data["tool"]["uv"]["sources"][PY_PACKAGE], {"path": "../proto/python"})
        self.assertEqual(data["project"]["scripts"]["personal-cloud"], "personal_cloud.__main__:main")
        self.assertFalse((platform.parent / "wrangler.toml").exists())
        self.assertTrue(all(source.is_relative_to(platform.parent / "src") for source in py_production_sources(platform)))

    def test_a_next_js_ui_is_read_from_its_source_directories(self):
        """FlowDay's UI (Next.js, no src/) imports flowday.ui.v1 from lib/: its production sources are found."""
        manifest = REPO / "flowday" / "web" / "package.json"
        self.assertIn(manifest, ts_users())
        sources = production_sources(manifest)
        self.assertIn(REPO / "flowday" / "web" / "lib" / "client" / "flowday-api.ts", sources)
        self.assertFalse([path for path in sources if "__tests__" in path.parts])
        values = {name for path in sources for name, type_only in ts_proto_imports(path.read_text()) if not type_only}
        self.assertIn("@ziyixi/proto/flowday/ui/v1/flowday_ui_service_pb", values)

    def test_the_website_manifest_covers_its_separate_relay_bundle(self):
        manifest = REPO / "website" / "package.json"
        sources = production_sources(manifest)
        self.assertIn(REPO / "website" / "relay" / "src" / "status.ts", sources)
        self.assertFalse([path for path in sources if "tests" in path.parts or "node_modules" in path.parts])
        values = {name for path in sources for name, type_only in ts_proto_imports(path.read_text()) if not type_only}
        self.assertIn("@ziyixi/proto/website/sync/v1/sync_pb", values)
        self.assertIn("@ziyixi/proto/ops/v1/ops_pb", values)

    def test_ops_descriptors_include_the_embedded_website_sync_package(self):
        imports = value_importers()
        users = {app for app, paths in imports.items() if any(path.startswith("proto/ops/") for path in paths)}
        self.assertEqual(users, {"mail-hero", "lab", "todofy", "dashboard", "watch", "website"})
        for app in users:
            with self.subTest(app=app):
                self.assertIn("proto/website/sync/v1/sync.proto", imports[app])

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
            [("@ziyixi/proto/a/v1/a_pb", True), ("@ziyixi/proto/b/v1/b_pb", False), ("@ziyixi/proto/c", False), ("@ziyixi/proto/e", True), ("@ziyixi/proto/f", False)],
        )

    def test_a_test_only_user_has_no_production_import(self):
        """PROTO_USERS[app] False means no deploy on a proto/ change: nothing that ships may import it."""
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
            for source in sorted((pyproject.parent / config.get("base_dir", ".")).rglob("*.py")):
                with self.subTest(file=str(source.relative_to(REPO))):
                    self.assertNotRegex(source.read_text(), r"^\s*(from|import)\s+ziyixi_proto\b", re.MULTILINE)


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
        self.assertTrue(any(path.parts[-4:] == ("todofy", "report", "v1", "report.proto") for path in sources))
        for path in sources:
            with self.subTest(file=str(path.relative_to(REPO))):
                self.assertEqual(
                    invisible_characters(path.read_text(encoding="utf-8")), [], "write it as a \\u escape"
                )

    def test_the_check_sees_what_a_reviewer_cannot(self):
        text = 'pattern: "[ \\u00A0\u00a0\u2028\t]" // 报税\n\ufeffx'
        self.assertEqual(invisible_characters(text), [(1, "U+00A0"), (1, "U+2028"), (1, "U+0009"), (2, "U+FEFF")])


class Generated(unittest.TestCase):
    def test_no_generated_file_is_committed(self):
        committed = [
            str(path.relative_to(REPO)) for path in tracked("proto/ts") + tracked("proto/python/src/ziyixi_proto")
        ]
        roots = ("proto/ts/", "proto/python/src/ziyixi_proto/")
        nested = [name for name in committed if "/" in name.removeprefix(next(r for r in roots if name.startswith(r)))]
        self.assertEqual(nested, [], "every directory under the package roots is generated (proto/.gitignore)")

    def test_generated_paths_are_ignored(self):
        for path in (
            "proto/ts/todofy/taskintent/v1/task_intent_pb.ts",
            "proto/python/src/ziyixi_proto/todofy/taskintent/v1/task_intent_pb.py",
            "proto/.generated.json",
        ):
            with self.subTest(path=path):
                result = subprocess.run(["git", "-C", str(REPO), "check-ignore", "-q", "--no-index", path], check=False)
                self.assertEqual(result.returncode, 0, f"{path} must be ignored")

    def test_uv_rebuilds_when_any_input_of_the_stamp_changes(self):
        ensure = (PROTO / "tools" / "ensure.mjs").read_text()
        inputs = json.loads(
            re.search(r"^const INPUT_FILES = (\[.*\]);$", ensure, re.MULTILINE).group(1).replace("'", '"')
        )
        keys = {
            key["file"]
            for key in tomllib.loads((PROTO / "python" / "pyproject.toml").read_text())["tool"]["uv"]["cache-keys"]
        }
        self.assertLessEqual({f"../{name}" for name in inputs} | {"../**/*.proto"}, keys)
        # The stamp itself: a clean deletes it with the generated code, and uv must rebuild then.
        self.assertIn("../.generated.json", keys)

    def test_buf_and_ensure_exclude_the_same_directories(self):
        ensure = (PROTO / "tools" / "ensure.mjs").read_text()
        excluded = set(
            json.loads(
                re.search(r"^const EXCLUDED = new Set\((\[.*\])\);$", ensure, re.MULTILINE).group(1).replace("'", '"')
            )
        )
        buf_yaml = (PROTO / "buf.yaml").read_text()
        listed = set(
            re.findall(r"^      - (\S+)$", buf_yaml.split("excludes:", 1)[1].split("\ndeps:", 1)[0], re.MULTILINE)
        )
        self.assertEqual(excluded, listed)


if __name__ == "__main__":
    unittest.main()

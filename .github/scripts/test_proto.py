"""The rules of proto/ (proto/README.md, Rules) that live outside the buf module.

python3 -m unittest discover -s .github/scripts (the Changes job, every push) and
python3 -m unittest discover -s .github/scripts -p test_proto.py (the Proto checks job). Standard library only.

- One version: buf, protoc-gen-es and the protobuf-es runtime are pinned exactly, in proto/package.json and
  its lockfile only; the runtime equals the generator's version and is installed once. No app has its own
  @bufbuild/protobuf: apps import the runtime from @ziyixi/proto/protobuf, which resolves proto's copy, so
  every bundle holds exactly the runtime the generator targets.
- Wiring: every TypeScript user depends on "file:<...>/proto/ts" and runs proto/tools/ensure.mjs as its
  postinstall; every Python user takes ziyixi-proto from proto/python as a non-editable path source.
- ci_changes.PROTO_USERS lists exactly those users, each marked bundled only when its Worker compiles the
  package in, and a user marked test-only has no production import of it.
- Generated code is never committed and is ignored; uv's cache keys cover every input ensure.mjs hashes.
"""

import json
import os
import re
import subprocess
import sys
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
EXACT = re.compile(r"\d+\.\d+\.\d+")
SKIP_PARTS = {"node_modules", ".venv", ".venv-workers", "python_modules", ".wrangler"}


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
                lock = json.loads((manifest.parent / "package-lock.json").read_text())
                self.assertEqual(
                    lock["packages"][f"node_modules/{TS_PACKAGE}"],
                    {"resolved": spec.removeprefix("file:"), "link": True},
                )

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

    def test_proto_users_matches_the_manifests(self):
        derived = {}
        for manifest, data in ts_users().items():
            derived[app_of(manifest)] = derived.get(app_of(manifest), False) or TS_PACKAGE in data.get(
                "dependencies", {}
            )
        for pyproject, data in py_users().items():
            derived[app_of(pyproject)] = derived.get(app_of(pyproject), False) or py_bundled(data)
        self.assertEqual(derived, ci_changes.PROTO_USERS)
        self.assertLessEqual(set(derived), set(ci_changes.APPS))

    def test_a_test_only_user_has_no_production_import(self):
        """PROTO_USERS[app] False means no deploy on a proto/ change: nothing that ships may import it."""
        for manifest, data in ts_users().items():
            if TS_PACKAGE in data.get("dependencies", {}):
                continue
            for source in sorted((manifest.parent / "src").rglob("*.ts*")):
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

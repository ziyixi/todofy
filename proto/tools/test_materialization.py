"""The stdlib wheel backend accepts only current Bazel materialization in Pyodide."""

import hashlib
import json
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

import build_backend as backend


class MaterializationTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.proto = Path(self.directory.name)
        self.source = self.proto / "python/src"
        self.ts = self.proto / "ts/example/v1/example_pb.ts"
        self.py = self.source / "ziyixi_proto/example/v1/example.py"
        self.input = self.proto / "buf.lock"
        for path, text in [(self.ts, "// generated\n"), (self.py, "# generated\n"), (self.input, "synthetic lock\n")]:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text)
        self.stamp = self.proto / ".generated.json"
        self.stamp.write_text(
            json.dumps(
                {
                    "version": 2,
                    "inputs": {"buf.lock": self.digest(self.input)},
                    "outputs": {
                        path.relative_to(self.proto).as_posix(): self.digest(path) for path in [self.ts, self.py]
                    },
                }
            )
        )
        self.addCleanup(patch.stopall)
        for name, value in {
            "PROTO": self.proto,
            "SRC": self.source,
            "STAMP": self.stamp,
            "TARGETS": (self.proto / "ts", self.source / "ziyixi_proto"),
        }.items():
            patch.object(backend, name, value).start()

    @staticmethod
    def digest(path):
        return hashlib.sha256(path.read_bytes()).hexdigest()

    def test_host_build_asks_bazel_even_when_the_materialized_manifest_matches(self):
        self.assertTrue(backend.is_current())
        with (
            patch.object(backend.shutil, "which", return_value="/node"),
            patch.object(backend.subprocess, "run") as run,
        ):
            backend._ensure_generated()
        self.assertEqual(run.call_count, 1)
        self.assertEqual(run.call_args.args[0], ["/node", str(backend.ENSURE)])

    def test_pyodide_uses_current_host_output_without_starting_processes(self):
        with patch.object(backend.sys, "platform", "emscripten"), patch.object(backend.subprocess, "run") as run:
            backend._ensure_generated()
        run.assert_not_called()

    def test_lock_change_and_output_corruption_are_rejected_in_pyodide(self):
        for path in [self.input, self.py]:
            with self.subTest(path=path.name):
                original = path.read_bytes()
                path.write_bytes(original + b"changed")
                self.assertFalse(backend.is_current())
                with (
                    patch.object(backend.sys, "platform", "emscripten"),
                    self.assertRaisesRegex(RuntimeError, "Pyodide"),
                ):
                    backend._ensure_generated()
                path.write_bytes(original)

    def test_wheel_is_reproducible_and_does_not_ship_runtime_test_fixtures(self):
        fixture = self.source / "ziyixi_proto/prototest/v1/fixture.py"
        fixture.parent.mkdir(parents=True)
        fixture.write_text("# test-only\n")
        files = backend._package_files(self.source)
        first = self.proto / "first"
        second = self.proto / "second"
        first.mkdir()
        second.mkdir()
        name = backend._write_wheel(str(first), files)
        backend._write_wheel(str(second), files)
        self.assertEqual((first / name).read_bytes(), (second / name).read_bytes())
        with zipfile.ZipFile(first / name) as wheel:
            self.assertIn("ziyixi_proto/example/v1/example.py", wheel.namelist())
            self.assertFalse(any("/prototest/" in entry for entry in wheel.namelist()))
            self.assertNotIn("Requires-Dist:", wheel.read("ziyixi_proto-0.0.0.dist-info/METADATA").decode())


if __name__ == "__main__":
    unittest.main()

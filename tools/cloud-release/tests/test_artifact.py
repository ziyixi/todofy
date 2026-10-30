"""Promotion keeps compiled bytes, extra modules and the selected source configuration."""

import io
import json
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).absolute().parents[1]))
from artifact import digest, stage


class WorkerArtifactTests(unittest.TestCase):
    def bundle(self, root, app, files):
        source, artifact = root / "source", root / "artifact"
        artifact.mkdir()
        archive = artifact / "worker.tar.gz"
        with tarfile.open(archive, "w:gz") as tar:
            for name, content in files.items():
                member = tarfile.TarInfo(name)
                member.size = len(content)
                tar.addfile(member, io.BytesIO(content))
        (artifact / "manifest.json").write_text(
            json.dumps({"app": app, "sha": "a" * 40, "archive_sha256": digest(archive)})
        )
        return source, artifact

    def test_compiled_worker_and_text_modules_keep_exact_bytes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config = b'main="worker/src/index.ts"\n[assets]\ndirectory="web/dist"\n'
            source, artifact = self.bundle(
                root,
                "mailsort",
                {
                    "wrangler.toml": config,
                    "worker/index.js": b'import rules from "./rules.txt";\n',
                    "worker/rules.txt": b"original prompt",
                    "web/dist/index.html": b"compiled assets",
                },
            )
            (source / "mailsort").mkdir(parents=True)
            (source / "mailsort/wrangler.toml").write_bytes(config)
            stage("mailsort", "a" * 40, artifact, source)
            self.assertEqual(
                (source / "mailsort/.compiled/worker/rules.txt").read_bytes(),
                b"original prompt",
            )
            self.assertEqual(
                (source / "mailsort/.compiled/worker/index.js").read_bytes(),
                b'import rules from "./rules.txt";\n',
            )
            self.assertEqual(
                (source / "mailsort/web/dist/index.html").read_bytes(),
                b"compiled assets",
            )
            self.assertEqual((source / "mailsort/wrangler.toml").read_bytes(), config)

    def test_mismatched_source_and_changed_archive_are_refused(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source, artifact = self.bundle(root, "tasks", {"wrangler.toml": b"old"})
            (source / "tasks").mkdir(parents=True)
            (source / "tasks/wrangler.toml").write_bytes(b"new")
            with self.assertRaisesRegex(ValueError, "configuration"):
                stage("tasks", "a" * 40, artifact, source)
            with self.assertRaisesRegex(ValueError, "identity"):
                stage("tasks", "b" * 40, artifact, source)
            with (artifact / "worker.tar.gz").open("ab") as stream:
                stream.write(b"modified")
            with self.assertRaisesRegex(ValueError, "checksum"):
                stage("tasks", "a" * 40, artifact, source)

    def test_python_upload_uses_packaged_vendor_and_keeps_configuration(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            core = b'main="worker/todofy/runtime/entry.py"\nbase_dir="worker"\n'
            gateway = b'main="src/index.ts"\n[assets]\ndirectory="../uiassets/dist"\n'
            source, artifact = self.bundle(
                root,
                "todofy",
                {
                    "config/wrangler.toml": core,
                    "config/gateway/wrangler.toml": gateway,
                    "core/entry.py": b"compiled entry",
                    "core/python_modules/sdk.py": b"pinned runtime",
                    "gateway/index.js": b"compiled gateway",
                    "assets/index.html": b"compiled assets",
                },
            )
            for name, data in {
                "wrangler.toml": core,
                "gateway/wrangler.toml": gateway,
                "worker/source.py": b"old source",
            }.items():
                file = source / "todofy" / name
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_bytes(data)
            stage("todofy", "a" * 40, artifact, source)
            self.assertFalse((source / "todofy/worker/source.py").exists())
            self.assertEqual(
                (source / "todofy/python_modules/sdk.py").read_bytes(),
                b"pinned runtime",
            )
            self.assertEqual(
                (source / "todofy/uiassets/dist/index.html").read_bytes(),
                b"compiled assets",
            )
            self.assertEqual((source / "todofy/wrangler.toml").read_bytes(), core)


if __name__ == "__main__":
    unittest.main()

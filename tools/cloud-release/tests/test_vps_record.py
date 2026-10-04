import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from api import ReleaseError
from vps_record import receipt

SHA = "a" * 40
UUID = "6b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e"


class EvidenceTests(unittest.TestCase):
    def read(self, value):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "evidence.json"
            path.write_text(json.dumps(value))
            with patch.dict(os.environ, {"GITHUB_REPOSITORY": "example/cloud"}):
                return receipt(path)

    def value(self):
        return {
            "source_sha": SHA,
            "release": "releases/" + UUID,
            "etag": "version-2",
            "phase": "ready",
            "targets": [
                {
                    "workload_key": key,
                    "image_digest": "sha256:" + "b" * 64,
                    "source_sha": SHA,
                    "request_id": UUID,
                }
                for key in ("newsletter", "platform-runtime")
            ],
        }

    def test_current_release_receipt_preserves_exact_verified_identity(self):
        value = self.value()
        self.assertEqual(self.read(value), value)

    def test_held_partial_or_private_receipts_are_not_recorded(self):
        for change in ({"phase": "held"}, {"targets": []}, {"token": "synthetic"}):
            with self.subTest(change=change), self.assertRaises(ReleaseError):
                self.read({**self.value(), **change})

    def test_mixed_sources_and_mutable_tags_are_rejected(self):
        for change in (
            {"source_sha": "c" * 40},
            {"image_digest": "latest"},
            {"request_id": "unknown"},
        ):
            value = self.value()
            value["targets"][0].update(change)
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.read(value)


if __name__ == "__main__":
    unittest.main()

import copy
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

import mailhero_backup as legacy
import native_backup as native
from test_backup import BACKUP, EVENT, MESSAGE, NOW, SyntheticSnapshot


class NativeFixture:
    def __init__(self, root):
        self.root = root
        self.prefix = f"snapshots-v2/2026-09-26/{BACKUP}/"
        self.source = SyntheticSnapshot()
        stage = root / "source"
        stage.mkdir(mode=0o700)
        (stage / "objects").mkdir()
        index = legacy.collect_snapshot(self.source, stage)
        self.objects, files = {}, []
        by_path = {item["path"]: item for item in index["objects"]}
        for path in sorted(stage.rglob("*")):
            if not path.is_file() or path.name == "bundle.json": continue
            logical = path.relative_to(stage).as_posix()
            kind, object_key = "database", None
            if logical == "manifest.json": logical, kind = "source-manifest.json", "source_manifest"
            elif logical == "control.json": kind = "control"
            elif logical == "database-schema.json": kind = "schema"
            elif logical == "snapshot-deletions.json": kind = "deletions"
            elif logical.startswith("objects/"):
                kind, object_key = "object", by_path[logical]["key"]
                logical += ".bin"
            raw = path.read_bytes(); self.objects[self.prefix + logical] = raw
            files.append({"path": logical, "kind": kind, "bytes": len(raw), "sha256": legacy.digest(raw),
                          **({"object_key": object_key} if object_key else {})})
        source = json.loads((stage / "manifest.json").read_bytes())
        self.manifest = {"version": 2, "format": native.FORMAT, "encrypted": False, "backup_id": BACKUP,
            "created_at": NOW, "cut_at": source["cut_at"], "cut_seq": source["cut_seq"], "build_sha": "a" * 40,
            "source_manifest_sha256": index["manifest_sha256"], "credential_key_included": False, "files": files}
        self.refresh_manifest()

    def refresh_manifest(self):
        raw = legacy.canonical(self.manifest); key = self.prefix + "manifest.json"
        self.objects[key] = raw
        self.marker = {"version": 2, "backup_id": BACKUP, "key": key, "sha256": legacy.digest(raw),
            "manifest_sha256": legacy.digest(raw), "created_at": NOW, "verified_at": NOW,
            "size_bytes": sum(map(len, self.objects.values())), "object_count": len(self.objects), "proof": "native_readback_verified"}

    def replace_file(self, path, raw):
        file = next(item for item in self.manifest["files"] if item["path"] == path)
        file.update(bytes=len(raw), sha256=legacy.digest(raw)); self.objects[self.prefix + path] = raw

    def json(self, action, query=None):
        if action == "/artifacts/list-v2":
            return {"version": 2, "items": [self.marker], "cursor": None, "complete": True}, b""
        if action == "/artifacts/deletions": return {"items": [], "cursor": None}, b""
        if action == "/artifacts/list-v2-objects":
            keys = sorted(self.objects); offset = int((query or {}).get("cursor") or 0)
            items = [{"key": key, "size": len(self.objects[key]), "customMetadata": {"sha256": legacy.digest(self.objects[key]), "backup_id": BACKUP}}
                     for key in keys[offset:offset + 7]]
            cursor = str(offset + 7) if offset + 7 < len(keys) else None
            return {"version": 2, "objects": items, "cursor": cursor, "complete": cursor is None}, b""
        raise AssertionError("unexpected fixture route")

    def download(self, _action, query, stream, size, checksum):
        data = self.objects[query["key"]]
        legacy.require(len(data) == size and legacy.digest(data) == checksum, "object_sha256_mismatch")
        stream.write(data)


class NativeBackupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.root = Path(self.temp.name)
        self.root.chmod(0o700); self.fixture = NativeFixture(self.root)

    def tearDown(self):
        self.fixture.source.database.close(); self.temp.cleanup()

    def fetch(self, name="download"):
        path = self.root / name
        result = native.download(self.fixture, BACKUP, path)
        return path, result["receipt_sha256"]

    def recover(self, path, checksum, destination="restored", journal=None):
        return native.restore(path, checksum, self.root / destination, journal)

    def test_private_download_is_atomic_and_includes_fresh_deletion_ledger(self):
        with patch.object(legacy, "run_gpg", side_effect=AssertionError("native backups must not use GPG")):
            path, checksum = self.fetch()
        self.assertEqual(path.stat().st_mode & 0o777, 0o700)
        self.assertEqual(legacy.file_hash(path / "receipt.json"), checksum)
        journal = json.loads((path / "latest-deletions.json").read_bytes())
        self.assertEqual(journal["version"], 1)
        self.assertGreater(native.date(journal["fetched_at"]), native.date(NOW))
        with self.assertRaisesRegex(legacy.BackupError, "destination_must_be_new"): self.fetch()
        self.fixture.download = lambda *args: (_ for _ in ()).throw(legacy.BackupError("synthetic_network_failure"))
        with self.assertRaisesRegex(legacy.BackupError, "synthetic_network_failure"): self.fetch("failed-download")
        self.assertFalse((self.root / "failed-download").exists())
        self.assertFalse(list(self.root.glob(".native-download-*")))

    def test_roundtrip_without_gpg_reuses_legacy_restore_and_frozen_events(self):
        path, checksum = self.fetch()
        with patch.object(legacy, "run_gpg", side_effect=AssertionError("native backups must not use GPG")):
            state = self.recover(path, checksum)
        self.assertFalse(state["activation_allowed"])
        self.assertFalse(state["encrypted"])
        self.assertFalse(state["credential_key_envelope_available"])
        self.assertEqual(state["state"], "quarantined_missing_latest_deletions")
        conn = sqlite3.connect(self.root / "restored/database.sqlite")
        self.assertEqual(conn.execute("SELECT send_paused FROM app_settings").fetchone()[0], 1)
        self.assertEqual(conn.execute("SELECT event_id,payload_sha256,state FROM deliveries").fetchone(),
                         (EVENT, legacy.digest(self.fixture.source.payload), "failed"))
        conn.close()
        inventory = json.loads((self.root / "restored/r2-objects.json").read_bytes())["objects"]
        payload = next(item for item in inventory if item["key"] == f"payload/{EVENT}.json")
        self.assertEqual((self.root / "restored" / payload["path"]).read_bytes(), self.fixture.source.payload)

    def test_latest_deletion_journal_applied_and_activation_remains_disabled(self):
        path, checksum = self.fetch(); journal = self.root / "fresh-deletions.json"
        journal.write_bytes(legacy.canonical({"version": 1, "fetched_at": "2026-09-27T00:00:00Z",
            "items": [{"id": MESSAGE, "scope": "content", "deleted_at": "2026-09-26T01:00:00Z"}]}))
        state = self.recover(path, checksum, journal=journal)
        self.assertEqual(state["state"], "isolated_requires_reconciliation")
        self.assertEqual(state["objects_restored"], 0); self.assertFalse(state["activation_allowed"])

    def test_independent_receipt_anchor_and_file_corruption_fail_closed(self):
        path, checksum = self.fetch()
        with self.assertRaisesRegex(legacy.BackupError, "receipt_hash_mismatch"):
            self.recover(path, "0" * 64)
        target = next((path / "snapshot/objects").iterdir())
        raw = bytearray(target.read_bytes()); raw[0] ^= 1; target.write_bytes(raw)
        with self.assertRaisesRegex(legacy.BackupError, "file_hash_mismatch"):
            self.recover(path, checksum)
        self.assertFalse((self.root / "restored").exists())

    def test_downloaded_deletion_ledger_is_bound_to_receipt(self):
        path, checksum = self.fetch()
        target = path / "latest-deletions.json"; raw = bytearray(target.read_bytes()); raw[-1] ^= 1; target.write_bytes(raw)
        with self.assertRaisesRegex(legacy.BackupError, "file_hash_mismatch"): self.recover(path, checksum)

    def test_extra_file_and_symlink_are_rejected(self):
        path, checksum = self.fetch(); extra = path / "extra"; extra.write_bytes(b"untracked")
        with self.assertRaisesRegex(legacy.BackupError, "untracked_file"): self.recover(path, checksum)
        extra.unlink(); extra.symlink_to(self.root / "source")
        with self.assertRaisesRegex(legacy.BackupError, "unsafe_local_file"): self.recover(path, checksum)

    def test_traversal_unknown_format_and_duplicate_or_missing_entries(self):
        original = copy.deepcopy(self.fixture.manifest); cases = []
        bad = copy.deepcopy(original); bad["files"][0]["path"] = "../outside"; cases.append((bad, "logical_path"))
        bad = copy.deepcopy(original); bad["version"] = 3; cases.append((bad, "unsupported_manifest"))
        bad = copy.deepcopy(original); bad["encrypted"] = True; cases.append((bad, "unsupported_manifest"))
        bad = copy.deepcopy(original); bad["files"].pop(); cases.append((bad, "missing_or_extra_file"))
        bad = copy.deepcopy(original); bad["files"].append(bad["files"][0]); cases.append((bad, "duplicate_file"))
        for number, (manifest, error) in enumerate(cases):
            self.fixture.manifest = manifest; self.fixture.refresh_manifest(); path, checksum = self.fetch(f"bad-{number}")
            with self.subTest(error=error), self.assertRaisesRegex(legacy.BackupError, error):
                self.recover(path, checksum, f"no-restore-{number}")
            self.assertFalse((self.root / f"no-restore-{number}").exists())

    def test_manifest_file_hash_must_match_checked_download(self):
        target = next(file for file in self.fixture.manifest["files"] if file["kind"] == "database")
        target["sha256"] = "0" * 64; self.fixture.refresh_manifest(); path, checksum = self.fetch()
        with self.assertRaisesRegex(legacy.BackupError, "file_record_mismatch"): self.recover(path, checksum)

    def test_source_manifest_binding_is_not_bypassed(self):
        self.fixture.manifest["source_manifest_sha256"] = "0" * 64
        self.fixture.refresh_manifest(); path, checksum = self.fetch()
        with self.assertRaisesRegex(legacy.BackupError, "source_manifest_corrupt"): self.recover(path, checksum)

    def test_legacy_live_reference_check_rejects_hash_valid_missing_attachment(self):
        attachment = next(file for file in self.fixture.manifest["files"] if file["kind"] == "object" and file["object_key"].endswith("attachment-1"))
        self.fixture.manifest["files"].remove(attachment); self.fixture.objects.pop(self.fixture.prefix + attachment["path"])
        source = json.loads((self.root / "source/manifest.json").read_bytes())
        source["objects"] = [obj for obj in source["objects"] if obj["key"] != attachment["object_key"]]
        raw = legacy.canonical(source); self.fixture.replace_file("source-manifest.json", raw)
        self.fixture.manifest["source_manifest_sha256"] = legacy.digest(raw)
        self.fixture.refresh_manifest(); path, checksum = self.fetch()
        with self.assertRaisesRegex(legacy.BackupError, "backup_attachments_reference_missing"): self.recover(path, checksum)

    def test_inventory_path_cannot_escape_snapshot(self):
        self.fixture.objects[self.fixture.prefix + "../outside"] = b"untrusted"
        self.fixture.refresh_manifest()
        with self.assertRaisesRegex(legacy.BackupError, "logical_path"): self.fetch()
        self.assertFalse((self.root / "download").exists())


if __name__ == "__main__": unittest.main()

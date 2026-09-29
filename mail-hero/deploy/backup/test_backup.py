import datetime as dt
import hashlib
import hmac
import io
import json
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tarfile
import tempfile
import unittest

import mailhero_backup as backup

MESSAGE = "11111111-1111-4111-8111-111111111111"
EVENT = "22222222-2222-4222-8222-222222222222"
BACKUP = "33333333-3333-4333-8333-333333333333"
NOW = "2026-09-26T00:00:00.000Z"


class SyntheticSnapshot:
    """Local fixture using the repository's real SQLite/D1 table definitions."""
    def __init__(self):
        self.database = sqlite3.connect(":memory:")
        self.database.row_factory = sqlite3.Row
        for migration in sorted((Path(__file__).resolve().parents[2] / "cloudflare/migrations").glob("*.sql")):
            self.database.executescript(migration.read_text())
        self.database.execute("INSERT INTO webhook_endpoints(id,label,created_at,updated_at) VALUES('endpoint','Synthetic',?,?)", (NOW, NOW))
        self.database.execute("INSERT INTO endpoint_revisions(id,endpoint_id,revision,url,auth_type,credential_ciphertext,created_at) VALUES('revision','endpoint',1,'https://example.invalid/hook','bearer','synthetic-ciphertext',?)", (NOW,))
        parsed_key = f"parsed/{MESSAGE}/claim/message.json"
        attachment_key = f"parsed/{MESSAGE}/claim/attachment-1"
        self.payload = b'{"type":"mail.received.v1","event_id":"' + EVENT.encode() + b'","message":{"text":"Synthetic frozen bytes"}}'
        self.content = {
            f"raw/{MESSAGE}.eml": b"Subject: Synthetic backup fixture\r\n\r\nSynthetic body\r\n",
            parsed_key: backup.canonical({"text": "Synthetic body", "attachments": [{"r2_key": attachment_key}]}),
            attachment_key: b"synthetic attachment bytes",
            f"payload/{EVENT}.json": self.payload,
        }
        self.database.execute("""INSERT INTO messages(id,received_at,last_received_at,envelope_from,envelope_recipient,
            raw_key,size_bytes,receive_mode,parse_state,parsed_key,subject,content_bytes)
            VALUES(?,?,?,'sender@example.test','hero@example.test',?,42,'archive','ready',?,'Synthetic backup fixture',1000)""",
            (MESSAGE, NOW, NOW, f"raw/{MESSAGE}.eml", parsed_key))
        self.database.execute("""INSERT INTO deliveries(event_id,message_id,endpoint_revision_id,generation,payload_key,
            payload_sha256,payload_size_bytes,state,next_attempt_at,created_at)
            VALUES(?,?,'revision',1,?,?,?,'sending',?,?)""",
            (EVENT, MESSAGE, f"payload/{EVENT}.json", backup.digest(self.payload), len(self.payload), NOW, NOW))
        self.database.execute("INSERT INTO message_search VALUES(?,0,'Synthetic indexed content')", (MESSAGE,))
        # Exercise sequential pagination rather than only empty or one-row pages.
        self.database.executemany("INSERT INTO audit_log(id,owner,action,resource_type,created_at) VALUES(?,'owner','synthetic','test',?)", [(str(i), NOW) for i in range(103)])
        self.database.commit()
        self.blocks = {}
        self.cancelled = False
        self.refresh_objects()

    def refresh_objects(self):
        self.objects = [{"key": key, "size": len(value), "etag": backup.digest(value)[:32], "uploaded": NOW,
            "customMetadata": {"synthetic": "yes", "ingest_seq": "1"}, "httpMetadata": {"contentType": "application/octet-stream"}}
            for key, value in sorted(self.content.items())]

    def json(self, action, query=None, payload=None):
        query = query or {}
        if action in ("/begin", "/status"):
            return {"backup_id": BACKUP, "state": "ready", "created_at": NOW, "expires_at": 9_999_999_999_999}, b""
        if action == "/cancel":
            self.cancelled = True
            return {"state": "cancelled"}, b""
        if action == "/artifacts/deletions":
            return {"items": [], "cursor": None}, b""
        if action == "/objects":
            return {"objects": self.objects, "complete": True, "next_cursor": None}, b""
        if action == "/manifest":
            value = {"version": 1, "backup_id": BACKUP, "created_at": NOW, "cut_at": NOW, "cut_seq": 1,
                "blocks": sorted(self.blocks.values(), key=lambda x: x["name"]), "objects": self.objects, "credential_key_included": False}
            return {"manifest": value, "manifest_sha256": backup.digest(backup.canonical(value))}, b""
        if action == "/control":
            name, value = "control.json", {"version": 1, "cut_seq": 1, "jobs": [], "uploads": [], "alarm_restore": "rebuild_and_force_pause"}
        elif action == "/database-schema":
            schema = [dict(row) for row in self.database.execute("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY type,name")]
            name, value = "database-schema.json", {"schema": schema, "tables": [r["name"] for r in schema if r["type"] == "table"]}
        elif action == "/database":
            table, offset = query["table"], query["offset"]
            rows = [dict(row) for row in self.database.execute(f'SELECT * FROM "{table}" ORDER BY rowid LIMIT 100 OFFSET ?', (offset,))]
            name, value = f"database/{table}/{offset}.json", {"table": table, "offset": offset, "rows": rows, "next_offset": offset + 100 if len(rows) == 100 else None}
        else:
            raise AssertionError(action)
        raw = backup.canonical(value)
        self.blocks[name] = {"name": name, "sha256": backup.digest(raw), "bytes": len(raw)}
        return value, raw

    def download(self, action, query, target, expected_size, expected_hash=None, expected_etag=None):
        value = self.content[query["key"]]
        backup.require(len(value) == expected_size, "object_size_mismatch")
        backup.require(expected_etag == backup.digest(value)[:32], "object_etag_mismatch")
        target.write(value)
        return backup.digest(value)


class BackupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.snapshot = self.root / "snapshot"
        self.snapshot.mkdir()
        (self.snapshot / "objects").mkdir()
        self.client = SyntheticSnapshot()
        self.index = backup.collect_snapshot(self.client, self.snapshot)
        self.archive = self.root / "fixture.tar.gz"
        backup.create_archive(self.snapshot, self.archive)

    def tearDown(self):
        self.client.database.close()
        self.temp.cleanup()

    def new_stage(self, name):
        stage = self.root / name
        stage.mkdir()
        (stage / "objects").mkdir()
        return stage

    def archive_without_objects(self, name, missing_keys):
        # Build a self-consistent, valid-hash archive whose inventory omitted
        # an object that its D1 rows still reference. This models a lost source
        # R2 object, not merely a corrupted archive entry.
        stage = self.root / name
        shutil.copytree(self.snapshot, stage)
        index = json.loads((stage / "bundle.json").read_bytes())
        manifest = json.loads((stage / "manifest.json").read_bytes())
        for item in index["objects"]:
            if item["key"] in missing_keys:
                (stage / item["path"]).unlink()
        index["objects"] = [item for item in index["objects"] if item["key"] not in missing_keys]
        manifest["objects"] = [item for item in manifest["objects"] if item["key"] not in missing_keys]
        index["manifest_sha256"] = backup.digest(backup.canonical(manifest))
        (stage / "bundle.json").write_bytes(backup.canonical(index))
        (stage / "manifest.json").write_bytes(backup.canonical(manifest))
        archive = self.root / (name + ".tar.gz")
        backup.create_archive(stage, archive)
        return archive

    def test_collection_and_restore_reject_missing_live_references_with_valid_hashes(self):
        cases = {"raw": f"raw/{MESSAGE}.eml", "parsed": f"parsed/{MESSAGE}/claim/message.json",
                 "attachments": f"parsed/{MESSAGE}/claim/attachment-1", "payloads": f"payload/{EVENT}.json"}
        original_objects = self.client.objects
        for kind, key in cases.items():
            with self.subTest(kind=kind):
                self.client.objects = [item for item in original_objects if item["key"] != key]
                self.client.cancelled = False
                with self.assertRaisesRegex(backup.BackupError, f"backup_{kind}_reference_missing"):
                    backup.collect_snapshot(self.client, self.new_stage("missing-" + kind))
                self.assertTrue(self.client.cancelled)
                incomplete = self.archive_without_objects("omitted-" + kind, {key})
                destination = self.root / ("restore-" + kind)
                with self.assertRaisesRegex(backup.BackupError, f"backup_{kind}_reference_missing"):
                    backup.restore_archive(incomplete, destination)
                self.assertFalse(destination.exists())
        self.client.objects = original_objects

    def test_explicit_raw_expiry_and_omitted_attachment_are_valid(self):
        raw_key = f"raw/{MESSAGE}.eml"
        parsed_key = f"parsed/{MESSAGE}/claim/message.json"
        attachment_key = f"parsed/{MESSAGE}/claim/attachment-1"
        self.client.database.execute("UPDATE messages SET raw_expired_at=?,raw_key=NULL", (NOW,))
        self.client.content.pop(raw_key)
        self.client.content.pop(attachment_key)
        self.client.content[parsed_key] = backup.canonical({"text": "Synthetic body", "attachments": [
            {"filename": "omitted.bin", "storage_status": "omitted", "omitted_reason": "size_limit", "size": 3 * 1024 * 1024}]})
        self.client.refresh_objects()
        stage = self.new_stage("intentional-omissions")
        index = backup.collect_snapshot(self.client, stage)
        self.assertEqual(index["reference_validation"], {"messages": 1, "raw": 0, "parsed": 1, "attachments": 0, "payloads": 1})
        archive = self.root / "intentional.tar.gz"
        backup.create_archive(stage, archive)
        state = backup.restore_archive(archive, self.root / "intentional-restored")
        self.assertEqual(state["reference_validation"], index["reference_validation"])

    def test_deleted_and_synthetic_messages_do_not_require_raw_originals(self):
        self.client.database.execute("UPDATE messages SET origin='synthetic_test',raw_key=NULL")
        self.client.content.pop(f"raw/{MESSAGE}.eml")
        self.client.refresh_objects()
        index = backup.collect_snapshot(self.client, self.new_stage("synthetic-no-raw"))
        self.assertEqual(index["reference_validation"]["raw"], 0)
        self.client.database.execute("UPDATE messages SET content_deleted_at=?", (NOW,))
        self.client.content.clear()
        self.client.refresh_objects()
        index = backup.collect_snapshot(self.client, self.new_stage("deleted-no-content"))
        self.assertEqual(index["reference_validation"], {"messages": 1, "raw": 0, "parsed": 0, "attachments": 0, "payloads": 0})

    def test_event_construction_failure_is_not_a_missing_payload(self):
        self.client.database.execute("UPDATE deliveries SET state='failed',last_error='invalid_payload',payload_key=NULL,payload_size_bytes=0,payload_sha256=?", (backup.digest(b""),))
        self.client.content.pop(f"payload/{EVENT}.json")
        self.client.refresh_objects()
        index = backup.collect_snapshot(self.client, self.new_stage("construction-failure"))
        self.assertEqual(index["reference_validation"]["payloads"], 0)
        self.client.database.execute("UPDATE deliveries SET state='pending',last_error=NULL")
        with self.assertRaisesRegex(backup.BackupError, "backup_payloads_reference_missing"):
            backup.collect_snapshot(self.client, self.new_stage("missing-pending-payload"))

    def test_orphan_delivery_and_ready_message_without_parsed_key_fail_closed(self):
        self.client.database.execute("UPDATE messages SET parsed_key=NULL")
        with self.assertRaisesRegex(backup.BackupError, "backup_parsed_reference_missing"):
            backup.collect_snapshot(self.client, self.new_stage("ready-missing-parsed-key"))
        self.client.database.rollback()
        self.client.database.execute("PRAGMA foreign_keys=OFF")
        self.client.database.execute("DELETE FROM messages")
        with self.assertRaisesRegex(backup.BackupError, "backup_delivery_message_missing"):
            backup.collect_snapshot(self.client, self.new_stage("orphan-delivery"))

    def test_frozen_payload_must_match_database_hash_and_stored_attachment_requires_key(self):
        self.client.content[f"payload/{EVENT}.json"] += b" "
        self.client.refresh_objects()
        with self.assertRaisesRegex(backup.BackupError, "backup_payload_reference_mismatch"):
            backup.collect_snapshot(self.client, self.new_stage("changed-frozen-payload"))
        self.client.content[f"payload/{EVENT}.json"] = self.client.payload
        self.client.content[f"parsed/{MESSAGE}/claim/message.json"] = backup.canonical({"text": "Body", "attachments": [{"storage_status": "stored"}]})
        self.client.refresh_objects()
        with self.assertRaisesRegex(backup.BackupError, "backup_attachments_reference_missing"):
            backup.collect_snapshot(self.client, self.new_stage("missing-attachment-key"))

    def test_latest_deletion_can_exclude_unneeded_missing_content_on_restore(self):
        incomplete = self.archive_without_objects("previous-missing-content", set(self.client.content))
        journal = self.root / "newest-deletions.json"
        journal.write_bytes(backup.canonical({"version": 1, "fetched_at": "2026-09-27T00:00:00Z", "items": [{"id": MESSAGE, "scope": "content", "deleted_at": NOW}]}))
        state = backup.restore_archive(incomplete, self.root / "deleted-missing-restored", journal)
        self.assertEqual(state["objects_restored"], 0)
        self.assertEqual(state["reference_validation"], {"messages": 1, "raw": 0, "parsed": 0, "attachments": 0, "payloads": 0})

    def test_collect_and_isolated_restore_preserve_frozen_bytes_and_pause_delivery(self):
        destination = self.root / "restored"
        state = backup.restore_archive(self.archive, destination)
        self.assertEqual(state["state"], "quarantined_missing_latest_deletions")
        self.assertFalse(state["activation_allowed"])
        self.assertFalse(state["do_alarm_restored"])
        self.assertTrue((self.snapshot / "database/audit_log/100.json").exists())
        db = sqlite3.connect(destination / "database.sqlite")
        self.assertEqual(db.execute("SELECT send_paused FROM app_settings").fetchone()[0], 1)
        self.assertEqual(db.execute("SELECT paused FROM webhook_endpoints").fetchone()[0], 1)
        self.assertEqual(db.execute("SELECT state,last_error FROM deliveries").fetchone(), ("failed", "restore_reconciliation_required"))
        self.assertEqual(db.execute("SELECT count(*) FROM audit_log").fetchone()[0], 103)
        db.close()
        restored = json.loads((destination / "r2-objects.json").read_bytes())["objects"]
        payload = next(item for item in restored if item["key"] == f"payload/{EVENT}.json")
        self.assertEqual((destination / payload["path"]).read_bytes(), self.client.payload)
        self.assertEqual(payload["customMetadata"], {"synthetic": "yes", "ingest_seq": "1"})
        # The SQL artifact is loadable into an independently empty SQLite/D1-compatible database.
        loaded = sqlite3.connect(":memory:")
        loaded.executescript((destination / "database.sql").read_text())
        self.assertEqual(loaded.execute("SELECT send_paused FROM app_settings").fetchone()[0], 1)
        loaded.close()

    def test_latest_content_deletion_prevents_object_and_search_resurrection(self):
        journal = self.root / "latest-deletions.json"
        journal.write_bytes(backup.canonical({"version": 1, "fetched_at": "2026-09-27T00:00:00Z", "items": [{"id": MESSAGE, "scope": "content", "deleted_at": "2026-09-26T02:00:00Z"}]}))
        state = backup.restore_archive(self.archive, self.root / "deleted", journal)
        self.assertEqual(state["objects_restored"], 0)
        self.assertFalse(state["activation_allowed"])
        db = sqlite3.connect(self.root / "deleted/database.sqlite")
        self.assertEqual(db.execute("SELECT count(*) FROM message_search").fetchone()[0], 0)
        self.assertEqual(db.execute("SELECT raw_key,parsed_key,subject FROM messages").fetchone(), (None, None, None))
        self.assertEqual(db.execute("SELECT state,payload_key FROM deliveries").fetchone(), ("cancelled", None))
        self.assertEqual(db.execute("SELECT logical_bytes FROM app_settings").fetchone()[0], 0)
        self.assertEqual(db.execute("SELECT pending_delete_bytes FROM messages").fetchone()[0], 0)
        db.close()

    def test_raw_expiry_preserves_parsed_body_and_frozen_event(self):
        journal = self.root / "latest-deletions.json"
        journal.write_bytes(backup.canonical({"version": 1, "fetched_at": "2026-09-27T00:00:00Z", "items": [{"id": MESSAGE, "scope": "raw", "deleted_at": "2026-09-26T02:00:00Z"}]}))
        state = backup.restore_archive(self.archive, self.root / "raw-expired", journal)
        self.assertEqual(state["objects_restored"], 3)
        db = sqlite3.connect(self.root / "raw-expired/database.sqlite")
        self.assertIsNone(db.execute("SELECT raw_key FROM messages").fetchone()[0])
        self.assertIsNotNone(db.execute("SELECT parsed_key FROM messages").fetchone()[0])
        self.assertEqual(db.execute("SELECT raw_purged_at FROM messages").fetchone()[0], "2026-09-26T02:00:00Z")
        self.assertEqual(db.execute("SELECT logical_bytes FROM app_settings").fetchone()[0], 958 + len(self.client.payload))
        db.close()

    def test_database_tombstone_alone_excludes_objects_pending_source_purge(self):
        self.client.database.execute("UPDATE messages SET content_deleted_at=?,raw_key=NULL,parsed_key=NULL,content_bytes=0", (NOW,))
        self.client.database.commit()
        stage = self.root / "tombstone-snapshot"
        stage.mkdir()
        (stage / "objects").mkdir()
        backup.collect_snapshot(self.client, stage)
        archived = self.root / "tombstone.tar.gz"
        backup.create_archive(stage, archived)
        state = backup.restore_archive(archived, self.root / "tombstone-restored")
        self.assertEqual(state["objects_restored"], 0)
        self.assertEqual(state["state"], "quarantined_missing_latest_deletions")

    def test_corruption_and_existing_restore_destination_fail_closed(self):
        target = self.snapshot / self.index["objects"][0]["path"]
        target.write_bytes(b"corrupt")
        backup.create_archive(self.snapshot, self.archive)
        with self.assertRaisesRegex(backup.BackupError, "backup_object_corrupt"):
            backup.restore_archive(self.archive, self.root / "corrupt")
        self.assertFalse((self.root / "corrupt").exists())
        with self.assertRaisesRegex(backup.BackupError, "restore_destination_must_be_new"):
            backup.restore_archive(self.archive, self.snapshot)

    def test_tar_path_traversal_and_symlinks_are_rejected(self):
        for name, kind in [("../escape", tarfile.REGTYPE), ("link", tarfile.SYMTYPE)]:
            bad = self.root / "bad.tar.gz"
            with tarfile.open(bad, "w:gz") as archive:
                item = tarfile.TarInfo(name)
                item.type = kind
                item.linkname = "/etc/passwd"
                archive.addfile(item, io.BytesIO())
            with self.assertRaisesRegex(backup.BackupError, "unsafe_archive_entry"):
                backup.restore_archive(bad, self.root / "unsafe")
        self.assertFalse((self.root / "escape").exists())

    def test_failed_collection_cancels_lease(self):
        old = self.client.download
        def fail(*args, **kwargs):
            raise backup.BackupError("synthetic_download_failure")
        self.client.download = fail
        stage = self.root / "failed"
        stage.mkdir()
        (stage / "objects").mkdir()
        with self.assertRaisesRegex(backup.BackupError, "synthetic_download_failure"):
            backup.collect_snapshot(self.client, stage)
        self.assertTrue(self.client.cancelled)
        self.client.download = old

    @unittest.skipUnless(shutil.which("gpg"), "GPG is not installed; crypto round-trip runs in CI when available")
    def test_ephemeral_public_key_encryption_and_private_device_restore(self):
        home = self.root / "recovery-keyring"
        home.mkdir(mode=0o700)
        args = ["gpg", "--batch", "--homedir", str(home), "--pinentry-mode", "loopback", "--passphrase", ""]
        subprocess.run([*args, "--quick-generate-key", "Mail Hero Synthetic <fixture@example.test>", "rsa2048", "encr", "1d"], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        listing = subprocess.check_output([*args, "--with-colons", "--fingerprint", "--list-keys"], stderr=subprocess.DEVNULL).decode()
        fingerprint = next(line.split(":")[9] for line in listing.splitlines() if line.startswith("fpr:"))
        public = self.root / "public.asc"
        public.write_bytes(subprocess.check_output([*args, "--armor", "--export", fingerprint], stderr=subprocess.DEVNULL))
        app_key = self.root / "synthetic-app-key"
        app_key.write_bytes(b"ab" * 32)
        with self.assertRaisesRegex(backup.BackupError, "encrypted_credential_key_envelope_required"):
            backup.add_key_envelope(self.snapshot, self.index, app_key)
        escrow = self.root / "synthetic-key.gpg"
        backup.encrypt_archive(app_key, escrow, public, fingerprint)
        backup.add_key_envelope(self.snapshot, self.index, escrow)
        backup.create_archive(self.snapshot, self.archive)
        encrypted = self.root / "fixture.tar.gz.gpg"
        backup.encrypt_archive(self.archive, encrypted, public, fingerprint)
        decrypted = self.root / "decrypted.tar.gz"
        backup.run_gpg(["--homedir", str(home), "--output", str(decrypted), "--decrypt", str(encrypted)], stdout=subprocess.DEVNULL)
        self.assertEqual(backup.file_hash(self.archive), backup.file_hash(decrypted))
        state = backup.restore_archive(decrypted, self.root / "crypto-restored")
        self.assertFalse(state["activation_allowed"])
        self.assertTrue(state["credential_key_envelope_available"])
        self.assertEqual((self.root / "crypto-restored/credential-key.gpg").read_bytes(), escrow.read_bytes())


class RetentionTests(unittest.TestCase):
    def test_local_rotation_keeps_daily_weekly_and_never_unverified_files(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for number in range(40):
                date = dt.datetime(2026, 9, 26, tzinfo=dt.timezone.utc) - dt.timedelta(days=number)
                name = f"{date.date()}-synthetic-{number}.tar.gz.gpg"
                (root / name).write_bytes(b"synthetic ciphertext")
                (root / (name + ".receipt.json")).write_bytes(backup.canonical({"verified_at": date.isoformat()}))
            (root / "unverified.tar.gz.gpg").write_bytes(b"do not prune")
            backup.rotate_local(root)
            count = len(list(root.glob("*.receipt.json")))
            self.assertGreaterEqual(count, 7)
            self.assertLessEqual(count, 11)
            self.assertTrue((root / "unverified.tar.gz.gpg").exists())


class ArtifactVerificationTests(unittest.TestCase):
    def test_finish_requires_full_remote_readback_and_valid_separate_receipt(self):
        class Artifacts:
            def __init__(self, corrupt=False):
                self.corrupt, self.parts, self.finished = corrupt, [], False
                self.key = f"snapshots/2026-09-26/{BACKUP}.tar.gz.gpg"

            def json(self, action, query=None, payload=None):
                if action == "/artifacts/begin":
                    self.expected = payload
                    return {"key": self.key, "upload_id": "synthetic-upload", "part_size": backup.PART_BYTES}, b""
                if action == "/artifacts/complete":
                    self.remote = b"".join(self.parts)
                    return {"key": self.key, "size_bytes": len(self.remote), "sha256": self.expected["sha256"], "manifest_sha256": self.expected["manifest_sha256"]}, b""
                if action == "/finish":
                    assert self.downloaded
                    expected_mac = hmac.new(bytes.fromhex("ab" * 32), backup.canonical(payload["receipt"]), hashlib.sha256).hexdigest()
                    assert payload["receipt_mac"] == expected_mac
                    self.finished = True
                    return {"state": "remote_verified"}, b""
                raise AssertionError(action)

            def open(self, action, query, data=None, method=None):
                assert action == "/artifacts/part" and method == "PUT"
                self.parts.append(data)
                return io.BytesIO(backup.canonical({"partNumber": query["part_number"], "etag": "synthetic-part"}))

            def download(self, action, query, target, size, checksum):
                assert action == "/artifacts/object" and target is None
                self.downloaded = True
                value = self.remote + b"corrupt" if self.corrupt else self.remote
                backup.require(len(value) == size and backup.digest(value) == checksum, "object_sha256_mismatch")

        with tempfile.TemporaryDirectory() as temporary:
            encrypted = Path(temporary) / "synthetic.gpg"
            encrypted.write_bytes(b"opaque synthetic ciphertext")
            index = {"backup_id": BACKUP, "manifest_sha256": "ef" * 32}
            good = Artifacts()
            receipt = backup.upload_verified(good, encrypted, index, "ab" * 32)
            self.assertTrue(good.finished)
            self.assertEqual(receipt["archive_sha256"], backup.file_hash(encrypted))
            bad = Artifacts(corrupt=True)
            with self.assertRaisesRegex(backup.BackupError, "object_sha256_mismatch"):
                backup.upload_verified(bad, encrypted, index, "ab" * 32)
            self.assertFalse(bad.finished)


if __name__ == "__main__":
    unittest.main()

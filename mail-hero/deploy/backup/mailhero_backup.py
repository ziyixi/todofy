#!/usr/bin/env python3
"""Bounded, private snapshot collection and offline isolated restore.

Only collect/deletions contact Mail Hero. Restore writes a NEW local directory;
it never imports a live D1 database, publishes R2 objects, or starts a Worker.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import hmac
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import sqlite3
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

PREFIX = "/api/internal/backup"
MAX_JSON = 32 * 1024 * 1024
MAX_OBJECT = 64 * 1024 * 1024
MAX_ENTRIES = 250_000
PART_BYTES = 16 * 1024 * 1024
CHUNK = 1024 * 1024
TABLE = re.compile(r"^[a-zA-Z_][a-zA-Z0-9_]*$")
HEX = re.compile(r"^[a-f0-9]{64}$")


class BackupError(Exception):
    """A deliberately content-free error suitable for scheduler logs."""


def require(condition, code):
    if not condition:
        raise BackupError(code)


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


def digest(data):
    return hashlib.sha256(data).hexdigest()


def file_hash(path):
    result = hashlib.sha256()
    with open(path, "rb") as source:
        for block in iter(lambda: source.read(CHUNK), b""):
            result.update(block)
    return result.hexdigest()


def private_directory(path):
    path = Path(path).absolute()
    if not path.exists():
        path.mkdir(parents=True, mode=0o700)
    mode = path.lstat().st_mode
    require(stat.S_ISDIR(mode) and not stat.S_ISLNK(mode) and mode & 0o077 == 0, "output_directory_must_be_private")
    return path


def write_private(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with path.open("xb") as target:
        os.chmod(path, 0o600)
        target.write(data)


def atomic_json(path, value):
    path = Path(path)
    with tempfile.NamedTemporaryFile(dir=path.parent, prefix=".metadata-", delete=False) as target:
        name = target.name
        target.write(canonical(value))
        target.flush()
        os.fsync(target.fileno())
    os.replace(name, path)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise BackupError("redirect_refused")


class Client:
    def __init__(self, origin, token, access_id="", access_secret="", timeout=90):
        parsed = urllib.parse.urlsplit(origin)
        require(parsed.scheme == "https" and parsed.hostname and not parsed.username and not parsed.password and
                parsed.path in ("", "/") and not parsed.query and not parsed.fragment, "invalid_https_origin")
        require(len(token) >= 32 and not any(c in token for c in "\r\n\0"), "invalid_backup_token")
        require(bool(access_id) == bool(access_secret), "incomplete_access_service_credentials")
        self.origin = origin.rstrip("/")
        self.headers = {"Authorization": "Bearer " + token, "User-Agent": "MailHeroBackup/1.0"}
        if access_id:
            self.headers.update({"CF-Access-Client-Id": access_id, "CF-Access-Client-Secret": access_secret})
        self.opener = urllib.request.build_opener(NoRedirect())
        self.timeout = timeout

    def open(self, action, query=None, payload=None, data=None, method=None):
        require(action.startswith("/") and not action.startswith("//") and "?" not in action, "invalid_api_path")
        query = {k: v for k, v in (query or {}).items() if v is not None}
        url = self.origin + PREFIX + action + ("?" + urllib.parse.urlencode(query) if query else "")
        headers = dict(self.headers)
        if payload is not None:
            data = canonical(payload)
            headers["Content-Type"] = "application/json"
        if data is not None:
            headers["Content-Length"] = str(len(data))
        req = urllib.request.Request(url, data=data, headers=headers, method=method or ("POST" if data is not None else "GET"))
        try:
            return self.opener.open(req, timeout=self.timeout)
        except urllib.error.HTTPError as exc:
            exc.close()
            raise BackupError("api_http_" + str(exc.code)) from None
        except (urllib.error.URLError, TimeoutError, OSError):
            raise BackupError("api_network_failed") from None

    def json(self, action, query=None, payload=None):
        with self.open(action, query, payload) as response:
            raw = response.read(MAX_JSON + 1)
            require(len(raw) <= MAX_JSON, "api_json_budget_exceeded")
            expected = response.headers.get("X-Content-SHA256")
            if expected:
                require(digest(raw) == expected, "api_block_hash_mismatch")
            try:
                result = json.loads(raw)
            except (ValueError, UnicodeError):
                raise BackupError("invalid_api_json") from None
            return result, raw

    def download(self, action, query, target, expected_size, expected_hash=None, expected_etag=None):
        require(isinstance(expected_size, int) and 0 <= expected_size, "invalid_object_size")
        size = 0
        checksum = hashlib.sha256()
        with self.open(action, query) as response:
            if expected_etag:
                require(response.headers.get("ETag", "").strip('"') == expected_etag.strip('"'), "object_etag_mismatch")
            while True:
                block = response.read(CHUNK)
                if not block:
                    break
                size += len(block)
                require(size <= expected_size, "object_size_mismatch")
                checksum.update(block)
                if target:
                    target.write(block)
        require(size == expected_size, "object_size_mismatch")
        checksum = checksum.hexdigest()
        require(expected_hash is None or checksum == expected_hash, "object_sha256_mismatch")
        return checksum


def latest_deletions(client):
    cursor, seen, items = None, set(), {}
    while True:
        page, _ = client.json("/artifacts/deletions", {"cursor": cursor})
        for item in page.get("items", []):
            require(isinstance(item, dict) and item.get("scope") in ("raw", "content") and isinstance(item.get("id"), str), "invalid_deletion_journal")
            uuid.UUID(item["id"])
            key = item["id"] + ":" + item["scope"]
            if key not in items or item["deleted_at"] > items[key]["deleted_at"]:
                items[key] = item
        require(len(items) <= MAX_ENTRIES, "deletion_journal_budget_exceeded")
        cursor = page.get("cursor") or page.get("next_cursor")
        if not cursor:
            break
        require(cursor not in seen, "deletion_journal_cursor_loop")
        seen.add(cursor)
    return {"version": 1, "fetched_at": dt.datetime.now(dt.timezone.utc).isoformat(), "items": sorted(items.values(), key=lambda item: (item["id"], item["scope"]))}


def exported_rows(stage, table):
    """Stream a table's checked export pages without retaining message content."""
    quote_identifier(table)
    offset = 0
    while True:
        page = json.loads((stage / f"database/{table}/{offset}.json").read_bytes())
        require(page.get("table") == table and page.get("offset") == offset and isinstance(page.get("rows"), list), "database_page_mismatch")
        yield from page["rows"]
        if page.get("next_offset") is None:
            return
        require(page["next_offset"] == offset + 100, "database_page_cursor_invalid")
        offset += 100


def validate_live_references(read_rows, objects, stage, deletions=()):
    """Reject a hash-valid inventory that omits content still referenced by D1.

    Deleted content, expired raw bytes, intentionally omitted attachment copies,
    and explicit event-construction failures do not require nonexistent objects.
    Only counts and content-free error codes leave this function.
    """
    by_key = {item["key"]: item for item in objects}
    require(len(by_key) == len(objects), "duplicate_snapshot_object")
    deleted_ids = {item["id"] for item in deletions if item.get("scope") == "content"}
    expired_raw_ids = {item["id"] for item in deletions if item.get("scope") == "raw"}
    messages = {}
    counts = {"messages": 0, "raw": 0, "parsed": 0, "attachments": 0, "payloads": 0}

    def referenced(key, kind):
        require(isinstance(key, str) and bool(key) and key in by_key, f"backup_{kind}_reference_missing")
        counts[kind] += 1
        return by_key[key]

    for message in read_rows("messages"):
        message_id = message["id"]
        deleted = bool(message.get("content_deleted_at")) or message_id in deleted_ids
        messages[message_id] = deleted
        counts["messages"] += 1
        if deleted:
            continue
        if not message.get("raw_expired_at") and message_id not in expired_raw_ids:
            # Synthetic endpoint tests intentionally have no RFC822 original.
            if message.get("origin", "cloudflare") != "synthetic_test" or message.get("raw_key"):
                referenced(message.get("raw_key"), "raw")
        parsed_key = message.get("parsed_key")
        if parsed_key or message.get("parse_state") == "ready":
            parsed = referenced(parsed_key, "parsed")
            try:
                content = json.loads((stage / parsed["path"]).read_bytes())
            except (ValueError, UnicodeError):
                raise BackupError("backup_parsed_reference_invalid") from None
            require(isinstance(content, dict) and isinstance(content.get("attachments"), list), "backup_parsed_reference_invalid")
            for attachment in content["attachments"]:
                require(isinstance(attachment, dict), "backup_attachment_reference_invalid")
                if attachment.get("storage_status") == "omitted":
                    continue
                referenced(attachment.get("r2_key"), "attachments")
    for delivery in read_rows("deliveries"):
        require(delivery["message_id"] in messages, "backup_delivery_message_missing")
        if messages[delivery["message_id"]]:
            continue
        key = delivery.get("payload_key")
        if key is None and delivery.get("state") == "failed" and delivery.get("last_error") in ("invalid_payload", "message_needs_review"):
            require(delivery.get("payload_size_bytes") == 0 and delivery.get("payload_sha256") == digest(b""), "backup_payload_reference_missing")
            continue
        item = referenced(key, "payloads")
        require(item["sha256"] == delivery.get("payload_sha256") and item["size"] == delivery.get("payload_size_bytes"), "backup_payload_reference_mismatch")
    return counts


def collect_snapshot(client, stage, lease_seconds=1800):
    """Returns a verified local snapshot while keeping the lease active."""
    status, _ = client.json("/begin", payload={"lease_seconds": lease_seconds})
    backup_id = status.get("backup_id")
    uuid.UUID(backup_id)
    try:
        while status.get("state") != "ready":
            require(status.get("state") in ("draining", "settling") and status.get("backup_id") == backup_id, "backup_lease_not_ready")
            require(time.time() * 1000 < status["expires_at"], "backup_lease_expired")
            time.sleep(2)
            status, _ = client.json("/status")
        common = {"backup_id": backup_id}
        blocks = {}

        def save_block(action, name, query=None):
            value, raw = client.json(action, {**common, **(query or {})})
            require(canonical(value) == raw, "noncanonical_backup_block")
            write_private(stage / name, raw)
            blocks[name] = {"name": name, "sha256": digest(raw), "bytes": len(raw)}
            return value

        save_block("/control", "control.json")
        schema = save_block("/database-schema", "database-schema.json")
        for table in schema["tables"]:
            require(isinstance(table, str) and TABLE.fullmatch(table), "invalid_table_name")
            offset = 0
            while True:
                name = f"database/{table}/{offset}.json"
                page = save_block("/database", name, {"table": table, "offset": offset})
                require(page["table"] == table and page["offset"] == offset and len(page["rows"]) <= 100, "invalid_database_page")
                next_offset = page["next_offset"]
                if next_offset is None:
                    break
                require(next_offset == offset + 100 and len(page["rows"]) == 100, "invalid_database_cursor")
                offset = next_offset
                require(len(blocks) <= MAX_ENTRIES, "database_page_budget_exceeded")
        cursor, seen_cursors, objects = None, set(), {}
        while True:
            page, _ = client.json("/objects", {**common, "cursor": cursor})
            for item in page["objects"]:
                key = item["key"]
                require(isinstance(key, str) and key not in objects and 0 <= item["size"] <= MAX_OBJECT, "invalid_snapshot_object")
                path = "objects/" + digest(key.encode("utf-8"))
                with (stage / path).open("xb") as target:
                    checksum = client.download("/object", {**common, "key": key}, target, item["size"], expected_etag=item["etag"])
                objects[key] = {**item, "path": path, "sha256": checksum}
            require(len(objects) <= MAX_ENTRIES, "object_count_budget_exceeded")
            if page["complete"]:
                break
            cursor = page["next_cursor"]
            require(cursor and cursor not in seen_cursors, "object_cursor_loop")
            seen_cursors.add(cursor)
        exported, _ = client.json("/manifest", common)
        manifest = exported["manifest"]
        manifest_hash = exported["manifest_sha256"]
        require(digest(canonical(manifest)) == manifest_hash and manifest["backup_id"] == backup_id, "manifest_hash_mismatch")
        require(len(manifest["blocks"]) == len(blocks) and len(manifest["objects"]) == len(objects), "manifest_count_mismatch")
        for block in manifest["blocks"]:
            require(block["name"] in blocks and all(block[k] == blocks[block["name"]][k] for k in ("name", "sha256", "bytes")), "manifest_block_mismatch")
        for item in manifest["objects"]:
            require(item["key"] in objects and all(objects[item["key"]][k] == v for k, v in item.items()), "manifest_object_mismatch")
        write_private(stage / "manifest.json", canonical(manifest))
        deletion_journal = latest_deletions(client)
        write_private(stage / "snapshot-deletions.json", canonical(deletion_journal))
        index = {"version": 1, "backup_id": backup_id, "manifest_sha256": manifest_hash,
                 "objects": list(objects.values()), "created_at": status["created_at"], "credential_key_included": False}
        index["reference_validation"] = validate_live_references(lambda table: exported_rows(stage, table),
            index["objects"], stage, deletion_journal["items"])
        write_private(stage / "bundle.json", canonical(index))
        return index
    except BaseException:
        try:
            client.json("/cancel", payload={"backup_id": backup_id})
        except Exception:
            pass
        raise


def create_archive(stage, path):
    with tarfile.open(path, "w:gz", compresslevel=6) as archive:
        for file in sorted(stage.rglob("*")):
            if file.is_file():
                archive.add(file, arcname=file.relative_to(stage).as_posix(), recursive=False)


def add_key_envelope(stage, index, path):
    """Optional independently encrypted escrow; never accept an app key string."""
    if not path:
        return
    envelope = Path(path).read_bytes()
    require(0 < len(envelope) <= 1024 * 1024 and not re.fullmatch(rb"\s*[a-fA-F0-9]{64}\s*", envelope), "encrypted_credential_key_envelope_required")
    # GPG public-key-encrypted data starts with a packet header (binary) or the
    # standard message armor. Plain JSON/hex/text is never a valid envelope.
    require(envelope[0] & 0x80 or envelope.startswith(b"-----BEGIN PGP MESSAGE-----"), "encrypted_credential_key_envelope_required")
    write_private(stage / "credential-key.gpg", envelope)
    index["credential_key_envelope"] = {"path": "credential-key.gpg", "sha256": digest(envelope), "bytes": len(envelope)}
    atomic_json(stage / "bundle.json", index)


def run_gpg(args, **kwargs):
    try:
        result = subprocess.run(["gpg", "--batch", "--no-tty", *args], stderr=subprocess.PIPE, **kwargs)
    except OSError:
        raise BackupError("gpg_unavailable") from None
    require(result.returncode == 0, "gpg_operation_failed")
    return result


def encrypt_archive(plain, encrypted, public_key, fingerprint):
    fingerprint = fingerprint.replace(" ", "").upper()
    require(re.fullmatch(r"(?:[0-9A-F]{40}|[0-9A-F]{64})", fingerprint), "invalid_recipient_fingerprint")
    # Require an ASCII-armored public export. Refuse a private export before
    # asking GPG to import it, so a secret key never enters the collector keyring.
    key_data = Path(public_key).read_bytes()
    require(len(key_data) <= 1024 * 1024 and b"-----BEGIN PGP PUBLIC KEY BLOCK-----" in key_data and
            b"PRIVATE KEY" not in key_data and b"SECRET KEY" not in key_data, "public_key_export_required")
    with tempfile.TemporaryDirectory(prefix="mailhero-public-key-") as home:
        os.chmod(home, 0o700)
        run_gpg(["--homedir", home, "--import", str(public_key)], stdout=subprocess.DEVNULL)
        listing = run_gpg(["--homedir", home, "--with-colons", "--fingerprint", "--list-keys"], stdout=subprocess.PIPE).stdout.decode()
        require(any(line.startswith("fpr:") and line.split(":")[9] == fingerprint for line in listing.splitlines()), "recipient_key_mismatch")
        secrets = run_gpg(["--homedir", home, "--with-colons", "--list-secret-keys"], stdout=subprocess.PIPE).stdout
        require(not any(line.startswith(b"sec:") for line in secrets.splitlines()), "private_key_refused_on_collector")
        run_gpg(["--homedir", home, "--trust-model", "always", "--recipient", fingerprint,
                 "--output", str(encrypted), "--encrypt", str(plain)], stdout=subprocess.DEVNULL)


def upload_verified(client, encrypted, index, receipt_key):
    size, checksum = encrypted.stat().st_size, file_hash(encrypted)
    data, _ = client.json("/artifacts/begin", payload={"backup_id": index["backup_id"],
        "manifest_sha256": index["manifest_sha256"], "sha256": checksum, "size_bytes": size})
    key, upload_id = data["key"], data["upload_id"]
    require(data["part_size"] == PART_BYTES, "unsupported_upload_part_size")
    complete = False
    try:
        parts = []
        with encrypted.open("rb") as source:
            for part_number, block in enumerate(iter(lambda: source.read(PART_BYTES), b""), 1):
                with client.open("/artifacts/part", {"key": key, "upload_id": upload_id, "part_number": part_number}, data=block, method="PUT") as response:
                    part = json.loads(response.read(16 * 1024))
                require(part.get("partNumber") == part_number and isinstance(part.get("etag"), str), "invalid_upload_part")
                parts.append(part)
        uploaded, _ = client.json("/artifacts/complete", payload={"key": key, "upload_id": upload_id, "parts": parts})
        require(uploaded["key"] == key and uploaded["size_bytes"] == size and uploaded["sha256"] == checksum and
                uploaded["manifest_sha256"] == index["manifest_sha256"], "uploaded_archive_metadata_mismatch")
        complete = True
        client.download("/artifacts/object", {"key": key}, None, size, checksum)
        receipt = {"backup_id": index["backup_id"], "manifest_sha256": index["manifest_sha256"],
                   "remote_locator": key, "verified_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")}
        require(HEX.fullmatch(receipt_key.lower()), "invalid_backup_receipt_key")
        mac = hmac.new(bytes.fromhex(receipt_key), canonical(receipt), hashlib.sha256).hexdigest()
        finished, _ = client.json("/finish", payload={"backup_id": index["backup_id"], "manifest_sha256": index["manifest_sha256"],
                                                    "receipt": receipt, "receipt_mac": mac})
        require(finished.get("state") == "remote_verified", "backup_finish_not_confirmed")
        return {**receipt, "archive_sha256": checksum, "archive_bytes": size}
    finally:
        if not complete:
            try:
                client.json("/artifacts/abort", payload={"key": key, "upload_id": upload_id})
            except Exception:
                pass


def quote_identifier(value):
    require(isinstance(value, str) and TABLE.fullmatch(value), "invalid_sql_identifier")
    return '"' + value + '"'


def rotate_local(output):
    """Prune verified encrypted archives only, after another verified success."""
    records = []
    for path in output.glob("*.tar.gz.gpg.receipt.json"):
        require(not path.is_symlink(), "unsafe_local_receipt")
        value = json.loads(path.read_bytes())
        date = dt.datetime.fromisoformat(value["verified_at"].replace("Z", "+00:00"))
        records.append((date, path))
    keep, days, weeks = set(), set(), set()
    for date, path in sorted(records, reverse=True):
        day, week = date.date(), date.isocalendar()[:2]
        if day not in days and len(days) < 7:
            days.add(day)
            keep.add(path)
        if week not in weeks and len(weeks) < 4:
            weeks.add(week)
            keep.add(path)
    for _, path in records:
        if path not in keep:
            archive = path.with_name(path.name.removesuffix(".receipt.json"))
            if archive.exists():
                archive.unlink()
            path.unlink()


def verify_archive(path, stage):
    """Extract only regular files into a private, disposable directory."""
    files = set()
    total = 0
    with tarfile.open(path, "r:gz") as archive:
        for member in archive:
            name = PurePosixPath(member.name)
            require(member.isfile() and not name.is_absolute() and ".." not in name.parts and
                    str(name) == member.name and member.name not in files, "unsafe_archive_entry")
            require(member.size <= MAX_OBJECT, "archive_entry_budget_exceeded")
            files.add(member.name)
            total += member.size
            require(len(files) <= MAX_ENTRIES and total <= 16 * 1024**3, "archive_budget_exceeded")
            source = archive.extractfile(member)
            target = stage / member.name
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            with target.open("xb") as output:
                shutil.copyfileobj(source, output, CHUNK)
    index = json.loads((stage / "bundle.json").read_bytes())
    manifest = json.loads((stage / "manifest.json").read_bytes())
    require(index["version"] == 1 and manifest["version"] == 1 and index["credential_key_included"] is False and
            manifest["credential_key_included"] is False, "unsupported_backup_version")
    require(index["backup_id"] == manifest["backup_id"] and digest(canonical(manifest)) == index["manifest_sha256"], "manifest_hash_mismatch")
    expected = {"bundle.json", "manifest.json", "snapshot-deletions.json"}
    if index.get("credential_key_envelope"):
        envelope = index["credential_key_envelope"]
        require(envelope.get("path") == "credential-key.gpg" and envelope["path"] in files and
                (stage / envelope["path"]).stat().st_size == envelope["bytes"] and
                file_hash(stage / envelope["path"]) == envelope["sha256"], "credential_key_envelope_corrupt")
        expected.add(envelope["path"])
    for block in manifest["blocks"]:
        file = stage / block["name"]
        require(block["name"] in files and file.stat().st_size == block["bytes"] and file_hash(file) == block["sha256"], "backup_block_corrupt")
        expected.add(block["name"])
    objects = {item["key"]: item for item in index["objects"]}
    require(len(objects) == len(index["objects"]) == len(manifest["objects"]), "backup_object_count_mismatch")
    for item in manifest["objects"]:
        local = objects.get(item["key"])
        require(local and all(local.get(k) == v for k, v in item.items()) and
                local["path"] == "objects/" + digest(item["key"].encode()), "backup_object_metadata_mismatch")
        file = stage / local["path"]
        require(local["path"] in files and file.stat().st_size == item["size"] and file_hash(file) == local["sha256"], "backup_object_corrupt")
        expected.add(local["path"])
    require(expected == files, "untracked_archive_entry")
    return index, manifest


def restore_archive(plain_archive, destination, deletion_journal=None):
    destination = Path(destination).absolute()
    require(not destination.exists(), "restore_destination_must_be_new")
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=destination.parent, prefix=".mailhero-restore-") as temporary:
        stage = Path(temporary)
        extracted = stage / "snapshot"
        extracted.mkdir(mode=0o700)
        index, manifest = verify_archive(plain_archive, extracted)
        schema = json.loads((extracted / "database-schema.json").read_bytes())
        tables = schema["tables"]
        require(set(tables) == {item["name"] for item in schema["schema"] if item["type"] == "table"}, "schema_table_mismatch")
        database = stage / "database.sqlite"
        conn = sqlite3.connect(database)
        if hasattr(conn, "enable_load_extension"):
            conn.enable_load_extension(False)
        def authorize(action, first, second, _database, _trigger):
            if action in (sqlite3.SQLITE_ATTACH, sqlite3.SQLITE_DETACH):
                return sqlite3.SQLITE_DENY
            if action == sqlite3.SQLITE_FUNCTION and str(second).lower() in ("load_extension", "readfile", "writefile"):
                return sqlite3.SQLITE_DENY
            return sqlite3.SQLITE_OK
        conn.set_authorizer(authorize)
        try:
            conn.execute("PRAGMA foreign_keys=OFF")
            for item in schema["schema"]:
                require(item["type"] in ("table", "index", "trigger", "view") and isinstance(item["sql"], str), "unsupported_schema_entry")
                # sqlite_schema exports CREATE statements only. Prohibit external
                # attachment/extension side effects even in an altered archive.
                require(re.match(r"^CREATE\s+", item["sql"], re.I), "invalid_schema_sql")
                if item["type"] == "table":
                    conn.execute(item["sql"])
            for table in tables:
                quote_identifier(table)
                offset = 0
                while True:
                    page = json.loads((extracted / f"database/{table}/{offset}.json").read_bytes())
                    require(page["table"] == table and page["offset"] == offset, "database_page_mismatch")
                    for row in page["rows"]:
                        columns = list(row)
                        values = [row[column] for column in columns]
                        require(all(value is None or isinstance(value, (str, int, float)) for value in values), "unsupported_database_value")
                        conn.execute(f"INSERT INTO {quote_identifier(table)} ({','.join(quote_identifier(c) for c in columns)}) VALUES ({','.join('?' for _ in columns)})", values)
                    if page["next_offset"] is None:
                        break
                    require(page["next_offset"] == offset + 100, "database_page_cursor_invalid")
                    offset += 100
            for item in schema["schema"]:
                if item["type"] != "table":
                    conn.execute(item["sql"])
            conn.commit()
            require(conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok" and not conn.execute("PRAGMA foreign_key_check").fetchall(), "restored_database_invalid")
            # Never restore a database that can send merely by booting a Worker.
            conn.execute("UPDATE app_settings SET send_paused=1 WHERE id=1")
            if "webhook_endpoints" in tables:
                conn.execute("UPDATE webhook_endpoints SET paused=1")
            if "deliveries" in tables:
                conn.execute("UPDATE deliveries SET state='failed',last_error='restore_reconciliation_required',claim_token=NULL,lease_until=NULL WHERE state='sending'")
            captured = json.loads((extracted / "snapshot-deletions.json").read_bytes())
            require(captured.get("version") == 1 and isinstance(captured.get("items"), list), "invalid_snapshot_deletion_journal")
            # A source tombstone can precede its external journal write or R2
            # purge. Apply the database's own tombstones as well as the journal.
            deletions = captured["items"] + [{"id": row[0], "scope": "content" if row[1] else "raw", "deleted_at": row[1] or row[2]}
                for row in conn.execute("SELECT id,content_deleted_at,raw_expired_at FROM messages WHERE content_deleted_at IS NOT NULL OR raw_expired_at IS NOT NULL")]
            if deletion_journal:
                journal = json.loads(Path(deletion_journal).read_bytes())
                require(journal.get("version") == 1 and isinstance(journal.get("items"), list), "invalid_latest_deletion_journal")
                require(isinstance(journal.get("fetched_at"), str) and
                        dt.datetime.fromisoformat(journal["fetched_at"].replace("Z", "+00:00")) >=
                        dt.datetime.fromisoformat(manifest["cut_at"].replace("Z", "+00:00")), "latest_deletion_journal_predates_snapshot")
                deletions = deletions + journal["items"]
            excluded = set()
            for item in deletions:
                require(item.get("scope") in ("raw", "content"), "invalid_deletion_scope")
                uuid.UUID(item["id"])
                excluded.add(f"raw/{item['id']}.eml")
                if "ingest_receipts" in tables:
                    excluded.update(f"raw/{row[0]}.eml" for row in conn.execute("SELECT external_id FROM ingest_receipts WHERE message_id=?", (item["id"],)))
                if item["scope"] == "content":
                    excluded.update(obj["key"] for obj in index["objects"] if obj["key"].startswith(f"parsed/{item['id']}/"))
                row = conn.execute("SELECT raw_key,parsed_key FROM messages WHERE id=?", (item["id"],)).fetchone()
                if not row:
                    continue
                if row[0]:
                    excluded.add(row[0])
                if item["scope"] == "content":
                    if row[1]:
                        parsed = next((obj for obj in index["objects"] if obj["key"] == row[1]), None)
                        if parsed:
                            body = json.loads((extracted / parsed["path"]).read_bytes())
                            excluded.update(a["r2_key"] for a in body.get("attachments", []) if a.get("r2_key"))
                        excluded.add(row[1])
                    if "deliveries" in tables:
                        excluded.update(row[0] for row in conn.execute("SELECT payload_key FROM deliveries WHERE message_id=?", (item["id"],)) if row[0])
                        excluded.update(f"payload/{row[0]}.json" for row in conn.execute("SELECT event_id FROM deliveries WHERE message_id=?", (item["id"],)))
                        conn.execute("UPDATE deliveries SET payload_key=NULL,payload_size_bytes=0,state=CASE WHEN state='delivered' THEN state ELSE 'cancelled' END WHERE message_id=?", (item["id"],))
                    conn.execute("UPDATE messages SET content_deleted_at=?,raw_key=NULL,parsed_key=NULL,subject=NULL,from_text=NULL,search_text=NULL,has_attachment=0,parse_error=NULL,parsed_size_bytes=0,content_bytes=0,claim_token=NULL,lease_until=NULL WHERE id=?", (item["deleted_at"], item["id"]))
                    if "message_search" in tables:
                        conn.execute("DELETE FROM message_search WHERE message_id=?", (item["id"],))
                    if "delivery_attempts" in tables:
                        conn.execute("UPDATE delivery_attempts SET response_preview=NULL WHERE event_id IN(SELECT event_id FROM deliveries WHERE message_id=?)", (item["id"],))
                else:
                    conn.execute("UPDATE messages SET raw_expired_at=?,content_bytes=max(0,content_bytes-CASE WHEN raw_key IS NULL THEN 0 ELSE size_bytes END),raw_key=NULL WHERE id=?", (item["deleted_at"], item["id"]))
            # This is a fresh isolated object set, not a continuation of an
            # interrupted source purge. Recompute logical accounting from the
            # surviving records; DO capacity state remains diagnostic-only.
            conn.execute("UPDATE messages SET pending_delete_bytes=0,content_purge_pending=0,raw_capacity_pending_key=NULL,raw_capacity_remaining_bytes=NULL")
            conn.execute("UPDATE messages SET raw_purged_at=COALESCE(raw_purged_at,raw_expired_at) WHERE raw_expired_at IS NOT NULL AND raw_key IS NULL")
            conn.execute("UPDATE app_settings SET logical_bytes=COALESCE((SELECT sum(content_bytes) FROM messages),0)+COALESCE((SELECT sum(payload_size_bytes) FROM deliveries),0) WHERE id=1")
            conn.commit()
            def restored_rows(table):
                cursor = conn.execute(f"SELECT * FROM {quote_identifier(table)}")
                columns = [item[0] for item in cursor.description]
                for row in cursor:
                    yield dict(zip(columns, row))
            reference_validation = validate_live_references(restored_rows,
                [item for item in index["objects"] if item["key"] not in excluded], extracted)
            write_private(stage / "database.sql", ("\n".join(conn.iterdump()) + "\n").encode())
        finally:
            conn.close()
        r2 = stage / "r2"
        r2.mkdir(mode=0o700)
        objects = []
        for item in index["objects"]:
            if item["key"] in excluded:
                continue
            leaf = Path(item["path"]).name
            shutil.copyfile(extracted / item["path"], r2 / leaf)
            objects.append({**item, "path": "r2/" + leaf})
        write_private(stage / "r2-objects.json", canonical({"version": 1, "objects": objects}))
        shutil.copyfile(extracted / "control.json", stage / "coordinator-control.json")
        if index.get("credential_key_envelope"):
            shutil.copyfile(extracted / "credential-key.gpg", stage / "credential-key.gpg")
        state = {"version": 1, "backup_id": index["backup_id"], "manifest_sha256": index["manifest_sha256"],
                 "state": "isolated_requires_reconciliation" if deletion_journal else "quarantined_missing_latest_deletions",
                 "force_send_paused": True, "maintenance_mode": True, "do_alarm_restored": False,
                 "credential_key_included": False, "deletion_entries_applied": len(deletions),
                 "credential_key_envelope_available": bool(index.get("credential_key_envelope")),
                 "objects_restored": len(objects), "activation_allowed": False}
        state["reference_validation"] = reference_validation
        write_private(stage / "restore-state.json", canonical(state))
        shutil.rmtree(extracted)
        os.rename(stage, destination)
    return state


def collect(args):
    output = private_directory(args.output)
    receipt_key = os.environ.get("BACKUP_RECEIPT_KEY", "")
    require(HEX.fullmatch(receipt_key.lower()), "invalid_backup_receipt_key")
    require(shutil.which("gpg"), "gpg_unavailable")
    client = Client(args.origin, os.environ.get("BACKUP_TOKEN", ""), os.environ.get("CF_ACCESS_CLIENT_ID", ""), os.environ.get("CF_ACCESS_CLIENT_SECRET", ""))
    backup_id = None
    try:
        with tempfile.TemporaryDirectory(dir=output, prefix=".snapshot-") as temporary:
            stage = Path(temporary) / "snapshot"
            stage.mkdir(mode=0o700)
            (stage / "objects").mkdir(mode=0o700)
            index = collect_snapshot(client, stage, args.lease_seconds)
            backup_id = index["backup_id"]
            add_key_envelope(stage, index, args.credential_key_envelope)
            plain = Path(temporary) / "snapshot.tar.gz"
            create_archive(stage, plain)
            name = index["created_at"][:10] + "-" + backup_id + ".tar.gz.gpg"
            encrypted = output / name
            encrypt_archive(plain, encrypted, args.public_key_file, args.recipient)
            receipt = upload_verified(client, encrypted, index, receipt_key)
            atomic_json(output / (name + ".receipt.json"), receipt)
            atomic_json(output / "latest-success.json", receipt)
            atomic_json(output / "latest-deletions.json", latest_deletions(client))
            client.json("/artifacts/prune", payload={"backup_id": backup_id, "manifest_sha256": index["manifest_sha256"]})
            rotate_local(output)
            print(json.dumps({"backup_id": backup_id, "state": "remote_verified", "archive_bytes": receipt["archive_bytes"]}))
    except BaseException:
        if backup_id:
            try:
                client.json("/cancel", payload={"backup_id": backup_id})
            except Exception:
                pass
        raise


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    c = commands.add_parser("collect", help="Collect, public-key encrypt, upload, read-back verify and finish a snapshot")
    c.add_argument("--origin", required=True)
    c.add_argument("--output", required=True, type=Path)
    c.add_argument("--public-key-file", required=True, type=Path)
    c.add_argument("--recipient", required=True, help="Pinned full GPG encryption recipient fingerprint")
    c.add_argument("--credential-key-envelope", type=Path, help="Optional already public-key-encrypted CREDENTIAL_KEY escrow; never plaintext")
    c.add_argument("--lease-seconds", type=int, choices=range(30, 1801), default=1800, metavar="30..1800")
    d = commands.add_parser("deletions", help="Fetch the latest independent deletion ledger for an isolated restore")
    d.add_argument("--origin", required=True)
    d.add_argument("--output", required=True, type=Path)
    r = commands.add_parser("restore", help="On the recovery device, decrypt and restore into a NEW isolated local directory")
    r.add_argument("--archive", required=True, type=Path)
    r.add_argument("--archive-sha256", help="Expected encrypted archive SHA-256 from the verified independent receipt")
    r.add_argument("--destination", required=True, type=Path)
    r.add_argument("--latest-deletions", type=Path)
    r.add_argument("--gpg-home", type=Path, help="Recovery device keyring; never copy its private key to the collector")
    args = parser.parse_args()
    try:
        if args.command == "collect":
            collect(args)
        elif args.command == "deletions":
            client = Client(args.origin, os.environ.get("BACKUP_TOKEN", ""), os.environ.get("CF_ACCESS_CLIENT_ID", ""), os.environ.get("CF_ACCESS_CLIENT_SECRET", ""))
            private_directory(args.output.parent)
            atomic_json(args.output, latest_deletions(client))
            print('{"state":"deletion_journal_saved"}')
        else:
            require(not args.destination.exists(), "restore_destination_must_be_new")
            if args.archive_sha256:
                require(HEX.fullmatch(args.archive_sha256) and file_hash(args.archive) == args.archive_sha256, "encrypted_archive_hash_mismatch")
            with tempfile.TemporaryDirectory(prefix="mailhero-recovery-") as temporary:
                plain = Path(temporary) / "snapshot.tar.gz"
                home = ["--homedir", str(args.gpg_home)] if args.gpg_home else []
                run_gpg([*home, "--output", str(plain), "--decrypt", str(args.archive)], stdout=subprocess.DEVNULL)
                print(json.dumps(restore_archive(plain, args.destination, args.latest_deletions)))
    except (BackupError, ValueError, KeyError, TypeError, OSError, sqlite3.Error, tarfile.TarError) as exc:
        code = str(exc) if isinstance(exc, BackupError) else "backup_local_validation_failed"
        print(json.dumps({"error": code}), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

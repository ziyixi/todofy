#!/usr/bin/env python3
"""Download private native-v2 snapshots and restore into a new isolated folder.

Native backups are plaintext in a private R2 bucket. Restore is offline and
reuses the unchanged v1 database/object validation and reconciliation rules.
"""
from __future__ import annotations

import argparse
import datetime as dt
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import stat
import sys
import tempfile
import uuid

if "mailhero_backup" in sys.modules:
    legacy = sys.modules["mailhero_backup"]
else:
    spec = importlib.util.spec_from_file_location("mailhero_backup", Path(__file__).with_name("mailhero_backup.py"))
    legacy = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = legacy
    spec.loader.exec_module(legacy)

require = legacy.require
FORMAT = "mailhero.native-backup.v2"
DOWNLOAD_FORMAT = "mailhero.native-download.v2"
MAX_FILES, MAX_TOTAL, MANIFEST_BYTES = 50_000, 8 * 1024 ** 3, 4 * 1024 ** 2
HASH = re.compile(r"^[0-9a-f]{64}$")
MANIFEST_KEY = re.compile(r"^snapshots-v2/(\d{4}-\d{2}-\d{2})/([0-9a-f-]{36})/manifest\.json$")
DATABASE_PATH = re.compile(r"^database/[a-zA-Z_][a-zA-Z0-9_]*/(?:0|[1-9][0-9]*)\.json$")
OBJECT_PATH = re.compile(r"^objects/[0-9a-f]{64}\.bin$")
FIXED_PATHS = {"control": "control.json", "schema": "database-schema.json",
               "source_manifest": "source-manifest.json", "deletions": "snapshot-deletions.json"}


def valid_hash(value):
    return isinstance(value, str) and HASH.fullmatch(value) is not None


def valid_int(value, low, high):
    return type(value) is int and low <= value <= high


def date(value):
    try:
        result = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        require(result.tzinfo is not None, "native_invalid_timestamp")
        return result
    except (ValueError, AttributeError, OverflowError):
        raise legacy.BackupError("native_invalid_timestamp") from None


def strict_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, "native_duplicate_json_key")
            result[key] = value
        return result
    def invalid_constant(_value):
        raise legacy.BackupError("native_invalid_json")
    try:
        return json.loads(raw, object_pairs_hook=pairs, parse_constant=invalid_constant)
    except (ValueError, UnicodeError, RecursionError):
        raise legacy.BackupError("native_invalid_json") from None


def safe_path(path):
    require(isinstance(path, str) and (path in {*FIXED_PATHS.values(), "manifest.json"} or DATABASE_PATH.fullmatch(path) or OBJECT_PATH.fullmatch(path)), "native_invalid_logical_path")
    return path


def check_marker(marker):
    require(isinstance(marker, dict) and marker.get("version") == 2 and marker.get("proof") == "native_readback_verified", "native_unverified_marker")
    match = MANIFEST_KEY.fullmatch(marker.get("key", ""))
    require(match is not None, "native_invalid_manifest_key")
    try:
        require(str(uuid.UUID(marker.get("backup_id", ""))) == match[2], "native_invalid_backup_identity")
        dt.date.fromisoformat(match[1])
    except ValueError:
        raise legacy.BackupError("native_invalid_backup_identity") from None
    require(valid_hash(marker.get("sha256")) and marker.get("manifest_sha256") == marker["sha256"], "native_invalid_marker_hash")
    require(valid_int(marker.get("size_bytes"), 1, MAX_TOTAL) and valid_int(marker.get("object_count"), 1, MAX_FILES), "native_marker_budget_exceeded")
    require(date(marker.get("verified_at")) >= date(marker.get("created_at")), "native_invalid_marker_time")
    return marker["key"].removesuffix("manifest.json")


def pages(client, action, query, field):
    cursor, seen, count = None, set(), 0
    while True:
        page, _ = client.json(action, {**query, "cursor": cursor})
        require(page.get("version") == 2 and isinstance(page.get(field), list), "native_invalid_inventory")
        for item in page[field]:
            count += 1
            require(count <= MAX_FILES, "native_inventory_budget_exceeded")
            yield item
        cursor = page.get("cursor")
        if not cursor:
            require(page.get("complete") is True, "native_inventory_incomplete")
            return
        require(isinstance(cursor, str) and cursor not in seen, "native_inventory_cursor_loop")
        seen.add(cursor)


def list_backups(client):
    items, seen = [], set()
    for marker in pages(client, "/artifacts/list-v2", {}, "items"):
        check_marker(marker)
        require(marker["backup_id"] not in seen and len(items) < 100, "native_duplicate_or_excessive_markers")
        seen.add(marker["backup_id"])
        items.append(marker)
    return items


def new_destination(destination):
    destination = Path(destination).absolute()
    require(not destination.exists() and not destination.is_symlink(), "native_destination_must_be_new")
    legacy.private_directory(destination.parent)
    return destination


def download(client, backup_id, destination):
    destination = new_destination(destination)
    candidates = [item for item in list_backups(client) if item["backup_id"] == backup_id]
    require(len(candidates) == 1, "native_verified_backup_not_found")
    marker, entries, total, seen = candidates[0], [], 0, set()
    prefix = check_marker(marker)
    with tempfile.TemporaryDirectory(dir=destination.parent, prefix=".native-download-") as temporary:
        stage = Path(temporary)
        for item in pages(client, "/artifacts/list-v2-objects", {"backup_id": backup_id}, "objects"):
            key, size, meta = item.get("key"), item.get("size"), item.get("customMetadata", {})
            require(isinstance(key, str) and key.startswith(prefix), "native_key_outside_snapshot")
            relative = safe_path(key[len(prefix):])
            limit = MANIFEST_BYTES if relative == "manifest.json" else legacy.MAX_OBJECT
            require(key not in seen and valid_int(size, 0, limit) and isinstance(meta, dict) and meta.get("backup_id") == backup_id and valid_hash(meta.get("sha256")), "native_invalid_inventory")
            seen.add(key); total += size
            require(len(seen) <= marker["object_count"] and total <= marker["size_bytes"], "native_inventory_budget_exceeded")
            target = stage / "snapshot" / relative
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            with target.open("xb") as stream:
                target.chmod(0o600)
                client.download("/artifacts/object", {"key": key}, stream, size, meta["sha256"])
            entries.append({"key": key, "path": "snapshot/" + relative, "bytes": size, "sha256": meta["sha256"]})
        require(len(entries) == marker["object_count"] and total == marker["size_bytes"], "native_inventory_incomplete")
        require(any(item["key"] == marker["key"] and item["sha256"] == marker["sha256"] for item in entries), "native_manifest_mismatch")
        journal = legacy.canonical(legacy.latest_deletions(client))
        require(len(journal) <= legacy.MAX_JSON, "native_deletion_journal_budget_exceeded")
        legacy.write_private(stage / "latest-deletions.json", journal)
        receipt = {"version": 2, "format": DOWNLOAD_FORMAT, "marker": marker,
            "objects": sorted(entries, key=lambda item: item["key"]),
            "latest_deletions": {"bytes": len(journal), "sha256": legacy.digest(journal)}}
        legacy.write_private(stage / "receipt.json", legacy.canonical(receipt))
        checksum = legacy.file_hash(stage / "receipt.json")
        require(not destination.exists() and not destination.is_symlink(), "native_destination_must_be_new")
        os.rename(stage, destination)
    return {"state": "private_download_verified", "backup_id": backup_id, "receipt_sha256": checksum,
            "objects": len(entries), "bytes": total}


def checked_file(path, size, checksum, limit):
    require(valid_int(size, 0, limit) and valid_hash(checksum), "native_invalid_file_record")
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_size == size, "native_unsafe_or_incomplete_file")
    require(legacy.file_hash(path) == checksum, "native_file_hash_mismatch")


def validate_bundle(bundle, checksum):
    require(valid_hash(checksum), "native_independent_receipt_hash_required")
    legacy.private_directory(bundle)
    actual = set()
    for path in bundle.rglob("*"):
        require(not path.is_symlink(), "native_unsafe_local_file")
        if path.is_file(): actual.add(path.relative_to(bundle).as_posix())
        else: require(path.is_dir(), "native_unsafe_local_file")
    require((bundle / "receipt.json").stat().st_size <= MANIFEST_BYTES * 4, "native_receipt_budget_exceeded")
    require(legacy.file_hash(bundle / "receipt.json") == checksum, "native_receipt_hash_mismatch")
    receipt = strict_json((bundle / "receipt.json").read_bytes())
    require(receipt.get("version") == 2 and receipt.get("format") == DOWNLOAD_FORMAT, "native_unsupported_download_format")
    marker, entries = receipt.get("marker"), receipt.get("objects")
    prefix = check_marker(marker)
    require(isinstance(entries, list) and len(entries) == marker["object_count"], "native_inventory_incomplete")
    expected, total, by_path = {"receipt.json", "latest-deletions.json"}, 0, {}
    for item in entries:
        key = item.get("key")
        require(isinstance(key, str) and key.startswith(prefix), "native_key_outside_snapshot")
        relative = safe_path(key[len(prefix):]); path = "snapshot/" + relative
        require(item.get("path") == path and path not in expected, "native_invalid_inventory")
        expected.add(path)
        checked_file(bundle / path, item.get("bytes"), item.get("sha256"), MANIFEST_BYTES if relative == "manifest.json" else legacy.MAX_OBJECT)
        total += item["bytes"]; by_path[relative] = item
    require(total == marker["size_bytes"] and by_path.get("manifest.json", {}).get("sha256") == marker["sha256"], "native_manifest_mismatch")
    journal = receipt.get("latest_deletions", {})
    checked_file(bundle / "latest-deletions.json", journal.get("bytes"), journal.get("sha256"), legacy.MAX_JSON)
    require(actual == expected, "native_untracked_file")
    return marker, by_path


def build_bridge(manifest, marker, inventory, snapshot, bridge):
    require(manifest.get("version") == 2 and manifest.get("format") == FORMAT and manifest.get("encrypted") is False and manifest.get("credential_key_included") is False, "native_unsupported_manifest")
    require(manifest.get("backup_id") == marker["backup_id"] and manifest.get("created_at") == marker["created_at"] and date(manifest.get("cut_at")) >= date(manifest["created_at"]), "native_manifest_identity_mismatch")
    require(valid_int(manifest.get("cut_seq"), 0, 2**53 - 1) and valid_hash(manifest.get("source_manifest_sha256")), "native_invalid_source_identity")
    require(manifest.get("build_sha") is None or isinstance(manifest.get("build_sha"), str) and re.fullmatch(r"[a-f0-9]{40}", manifest["build_sha"]), "native_invalid_build_identity")
    files, by_path = manifest.get("files"), {}
    require(isinstance(files, list) and 4 <= len(files) < MAX_FILES, "native_manifest_file_budget")
    for file in files:
        path = safe_path(file.get("path")); kind = file.get("kind")
        require(path not in by_path and path != "manifest.json", "native_duplicate_file")
        require((kind in FIXED_PATHS and path == FIXED_PATHS[kind]) or kind == "database" and DATABASE_PATH.fullmatch(path) or
            kind == "object" and isinstance(file.get("object_key"), str) and path == "objects/" + legacy.digest(file["object_key"].encode()) + ".bin", "native_invalid_file_kind_or_path")
        expected = inventory.get(path)
        require(expected and expected["bytes"] == file.get("bytes") and expected["sha256"] == file.get("sha256"), "native_file_record_mismatch")
        by_path[path] = file
    require(set(by_path) | {"manifest.json"} == set(inventory) and set(FIXED_PATHS.values()).issubset(by_path), "native_missing_or_extra_file")
    source_raw = (snapshot / "source-manifest.json").read_bytes(); source = strict_json(source_raw)
    require(legacy.canonical(source) == source_raw and legacy.digest(source_raw) == manifest["source_manifest_sha256"], "native_source_manifest_corrupt")
    require(source.get("version") == 1 and source.get("credential_key_included") is False and all(source.get(key) == manifest[key] for key in ("backup_id", "created_at", "cut_at", "cut_seq")), "native_source_manifest_identity_mismatch")
    require(isinstance(source.get("blocks"), list) and isinstance(source.get("objects"), list), "native_source_manifest_corrupt")
    objects, expected = [], {"source-manifest.json", "snapshot-deletions.json"}
    for block in source["blocks"]:
        file = by_path.get(block.get("name"))
        require(file and file["kind"] in ("control", "schema", "database") and file["path"] not in expected and file["bytes"] == block.get("bytes") and file["sha256"] == block.get("sha256"), "native_source_block_mismatch")
        expected.add(file["path"])
    for obj in source["objects"]:
        require(isinstance(obj.get("key"), str), "native_source_object_mismatch")
        path = "objects/" + legacy.digest(obj["key"].encode()); file = by_path.get(path + ".bin")
        require(file and file["kind"] == "object" and file["object_key"] == obj["key"] and file["bytes"] == obj.get("size") and file["path"] not in expected, "native_source_object_mismatch")
        expected.add(file["path"]); objects.append({**obj, "path": path, "sha256": file["sha256"]})
    require(set(by_path) == expected, "native_untracked_snapshot_file")
    bridge.mkdir(mode=0o700)
    for file in files:
        target = bridge / ("manifest.json" if file["kind"] == "source_manifest" else file["path"].removesuffix(".bin") if file["kind"] == "object" else file["path"])
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        shutil.copyfile(snapshot / file["path"], target); target.chmod(0o600)
    legacy.write_private(bridge / "bundle.json", legacy.canonical({"version": 1, "backup_id": manifest["backup_id"], "created_at": manifest["created_at"],
        "manifest_sha256": manifest["source_manifest_sha256"], "objects": objects, "credential_key_included": False}))


def restore(bundle, receipt_sha256, destination, latest_deletions=None):
    destination = new_destination(destination); bundle = Path(bundle).absolute()
    marker, inventory = validate_bundle(bundle, receipt_sha256)
    raw = (bundle / "snapshot/manifest.json").read_bytes(); manifest = strict_json(raw)
    require(legacy.canonical(manifest) == raw, "native_noncanonical_manifest")
    with tempfile.TemporaryDirectory(dir=destination.parent, prefix=".native-restore-") as temporary:
        stage = Path(temporary); bridge = stage / "bridge"
        build_bridge(manifest, marker, inventory, bundle / "snapshot", bridge)
        archive = stage / "bridge.tar.gz"; legacy.create_archive(bridge, archive)
        restored = stage / "restored"; result = legacy.restore_archive(archive, restored, latest_deletions)
        legacy.write_private(restored / "native-backup-proof.json", legacy.canonical({"version": 2, "encrypted": False, "backup_id": marker["backup_id"],
            "build_sha": manifest["build_sha"], "receipt_sha256": receipt_sha256, "manifest_sha256": marker["manifest_sha256"], "activation_allowed": False}))
        require(not destination.exists() and not destination.is_symlink(), "native_destination_must_be_new")
        os.rename(restored, destination)
    return {**result, "native_format_version": 2, "encrypted": False}


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__); commands = parser.add_subparsers(dest="command", required=True)
    for name in ("list", "download"):
        command = commands.add_parser(name); command.add_argument("--origin", required=True)
        if name == "download":
            command.add_argument("--backup-id", required=True); command.add_argument("--destination", required=True, type=Path)
    recover = commands.add_parser("restore")
    for name in ("bundle", "destination"):
        recover.add_argument("--" + name, required=True, type=Path)
    recover.add_argument("--receipt-sha256", required=True, help="Independently retained download receipt SHA-256")
    recover.add_argument("--latest-deletions", type=Path)
    args = parser.parse_args()
    try:
        if args.command == "restore": value = restore(args.bundle, args.receipt_sha256, args.destination, args.latest_deletions)
        else:
            client = legacy.Client(args.origin, os.environ.get("BACKUP_TOKEN", ""), os.environ.get("CF_ACCESS_CLIENT_ID", ""), os.environ.get("CF_ACCESS_CLIENT_SECRET", ""))
            value = {"backups": list_backups(client)} if args.command == "list" else download(client, args.backup_id, args.destination)
        print(json.dumps(value, sort_keys=True)); return 0
    except legacy.BackupError as error: print(json.dumps({"error": str(error)}), file=sys.stderr)
    except Exception: print('{"error":"native_backup_local_validation_failed"}', file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""A daily UTC scheduler for the existing Mail Hero backup collector.

No Docker socket, host service manager, privileged user or recovery private key
is needed. Configuration is parsed as data, never sourced by a shell.
"""
from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import fcntl
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys
import time
from types import SimpleNamespace

UTC = dt.timezone.utc
RETRY_SECONDS = 3600
HEARTBEAT_SECONDS = 10
MAX_SUCCESS_AGE = 36 * 3600
CONFIG_KEYS = {"MAIL_HERO_ORIGIN", "BACKUP_RECIPIENT", "BACKUP_TOKEN",
               "BACKUP_RECEIPT_KEY", "CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET"}
SECRET_KEYS = CONFIG_KEYS - {"MAIL_HERO_ORIGIN", "BACKUP_RECIPIENT"}
STOPPING = False


class RuntimeErrorCode(Exception):
    pass


class StopRequested(BaseException):
    pass


def emit(state, **fields):
    print(json.dumps({"state": state, **fields}, sort_keys=True), flush=True)


def timestamp(value=None):
    return (value or dt.datetime.now(UTC)).isoformat(timespec="seconds").replace("+00:00", "Z")


def parse_timestamp(value):
    try:
        result = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        return result.astimezone(UTC) if result.tzinfo else None
    except (AttributeError, ValueError, TypeError):
        return None


def read_json(path):
    try:
        if path.stat().st_size > 16384:
            return {}
        value = json.loads(path.read_text())
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError, UnicodeError):
        return {}


def load_collector():
    # -I deliberately omits cwd/script-dir from sys.path. Load this one trusted
    # adjacent file explicitly rather than enabling arbitrary directory imports.
    spec = importlib.util.spec_from_file_location("mailhero_collector", Path(__file__).with_name("mailhero_backup.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def read_config(directory):
    path = directory / "credentials.env"
    mode = path.lstat().st_mode
    if not stat.S_ISREG(mode) or mode & 0o077 or path.stat().st_size > 16384:
        raise RuntimeErrorCode("credentials_file_must_be_private")
    values = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        key, separator, value = line.partition("=")
        if not separator or key not in CONFIG_KEYS or key in values or not value or any(c in value for c in "\x00\r\n"):
            raise RuntimeErrorCode("invalid_credentials_file")
        # These files contain literal values. Reject shell-style quoting rather
        # than silently interpreting it differently from the old service.
        if value[0] in "\"'" or value[-1] in "\"'":
            raise RuntimeErrorCode("credentials_values_must_be_unquoted")
        values[key] = value
    if set(values) != CONFIG_KEYS or not re.fullmatch(r"[0-9A-Fa-f]{40}|[0-9A-Fa-f]{64}", values["BACKUP_RECIPIENT"]):
        raise RuntimeErrorCode("incomplete_credentials_file")
    for name in ("recovery-public.asc", "credential-key.gpg"):
        if not stat.S_ISREG((directory / name).lstat().st_mode):
            raise RuntimeErrorCode("invalid_backup_key_file")
    return values


@contextlib.contextmanager
def locked(path):
    descriptor = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeErrorCode("backup_already_running") from None
        yield
    finally:
        os.close(descriptor)


def stop_collection(_number, _frame):
    # A second stop must not interrupt cancellation or temporary-file cleanup.
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    raise StopRequested()


def once(state, config_dir):
    collector = load_collector()
    state = collector.private_directory(state)
    with locked(state / "collection.lock"):
        started = dt.datetime.now(UTC)
        outcome, result = "failed", 1
        previous = {key: os.environ.get(key) for key in SECRET_KEYS}
        try:
            config = read_config(config_dir)
            os.environ.update({key: config[key] for key in SECRET_KEYS})
            args = SimpleNamespace(origin=config["MAIL_HERO_ORIGIN"], output=state,
                public_key_file=config_dir / "recovery-public.asc", recipient=config["BACKUP_RECIPIENT"],
                credential_key_envelope=config_dir / "credential-key.gpg", lease_seconds=1800)
            # Collector output is intentionally suppressed; this wrapper prints
            # only a fixed state and typed fields from its durable receipt.
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                collector.collect(args)
            receipt = read_json(state / "latest-success.json")
            verified = parse_timestamp(receipt.get("verified_at"))
            if not verified or verified < started - dt.timedelta(seconds=1):
                raise RuntimeErrorCode("fresh_success_receipt_missing")
            outcome, result = "remote_verified", 0
            emit(outcome, verified_at=timestamp(verified))
        except StopRequested:
            outcome, result = "stopped", 130
            emit(outcome)
        except collector.BackupError as exc:
            # The collector defines content-free codes; arbitrary exceptions
            # still use the fully redacted branch below.
            code = str(exc)
            emit("backup_failed", error=code if re.fullmatch(r"[a-z][a-z0-9_]{0,79}", code) else "collector_failed")
        except Exception:
            # Even a third-party exception must not reveal URL, headers, mail,
            # credentials or a response body through a traceback.
            emit("backup_failed")
        finally:
            for key, value in previous.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value
            finished = dt.datetime.now(UTC)
            collector.atomic_json(state / "collection-state.json", {"started_at": timestamp(started),
                "finished_at": timestamp(finished), "outcome": outcome,
                "retry_at": timestamp(finished + dt.timedelta(seconds=RETRY_SECONDS))})
        return result


def parse_schedule(value):
    if not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", value):
        raise RuntimeErrorCode("invalid_backup_at_utc")
    return tuple(map(int, value.split(":")))


def next_attempt(now, schedule, receipt, attempt):
    slot = now.replace(hour=schedule[0], minute=schedule[1], second=0, microsecond=0)
    if slot > now:
        slot -= dt.timedelta(days=1)
    verified = parse_timestamp(receipt.get("verified_at"))
    if verified and slot <= verified <= now + dt.timedelta(minutes=5):
        return slot + dt.timedelta(days=1)
    retry = parse_timestamp(attempt.get("retry_at"))
    finished = parse_timestamp(attempt.get("finished_at"))
    if attempt.get("outcome") in ("failed", "stopped") and finished and retry and finished <= now + dt.timedelta(minutes=5) and (not verified or finished > verified):
        # Only honor bounded backoff, including when a host clock has changed.
        # Anchor the bound to the recorded failure, not a moving now + 1h.
        return max(now, min(retry, finished + dt.timedelta(seconds=RETRY_SECONDS)))
    return now  # First run or a missed daily slot: catch up exactly once.


def stop_scheduler(_number, _frame):
    global STOPPING
    STOPPING = True


def run(state, config_dir, schedule):
    collector = load_collector()
    state = collector.private_directory(state)
    with locked(state / "scheduler.lock"):
        started = dt.datetime.now(UTC)
        active = None
        stopping_sent = False
        local_retry = None
        emit("scheduler_started", backup_at_utc=f"{schedule[0]:02}:{schedule[1]:02}")
        try:
            while not STOPPING or active is not None:
                now = dt.datetime.now(UTC)
                due = next_attempt(now, schedule, read_json(state / "latest-success.json"), read_json(state / "collection-state.json"))
                if local_retry:
                    due = max(due, local_retry)
                if active is not None:
                    if STOPPING and not stopping_sent:
                        active.terminate()
                        stopping_sent = True
                    exit_code = active.poll()
                    if exit_code is not None:
                        active = None
                        # Lock conflict or an early runtime failure may not have
                        # produced collection-state; avoid an immediate loop.
                        local_retry = now + dt.timedelta(seconds=RETRY_SECONDS) if exit_code else None
                elif not STOPPING and due <= now:
                    active = subprocess.Popen([sys.executable, "-I", str(Path(__file__).resolve()), "once",
                        "--state", str(state), "--config-dir", str(config_dir)], stdin=subprocess.DEVNULL)
                collector.atomic_json(state / "scheduler.json", {"heartbeat_at": timestamp(now),
                    "started_at": timestamp(started), "running": active is not None,
                    "next_attempt_at": timestamp(due), "stopping": STOPPING})
                if not STOPPING or active is not None:
                    time.sleep(HEARTBEAT_SECONDS)
        finally:
            if active is not None:
                active.terminate()
                active.wait()  # Allow the collector to cancel its lease and clean plaintext.
            collector.atomic_json(state / "scheduler.json", {"heartbeat_at": timestamp(),
                "started_at": timestamp(started), "stopping": True, "running": False})
        emit("scheduler_stopped")
        return 0


def healthy(state, now=None):
    now = now or dt.datetime.now(UTC)
    scheduler = read_json(state / "scheduler.json")
    heartbeat = parse_timestamp(scheduler.get("heartbeat_at"))
    if scheduler.get("stopping") or not heartbeat or not -60 <= (now - heartbeat).total_seconds() <= 120:
        return False
    verified = parse_timestamp(read_json(state / "latest-success.json").get("verified_at"))
    if verified:
        return -300 <= (now - verified).total_seconds() <= MAX_SUCCESS_AGE
    started = parse_timestamp(scheduler.get("started_at"))
    return bool(started and 0 <= (now - started).total_seconds() <= 1800)


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("run", "once", "health"), nargs="?", default="run")
    parser.add_argument("--state", type=Path, default=Path("/var/lib/mailhero-backup"))
    parser.add_argument("--config-dir", type=Path, default=Path("/run/mailhero-backup"))
    args = parser.parse_args()
    try:
        if args.command == "health":
            return 0 if healthy(args.state) else 1
        handler = stop_scheduler if args.command == "run" else stop_collection
        signal.signal(signal.SIGTERM, handler)
        signal.signal(signal.SIGINT, handler)
        if args.command == "once":
            return once(args.state, args.config_dir)
        return run(args.state, args.config_dir, parse_schedule(os.environ.get("BACKUP_AT_UTC", "04:17")))
    except RuntimeErrorCode as exc:
        emit(str(exc))  # All RuntimeErrorCode values are fixed, content-free constants.
        return 75 if str(exc) == "backup_already_running" else 1
    except StopRequested:
        emit("stopped")
        return 130
    except Exception:
        emit("backup_runtime_failed")
        return 1


if __name__ == "__main__":
    sys.exit(main())

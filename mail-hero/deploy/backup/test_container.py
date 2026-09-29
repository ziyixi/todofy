import contextlib
import datetime as dt
import io
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

import container as runtime
import mailhero_backup as collector
from test_backup import SyntheticSnapshot

UTC = dt.timezone.utc
NOW = dt.datetime(2026, 9, 27, 12, 0, tzinfo=UTC)


def write_config(path):
    path.mkdir(mode=0o700)
    values = {
        "MAIL_HERO_ORIGIN": "https://example.invalid", "BACKUP_RECIPIENT": "A" * 40,
        "BACKUP_TOKEN": "synthetic-token-" * 4, "BACKUP_RECEIPT_KEY": "ab" * 32,
        "CF_ACCESS_CLIENT_ID": "synthetic-id", "CF_ACCESS_CLIENT_SECRET": "synthetic-secret",
    }
    target = path / "credentials.env"
    target.write_text("\n".join(key + "=" + value for key, value in values.items()))
    target.chmod(0o600)
    (path / "recovery-public.asc").write_text("synthetic-public-key")
    (path / "credential-key.gpg").write_bytes(b"synthetic-encrypted-key")
    return values


class ScheduleTests(unittest.TestCase):
    def test_restart_catches_up_but_current_receipt_waits_next_daily_slot(self):
        schedule = (4, 17)
        self.assertEqual(runtime.next_attempt(NOW, schedule, {}, {}), NOW)
        yesterday = {"verified_at": "2026-09-26T05:00:00Z"}
        self.assertEqual(runtime.next_attempt(NOW, schedule, yesterday, {}), NOW)
        today = {"verified_at": "2026-09-27T04:17:00Z"}
        self.assertEqual(runtime.next_attempt(NOW, schedule, today, {}), NOW.replace(day=28, hour=4, minute=17))

    def test_before_daily_slot_recent_manual_run_covers_prior_slot(self):
        now = NOW.replace(hour=2)
        receipt = {"verified_at": "2026-09-26T22:00:00Z"}
        self.assertEqual(runtime.next_attempt(now, (4, 17), receipt, {}), NOW.replace(hour=4, minute=17))

    def test_failed_attempt_backoff_survives_restart_and_is_bounded(self):
        attempt = {"outcome": "failed", "finished_at": runtime.timestamp(NOW),
                   "retry_at": runtime.timestamp(NOW + dt.timedelta(minutes=45))}
        self.assertEqual(runtime.next_attempt(NOW, (4, 17), {}, attempt), NOW + dt.timedelta(minutes=45))
        attempt["retry_at"] = "2030-01-01T00:00:00Z"
        self.assertEqual(runtime.next_attempt(NOW, (4, 17), {}, attempt), NOW + dt.timedelta(hours=1))
        later = NOW + dt.timedelta(minutes=30)
        self.assertEqual(runtime.next_attempt(later, (4, 17), {}, attempt), NOW + dt.timedelta(hours=1))
        self.assertEqual(runtime.next_attempt(NOW + dt.timedelta(hours=2), (4, 17), {}, attempt), NOW + dt.timedelta(hours=2))
        attempt["finished_at"] = runtime.timestamp(NOW + dt.timedelta(days=1))
        self.assertEqual(runtime.next_attempt(NOW, (4, 17), {}, attempt), NOW)

    def test_schedule_and_naive_or_corrupt_dates_rejected(self):
        self.assertEqual(runtime.parse_schedule("23:59"), (23, 59))
        for invalid in ("24:00", "4:17", "00:60", "04:17;whoami"):
            with self.assertRaises(runtime.RuntimeErrorCode):
                runtime.parse_schedule(invalid)
        self.assertIsNone(runtime.parse_timestamp("2026-09-27T04:17:00"))
        self.assertIsNone(runtime.parse_timestamp({}))
        self.assertEqual(runtime.next_attempt(NOW, (4, 17), {"verified_at": "bad"}, {}), NOW)


class ConfigAndLockTests(unittest.TestCase):
    def test_config_never_executes_shell_and_refuses_ambiguous_entries(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "config"
            values = write_config(path)
            target = path / "credentials.env"
            original = target.read_text()
            marker = Path(root) / "must-not-exist"
            target.write_text(original.replace(values["BACKUP_TOKEN"], "$(touch " + str(marker) + ")"))
            self.assertEqual(runtime.read_config(path)["BACKUP_TOKEN"], "$(touch " + str(marker) + ")")
            self.assertFalse(marker.exists())
            for addition in ("\nBACKUP_TOKEN=duplicate", "\nexport EVIL=x", "\nUNKNOWN=x"):
                target.write_text(original + addition)
                with self.assertRaises(runtime.RuntimeErrorCode):
                    runtime.read_config(path)
            target.write_text(original)
            target.chmod(0o644)
            with self.assertRaises(runtime.RuntimeErrorCode):
                runtime.read_config(path)

    def test_file_symlinks_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "config"
            write_config(path)
            target = path / "credentials.env"
            target.rename(path / "real-env")
            target.symlink_to("real-env")
            with self.assertRaises(runtime.RuntimeErrorCode):
                runtime.read_config(path)

    def test_manual_collection_cannot_overlap_scheduler_collection(self):
        with tempfile.TemporaryDirectory() as root:
            state = Path(root)
            state.chmod(0o700)
            with runtime.locked(state / "collection.lock"):
                completed = subprocess.run([sys.executable, "-I", str(Path(runtime.__file__).resolve()),
                    "once", "--state", str(state), "--config-dir", str(state / "absent")], capture_output=True, text=True)
            self.assertEqual(completed.returncode, 75)
            self.assertEqual(json.loads(completed.stdout), {"state": "backup_already_running"})
            self.assertEqual(completed.stderr, "")


class CollectionTests(unittest.TestCase):
    def test_real_collector_cancellation_releases_lease_and_removes_plaintext(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            config, state = root / "config", root / "state"
            write_config(config)
            fake = SyntheticSnapshot()
            original_json = fake.json

            def interrupted(action, *args, **kwargs):
                if action == "/database-schema":
                    raise runtime.StopRequested()
                return original_json(action, *args, **kwargs)

            fake.json = interrupted
            before = os.environ.get("BACKUP_TOKEN")
            out = io.StringIO()
            with patch.object(runtime, "load_collector", return_value=collector), \
                    patch.object(collector, "Client", return_value=fake), \
                    patch.object(collector.shutil, "which", return_value="/synthetic/gpg"), \
                    contextlib.redirect_stdout(out):
                code = runtime.once(state, config)
            self.assertEqual(code, 130)
            self.assertTrue(fake.cancelled)
            self.assertFalse(list(state.glob(".snapshot-*")))
            self.assertEqual(os.environ.get("BACKUP_TOKEN"), before)
            self.assertEqual(json.loads(out.getvalue()), {"state": "stopped"})
            self.assertEqual(runtime.read_json(state / "collection-state.json")["outcome"], "stopped")

    def test_failure_is_redacted_and_success_requires_new_durable_receipt(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            config, state = root / "config", root / "state"
            write_config(config)
            out = io.StringIO()
            with patch.object(runtime, "load_collector", return_value=collector), \
                    patch.object(collector, "collect", side_effect=ValueError("private synthetic mail and token")), \
                    contextlib.redirect_stdout(out):
                self.assertEqual(runtime.once(state, config), 1)
            self.assertEqual(json.loads(out.getvalue()), {"state": "backup_failed"})
            self.assertNotIn("private synthetic", (state / "collection-state.json").read_text())
            with patch.object(runtime, "load_collector", return_value=collector), \
                    patch.object(collector, "collect", return_value=None), \
                    contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(runtime.once(state, config), 1)

            def success(args):
                collector.atomic_json(args.output / "latest-success.json", {"verified_at": runtime.timestamp()})
            with patch.object(runtime, "load_collector", return_value=collector), \
                    patch.object(collector, "collect", side_effect=success), \
                    contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(runtime.once(state, config), 0)


class HealthTests(unittest.TestCase):
    def test_health_requires_live_scheduler_and_fresh_local_receipt(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            heartbeat = {"heartbeat_at": runtime.timestamp(NOW), "started_at": runtime.timestamp(NOW - dt.timedelta(hours=2))}
            collector.atomic_json(root / "scheduler.json", heartbeat)
            self.assertFalse(runtime.healthy(root, NOW))
            collector.atomic_json(root / "latest-success.json", {"verified_at": runtime.timestamp(NOW - dt.timedelta(hours=25))})
            self.assertTrue(runtime.healthy(root, NOW))
            self.assertFalse(runtime.healthy(root, NOW + dt.timedelta(minutes=3)))
            heartbeat["stopping"] = True
            collector.atomic_json(root / "scheduler.json", heartbeat)
            self.assertFalse(runtime.healthy(root, NOW))

    def test_empty_initial_state_only_gets_thirty_minute_grace(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            collector.atomic_json(root / "scheduler.json", {"heartbeat_at": runtime.timestamp(NOW), "started_at": runtime.timestamp(NOW)})
            self.assertTrue(runtime.healthy(root, NOW))
            collector.atomic_json(root / "scheduler.json", {"heartbeat_at": runtime.timestamp(NOW), "started_at": runtime.timestamp(NOW - dt.timedelta(hours=1))})
            self.assertFalse(runtime.healthy(root, NOW))

    def test_scheduler_process_stops_cleanly_without_any_network_call(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            root.chmod(0o700)
            collector.atomic_json(root / "latest-success.json", {"verified_at": runtime.timestamp()})
            child = subprocess.Popen([sys.executable, "-I", str(Path(runtime.__file__).resolve()), "run",
                "--state", str(root), "--config-dir", str(root / "absent")], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            try:
                deadline = time.monotonic() + 10
                while not (root / "scheduler.json").exists() and time.monotonic() < deadline:
                    time.sleep(0.05)
                self.assertTrue(runtime.healthy(root))
                child.send_signal(signal.SIGTERM)
                out, err = child.communicate(timeout=15)
                self.assertEqual(child.returncode, 0)
                self.assertEqual(err, "")
                self.assertEqual(json.loads(out.splitlines()[-1]), {"state": "scheduler_stopped"})
                self.assertFalse(runtime.healthy(root))
            finally:
                if child.poll() is None:
                    child.kill()
                    child.wait()


if __name__ == "__main__":
    unittest.main()

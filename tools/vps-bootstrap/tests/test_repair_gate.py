"""Real synthetic admission transitions; no providers, process startup or private database."""

import contextlib
import importlib.util
import sqlite3
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "tools/vps-bootstrap"))
import repair_gate

SPEC = importlib.util.spec_from_file_location(
    "repair_test_drain", ROOT / "newsletter/src/newsletter/drain.py"
)
DRAIN = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DRAIN)

OLD, NEW = "release-" + "a" * 40, "release-" + "b" * 40


class Store:
    def __init__(self):
        self.db = sqlite3.connect(":memory:", isolation_level=None)
        self.db.executescript("""
            CREATE TABLE editions(state TEXT, body TEXT);
            CREATE TABLE packets(projection TEXT);
            CREATE TABLE collection_runs(state TEXT);
            INSERT INTO editions VALUES ('queued','{"delivery_state":"unknown"}');
            INSERT INTO packets VALUES ('unknown');
            INSERT INTO collection_runs VALUES ('queued');
        """)
        self.deployment = DRAIN.DeploymentDrain(self)
        self.db.execute(
            "INSERT INTO deployment_activities VALUES('historical','provider','interrupted')"
        )

    @contextlib.contextmanager
    def transaction(self):
        self.db.execute("BEGIN IMMEDIATE")
        try:
            yield
            self.db.execute("COMMIT")
        except BaseException:
            self.db.execute("ROLLBACK")
            raise


class RepairGateTests(unittest.TestCase):
    def setUp(self):
        self.store = Store()
        self.addCleanup(self.store.db.close)
        self.store.deployment.begin(OLD)

    def test_preserves_every_unknown_row_and_queue_without_starting_work(self):
        self.store.deployment.freeze(OLD)
        before = self.store.deployment.status()
        receipt = repair_gate.rekey(self.store, OLD, NEW)
        self.assertEqual(receipt["unknown"], before["unknown"])
        self.assertEqual(receipt["queued"], before["queued"])
        self.assertEqual(receipt["state"], "frozen")
        self.assertEqual(
            self.store.db.execute("SELECT state FROM deployment_activities").fetchall(),
            [("interrupted",)],
        )
        self.assertEqual(self.store.deployment.status()["request_key"], NEW)
        self.assertEqual(repair_gate.rekey(self.store, OLD, NEW), receipt)

    def test_draining_quiet_old_owner_can_transfer_and_freeze(self):
        self.assertEqual(repair_gate.rekey(self.store, OLD, NEW)["state"], "frozen")

    def test_busy_actual_work_refuses_resume_or_other_mutation(self):
        self.store.db.execute(
            "INSERT INTO deployment_activities VALUES('running','provider','active')"
        )
        with self.assertRaisesRegex(repair_gate.GateError, "REPAIR_ADMISSION_BUSY"):
            repair_gate.rekey(self.store, OLD, NEW)
        self.assertEqual(self.store.deployment.status()["request_key"], OLD)

    def test_another_operation_is_never_cancelled(self):
        with self.assertRaisesRegex(repair_gate.GateError, "REPAIR_ADMISSION_CONFLICT"):
            repair_gate.rekey(self.store, "release-other", NEW)
        self.assertEqual(self.store.deployment.status()["request_key"], OLD)

    def test_active_gap_requires_explicit_interrupted_repair(self):
        self.store.deployment.resume(OLD)
        with self.assertRaisesRegex(repair_gate.GateError, "REPAIR_ADMISSION_CONFLICT"):
            repair_gate.rekey(self.store, OLD, NEW)
        receipt = repair_gate.rekey(self.store, OLD, NEW, interrupted=True)
        self.assertEqual(receipt["request_key"], NEW)
        self.assertEqual(receipt["unknown"]["interrupted_activities"], 1)

    def test_active_gap_without_old_operation_fails_closed(self):
        other = Store()
        self.addCleanup(other.db.close)
        with self.assertRaises(DRAIN.DrainError):
            repair_gate.rekey(other, OLD, NEW, interrupted=True)
        self.assertEqual(other.deployment.status()["state"], "active")

    def test_legacy_resume_that_erases_history_cannot_claim_success(self):
        original = self.store.deployment.resume

        def destructive(key):
            result = original(key)
            self.store.db.execute(
                "DELETE FROM deployment_activities WHERE state='interrupted'"
            )
            return result

        self.store.deployment.resume = destructive
        with self.assertRaisesRegex(repair_gate.GateError, "REPAIR_HISTORY_CHANGED"):
            repair_gate.rekey(self.store, OLD, NEW)
        self.assertEqual(self.store.deployment.status()["request_key"], NEW)
        self.assertEqual(self.store.deployment.status()["state"], "frozen")


if __name__ == "__main__":
    unittest.main()

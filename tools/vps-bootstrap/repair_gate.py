"""Offline admission maintenance; no lifecycle, recovery, provider or background worker."""

import json
import re
import sys
from pathlib import Path


class GateError(RuntimeError):
    """One safe recovery error without database or upstream content."""


def quiet(value):
    if value.get("busy") is not False or any(value.get("inflight", {}).values()):
        raise GateError("REPAIR_ADMISSION_BUSY")
    return {name: dict(value[name]) for name in ("unknown", "queued")}


def rekey(store, previous, target, *, interrupted=False):
    """Transfer a stopped owner's gate with ordinary domain transitions; preserve history."""
    value = store.deployment.status()
    before = quiet(value)
    identity, state = value["request_key"], value["state"]
    if identity == target and state in {"draining", "frozen"}:
        pass
    elif identity == previous and state in {"draining", "frozen"}:
        store.deployment.freeze(previous)
        store.deployment.resume(previous)
        store.deployment.begin(target)
    elif interrupted and identity is None and state == "active":
        # A crash can leave no active gate after the old resume. This exact
        # receipt must exist; the maintenance owner is the only running writer.
        resumed = store.deployment.resume(previous)
        if resumed["request_key"] != previous or resumed["state"] != "resumed":
            raise GateError("REPAIR_ADMISSION_CONFLICT")
        store.deployment.begin(target)
    else:
        raise GateError("REPAIR_ADMISSION_CONFLICT")
    store.deployment.freeze(target)
    after = store.deployment.status()
    if (
        after["request_key"] != target
        or after["state"] != "frozen"
        or quiet(after) != before
    ):
        raise GateError("REPAIR_HISTORY_CHANGED")
    return {"version": 1, "state": "frozen", "request_key": target, **before}


def main():
    # The root wrapper stops every business pod before creating this fixed Job.
    from newsletter.ownership import exclusive_store
    from newsletter.store import Store

    if (
        len(sys.argv) not in {3, 4}
        or any(re.fullmatch(r"[0-9a-f]{40}", value) is None for value in sys.argv[1:3])
        or (len(sys.argv) == 4 and sys.argv[3] != "--resume-interrupted")
    ):
        raise GateError("REPAIR_IDENTITY_INVALID")
    previous, target = ("release-" + value for value in sys.argv[1:3])
    if previous == target:
        raise GateError("REPAIR_IDENTITY_INVALID")
    directory = Path("/var/lib/newsletter")
    if not (directory / "newsletter.sqlite3").is_file():
        raise GateError("REPAIR_DATABASE_MISSING")
    with exclusive_store(directory):
        store = Store(directory / "newsletter.sqlite3", "live")
        try:
            receipt = rekey(store, previous, target, interrupted=len(sys.argv) == 4)
        finally:
            store.close()
    print(json.dumps(receipt, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except Exception:  # noqa: BLE001 — no provider or database traceback in public diagnostics.
        print(json.dumps({"error_code": "REPAIR_GATE_FAILED"}))
        sys.exit(1)

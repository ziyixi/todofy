"""One non-root system-bus observation, handed off through a per-pod emptyDir."""

import datetime as dt
import json
import os
import tempfile
from pathlib import Path

from ziyixi_proto.fleet.telemetry.v1.host_report_pb import SystemDaemonSnapshot
from ziyixi_proto.http_routes import decode_json_body
from ziyixi_proto.wire_json import from_wire, to_wire

from .systemd import ACTIVE_STATES, DIAGNOSTIC_CODES, DIAGNOSTIC_STAGES, UNITS, daemon
from .transport import ObserverError

SNAPSHOT_PATH = Path("/run/observer-systemd/snapshot.json")
MAX_BYTES = 4096
MAX_AGE_SECONDS = 120
FUTURE_TOLERANCE_SECONDS = 5
TERMINATION_PATH = Path("/dev/termination-log")
READ_CODES = {"NOT_READ", "READ_OK", "UNREADABLE", "INVALID", "STALE", "FUTURE"}
READ_CODE = "NOT_READ"


def write_termination(code, *, units=None, snapshot=None):
    """Only fixed status metadata; never logs or D-Bus response contents."""
    if code not in {
        "SYSTEMD_COMPLETE",
        "SYSTEMD_FAILED",
        "OBSERVER_ACCEPTED",
        "OBSERVER_FAILED",
    }:
        raise ValueError("invalid termination code")
    value = {"version": 1, "code": code}
    if units is not None:
        value["units"] = []
        for unit in units:
            if (
                set(unit) == {"unit", "state", "stage", "code"}
                and unit["unit"] in UNITS
                and unit["state"] in ACTIVE_STATES | {"unknown", "missing"}
                and unit["stage"] in DIAGNOSTIC_STAGES
                and unit["code"] in DIAGNOSTIC_CODES
            ):
                value["units"].append(unit)
    if snapshot in READ_CODES:
        value["snapshot"] = snapshot
    raw = json.dumps(value, separators=(",", ":"), ensure_ascii=True).encode()
    if len(raw) > 1024:
        raw = b'{"version":1,"code":"DIAGNOSTIC_TOO_LARGE"}'
    try:
        TERMINATION_PATH.write_bytes(raw)
    except OSError:
        pass


def read() -> dict[str, dict[str, str]]:
    """Unreadable, malformed and stale observations remain unknown."""
    global READ_CODE
    READ_CODE = "UNREADABLE"
    unknown = {name: {"state": "unknown"} for name in UNITS}
    try:
        with SNAPSHOT_PATH.open("rb") as source:
            raw = source.read(MAX_BYTES + 1)
        READ_CODE = "INVALID"
        value = to_wire(
            from_wire(
                SystemDaemonSnapshot,
                decode_json_body(raw, max_bytes=MAX_BYTES),
                strict=True,
            ).message
        )
        observed = dt.datetime.fromisoformat(
            value["observation_time"].replace("Z", "+00:00")
        )
        age = (dt.datetime.now(dt.timezone.utc) - observed).total_seconds()
        if not -FUTURE_TOLERANCE_SECONDS <= age <= MAX_AGE_SECONDS:
            READ_CODE = "STALE" if age > MAX_AGE_SECONDS else "FUTURE"
            return unknown
        READ_CODE = "READ_OK"
        return {**unknown, **value["daemons"]}
    except (OSError, KeyError, TypeError, ValueError):
        return unknown


def write(diagnostics=None) -> None:
    """No application configuration or credentials are read by this init command."""
    diagnostics = diagnostics if diagnostics is not None else []
    value = {
        "observation_time": dt.datetime.now(dt.timezone.utc)
        .isoformat(timespec="seconds")
        .replace("+00:00", "Z"),
        "daemons": {},
    }
    for name in UNITS:
        detail = {}
        diagnostics.append(detail)
        value["daemons"][name] = daemon(name, diagnostic=detail)
    message = from_wire(SystemDaemonSnapshot, value, strict=True).message
    raw = json.dumps(
        to_wire(message), separators=(",", ":"), ensure_ascii=True
    ).encode()
    if len(raw) > MAX_BYTES:
        raise ObserverError("systemd_snapshot_too_large")
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(
            dir=SNAPSHOT_PATH.parent, prefix=".snapshot-", mode="wb", delete=False
        ) as output:
            temporary = Path(output.name)
            os.fchmod(output.fileno(), 0o640)
            output.write(raw)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, SNAPSHOT_PATH)
        descriptor = os.open(SNAPSHOT_PATH.parent, os.O_DIRECTORY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def main() -> int:
    diagnostics = []
    try:
        write(diagnostics)
    except (ObserverError, OSError, KeyError, TypeError, ValueError) as error:
        result = {"event": "systemd_observer", "status": "failed"}
        if error.args == ("unsafe_system_bus_authorization",):
            result["code"] = "UNSAFE_SYSTEM_BUS_AUTHORIZATION"
        write_termination("SYSTEMD_FAILED", units=diagnostics)
        print(json.dumps(result))
        return 1
    print(json.dumps({"event": "systemd_observer", "status": "complete"}))
    write_termination("SYSTEMD_COMPLETE", units=diagnostics)
    return 0

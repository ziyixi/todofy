"""One non-root system-bus observation, handed off through a per-pod emptyDir."""

import datetime as dt
import json
import os
import tempfile
from pathlib import Path

from ziyixi_proto.fleet.telemetry.v1.host_report_pb import SystemDaemonSnapshot
from ziyixi_proto.http_routes import decode_json_body
from ziyixi_proto.wire_json import from_wire, to_wire

from .systemd import UNITS, daemon
from .transport import ObserverError

SNAPSHOT_PATH = Path("/run/observer-systemd/snapshot.json")
MAX_BYTES = 4096
MAX_AGE_SECONDS = 120
FUTURE_TOLERANCE_SECONDS = 5


def read() -> dict[str, dict[str, str]]:
    """Unreadable, malformed and stale observations remain unknown."""
    unknown = {name: {"state": "unknown"} for name in UNITS}
    try:
        with SNAPSHOT_PATH.open("rb") as source:
            raw = source.read(MAX_BYTES + 1)
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
            return unknown
        return {**unknown, **value["daemons"]}
    except (OSError, KeyError, TypeError, ValueError):
        return unknown


def write() -> None:
    """No application configuration or credentials are read by this init command."""
    value = {
        "observation_time": dt.datetime.now(dt.timezone.utc)
        .isoformat(timespec="seconds")
        .replace("+00:00", "Z"),
        "daemons": {name: daemon(name) for name in UNITS},
    }
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
    try:
        write()
    except (ObserverError, OSError, KeyError, TypeError, ValueError) as error:
        result = {"event": "systemd_observer", "status": "failed"}
        if str(error) == "unsafe_system_bus_authorization":
            result["code"] = "UNSAFE_SYSTEM_BUS_AUTHORIZATION"
        print(json.dumps(result))
        return 1
    print(json.dumps({"event": "systemd_observer", "status": "complete"}))
    return 0

"""Content-free host observer. No SSH, models, mail, logs or remote commands."""

from __future__ import annotations

import datetime as dt
import fcntl
import hashlib
import hmac
import json
import os
import re
import tempfile
import urllib.parse
from pathlib import Path

from .collector import observe
from .transport import ObserverError, _request


def atomic(path: Path, value: object) -> None:
    with tempfile.NamedTemporaryFile(
        dir=path.parent, prefix=".fleet-", mode="w", delete=False
    ) as output:
        os.chmod(output.name, 0o600)
        json.dump(value, output, separators=(",", ":"))
        output.flush()
        os.fsync(output.fileno())
        temporary = output.name
    os.replace(temporary, path)
    descriptor = os.open(path.parent, os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def run(env: dict[str, str]) -> None:
    origin = env.get("FLEET_REPORT_URL", "")
    url = urllib.parse.urlsplit(origin)
    if (
        url.scheme != "https"
        or not url.hostname
        or url.username
        or url.password
        or url.query
        or url.fragment
        or url.path != "/api/internal/fleet/v1/receipt"
    ):
        raise ObserverError("invalid_report_origin")
    secret = env.get("FLEET_REPORT_HMAC_KEY", "")
    if re.fullmatch(r"[0-9a-fA-F]{64}", secret) is None:
        raise ObserverError("invalid_credential")
    directory = Path(env.get("FLEET_STATE_DIR", "/var/lib/observer"))
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (directory / "observer.lock").open("a") as lock:
        os.chmod(lock.name, 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        path = directory / "state.json"
        state = json.loads(path.read_text()) if path.exists() else {"sequence": 0}
        pending = state.get("pending")
        if pending:
            observed = dt.datetime.fromisoformat(
                json.loads(pending)["observation_time"].replace("Z", "+00:00")
            )
            if (dt.datetime.now(dt.timezone.utc) - observed).total_seconds() > 540:
                pending = None
        if not pending:
            sequence = state["sequence"] + 1
            if sequence > 2147483647:
                raise ObserverError("sequence_exhausted")
            pending = observe(env, sequence).decode()
            state = {"sequence": sequence, "pending": pending}
            atomic(path, state)
        data = pending.encode()
        signature = hmac.new(bytes.fromhex(secret), data, hashlib.sha256).hexdigest()
        status, ack = _request(
            origin,
            headers={
                "Content-Type": "application/json",
                "X-Fleet-Key-Id": "primary",
                "X-Fleet-Signature": signature,
            },
            data=data,
            limit=4096,
        )
        if (
            status != 200
            or not isinstance(ack, dict)
            or set(ack) != {"version", "accepted", "sequence"}
            or ack["version"] != "fleet-receipt-v1"
            or type(ack["accepted"]) is not bool
            or type(ack["sequence"]) is not int
            or ack["sequence"] != state["sequence"]
        ):
            raise ObserverError("report_rejected")
        atomic(path, {"sequence": state["sequence"]})

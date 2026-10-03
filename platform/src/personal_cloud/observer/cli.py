"""Run a bounded metadata observation and send its persistent signed receipt."""

import json
import os

from . import systemd_snapshot
from .state import run
from .transport import ObserverError


def main() -> int:
    systemd_snapshot.READ_CODE = "NOT_READ"
    try:
        run(dict(os.environ))
    except ObserverError as error:
        result = {"event": "fleet_observer", "status": "failed"}
        if error.args == ("unsafe_system_bus_authorization",):
            result["code"] = "UNSAFE_SYSTEM_BUS_AUTHORIZATION"
        systemd_snapshot.write_termination(
            "OBSERVER_FAILED", snapshot=systemd_snapshot.READ_CODE
        )
        print(json.dumps(result))
        return 1
    except (OSError, ValueError, KeyError, TypeError):
        systemd_snapshot.write_termination(
            "OBSERVER_FAILED", snapshot=systemd_snapshot.READ_CODE
        )
        print(json.dumps({"event": "fleet_observer", "status": "failed"}))
        return 1
    print(json.dumps({"event": "fleet_observer", "status": "accepted"}))
    systemd_snapshot.write_termination(
        "OBSERVER_ACCEPTED", snapshot=systemd_snapshot.READ_CODE
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

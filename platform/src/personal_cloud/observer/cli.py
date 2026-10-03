"""Run a bounded metadata observation and send its persistent signed receipt."""

import json
import os

from .state import run
from .transport import ObserverError


def main() -> int:
    try:
        run(dict(os.environ))
    except ObserverError as error:
        result = {"event": "fleet_observer", "status": "failed"}
        if str(error) == "unsafe_system_bus_authorization":
            result["code"] = "UNSAFE_SYSTEM_BUS_AUTHORIZATION"
        print(json.dumps(result))
        return 1
    except (OSError, ValueError, KeyError, TypeError):
        print(json.dumps({"event": "fleet_observer", "status": "failed"}))
        return 1
    print(json.dumps({"event": "fleet_observer", "status": "accepted"}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

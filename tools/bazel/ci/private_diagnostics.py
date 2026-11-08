"""Project bounded private runtime observations into fixed public diagnostic codes."""

import json
import sys

PHASES = {"before_rollout": "BEFORE_ROLLOUT", "verification": "VERIFICATION"}
CAUSES = {
    "duckdb_memory": "DATABASE_MEMORY",
    "duckdb": "DATABASE",
    "python_memory": "PROCESS_MEMORY",
    "sqlite": "METADATA_DATABASE",
    "local_io": "LOCAL_IO",
    "local_data": "LOCAL_DATA",
    "durability": "DURABILITY",
}
CODES = {
    "STORAGE_RECOVERY_REQUIRED": "RECOVERY_REQUIRED",
    "STORAGE_DATA_INVALID": "CACHE_INVALID",
    "STORAGE_UNAVAILABLE": "STORAGE_UNAVAILABLE",
    "STORAGE_DENIED": "STORAGE_DENIED",
    "STORAGE_RATE_LIMITED": "STORAGE_RATE_LIMITED",
}


def count(value, maximum):
    return type(value) is int and 0 <= value <= maximum


def observations(event):
    if not isinstance(event, dict):
        return set()
    phase = event.get("phase")
    if not isinstance(phase, str) or phase not in PHASES:
        return set()
    phase = PHASES[phase]
    if (
        event.get("event") != "private_ingress_collector_logs_probe"
        or event.get("available") is not True
    ):
        return set()
    result = set()
    for field, tail in (("current", "ACTIVE_LOG"), ("previous", "PRIOR_LOG")):
        summary = event.get(field)
        if not isinstance(summary, dict) or summary.get("available") is not True:
            continue
        lines = summary.get("line_count")
        if not count(lines, 100):
            continue
        durable = summary.get("durable_failures")
        causes = durable.get("causes") if isinstance(durable, dict) else None
        for values, allowed in (
            (summary.get("exception_classes"), CAUSES),
            (causes, CAUSES),
            (summary.get("codes"), CODES),
        ):
            if isinstance(values, dict):
                result.update(
                    (phase, tail, allowed[key])
                    for key, value in values.items()
                    if key in allowed and count(value, lines) and value > 0
                )
        tracebacks = summary.get("traceback_count")
        if count(tracebacks, lines) and tracebacks > 0:
            result.add((phase, tail, "TRACEBACK_PRESENT"))
    return result


def project(path):
    result = set()
    try:
        with open(path, "rb") as source:
            while line := source.readline(65537):
                if len(line) > 65536:
                    while line and not line.endswith(b"\n"):
                        line = source.readline(65537)
                    continue
                try:
                    result.update(observations(json.loads(line)))
                except (ValueError, TypeError, UnicodeDecodeError, RecursionError):
                    continue
    except OSError:
        return set()
    return result


if __name__ == "__main__" and len(sys.argv) == 2:
    for observation in sorted(project(sys.argv[1])):
        print("::notice::PRIVATE_DIAGNOSTIC=" + ",".join(observation))

"""One-time stopped-owner bootstrap repair; normal deployments remain daemon API releases."""

import argparse
import hashlib
import json
import os
from pathlib import Path

import cluster
import host
from reader import install_reader
from repair_checks import empty_ledger, inputs, marker_identity
from repair_kube import Runtime

from config import BootstrapError, load_bundle, read_json, require

MARKER = Path("/etc/rancher/k3s/personal-cloud-bootstrap-repair.json")
PHASES = {"stopping", "stopped", "gate_transfer", "gate_frozen", "complete_held"}


def event(phase, status):
    print(
        json.dumps({"event": "vps_bootstrap_repair", "phase": phase, "status": status}),
        flush=True,
    )


def checkpoint(identity, phase, jobs):
    value = {**identity, "phase": phase, "daily_job_uids": jobs}
    host.write_file(MARKER, json.dumps(value, sort_keys=True).encode(), replace=True)
    return value


def current(identity):
    path = host.real_path(MARKER)
    if not path.exists():
        return None
    require(
        path.is_file()
        and path.stat().st_uid == 0
        and path.stat().st_mode & 0o777 == 0o600,
        "REPAIR_MARKER_INVALID",
    )
    value = read_json(path, private=True)
    require(
        set(value) == {*identity, "phase", "daily_job_uids"}
        and all(value.get(key) == expected for key, expected in identity.items())
        and value["phase"] in PHASES
        and isinstance(value["daily_job_uids"], list),
        "REPAIR_MARKER_CONFLICT",
    )
    return value


def maintenance_job(directory, previous, public, *, interrupted=False):
    script = (Path(directory) / "installer/repair_gate.py").read_text()
    arguments = ["python", "-c", script, previous["source_sha"], public["source_sha"]]
    if interrupted:
        arguments.append("--resume-interrupted")
    return {
        "apiVersion": "batch/v1",
        "kind": "Job",
        "metadata": {
            "name": "bootstrap-repair-" + public["source_sha"][:12],
            "namespace": public["profile"]["namespace"],
            "annotations": {
                "personal-cloud/repair-script": hashlib.sha256(
                    script.encode()
                ).hexdigest()
            },
        },
        "spec": {
            "backoffLimit": 0,
            "activeDeadlineSeconds": 120,
            "template": {
                "metadata": {"labels": {"app": "bootstrap-repair"}},
                "spec": {
                    "automountServiceAccountToken": False,
                    "restartPolicy": "Never",
                    "securityContext": {
                        "runAsNonRoot": True,
                        "runAsUser": 10001,
                        "runAsGroup": 10001,
                        "seccompProfile": {"type": "RuntimeDefault"},
                    },
                    "containers": [
                        {
                            "name": "maintenance",
                            "image": public["images"]["newsletter"],
                            "command": arguments,
                            "securityContext": {
                                "allowPrivilegeEscalation": False,
                                "readOnlyRootFilesystem": True,
                                "capabilities": {"drop": ["ALL"]},
                            },
                            "resources": {
                                "requests": {"cpu": "25m", "memory": "64Mi"},
                                "limits": {"cpu": "250m", "memory": "256Mi"},
                            },
                            "volumeMounts": [
                                {"name": "data", "mountPath": "/var/lib/newsletter"}
                            ],
                        }
                    ],
                    "volumes": [
                        {
                            "name": "data",
                            "persistentVolumeClaim": {"claimName": "newsletter-data"},
                        }
                    ],
                },
            },
        },
    }


def repair(previous_directory, directory):
    require(os.geteuid() == 0, "ROOT_REQUIRED_FOR_BOOTSTRAP_REPAIR")
    previous, public, old_runtime, new_runtime = inputs(previous_directory, directory)
    identity = marker_identity(directory)
    value = current(identity)
    if value and value["phase"] == "complete_held":
        event("repair", "already_repaired")
        return
    profile = public["profile"]
    runtime = Runtime(profile["namespace"])
    empty_ledger(profile)
    jobs = runtime.daily_jobs()
    if value:
        require(jobs == value["daily_job_uids"], "REPAIR_NEW_DAILY_JOB")
        runtime.expected(
            old_runtime, new_runtime if value["phase"] == "gate_frozen" else None
        )
    else:
        runtime.expected(old_runtime, first=True)
        runtime.admission(previous["source_sha"])
        value = checkpoint(identity, "stopping", jobs)
    mutated = False
    try:
        mutated = True
        runtime.stop()
        empty_ledger(profile)
        require(runtime.daily_jobs() == jobs, "REPAIR_NEW_DAILY_JOB")
        if value["phase"] not in {"gate_transfer", "gate_frozen"}:
            value = checkpoint(identity, "stopped", jobs)
        interrupted = value["phase"] == "gate_transfer"
        if value["phase"] != "gate_frozen":
            checkpoint(identity, "gate_transfer", jobs)
        receipt = runtime.gate_job(
            maintenance_job(directory, previous, public, interrupted=interrupted)
        )
        require(
            receipt["request_key"] == "release-" + public["source_sha"],
            "REPAIR_GATE_RECEIPT_INVALID",
        )
        checkpoint(identity, "gate_frozen", jobs)
        require(runtime.daily_jobs() == jobs, "REPAIR_NEW_DAILY_JOB")
        empty_ledger(profile)
        cluster.held_runtime(directory, profile["namespace"])
        runtime.expected(new_runtime)
        require(runtime.daily_jobs() == jobs, "REPAIR_NEW_DAILY_JOB")
        checkpoint(identity, "complete_held", jobs)
        event("repair", "complete_held")
    except BaseException:
        if mutated:
            # A partial new apply can have restarted pods. Failure never restores
            # the broken image or starts business; the new gate remains durable.
            runtime.stop()
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--previous-bundle", type=Path, required=True)
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--grant-reader", action="store_true")
    args = parser.parse_args()
    try:
        require(
            Path(__file__).resolve() == (args.bundle / "installer/repair.py").resolve(),
            "REPAIR_SCRIPT_NOT_IN_BUNDLE",
        )
        repair(args.previous_bundle, args.bundle)
        if args.grant_reader:
            namespace = load_bundle(args.bundle)["profile"]["namespace"]
            expiry = install_reader(namespace)
            print(json.dumps({"event": "namespace_reader", "expires_at": expiry}))
    except BootstrapError as error:
        print(
            json.dumps(
                {
                    "event": "vps_bootstrap_repair",
                    "status": "failed",
                    "error_code": str(error),
                }
            )
        )
        return 1
    except Exception:  # noqa: BLE001 — private inputs and raw Kubernetes output are never printed.
        event("repair", "failed")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

"""Typed Actions repair/resume, independent ready evidence and no-op boundaries."""

import json
import stat
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path

import httpx
import test_deploy as support
from evidence import write_evidence
from reconcile import execute
from test_deploy import NAME, TARGETS, TIME, Clock, node, release
from transport import ReleaseFailure
from ziyixi_proto.platform.runtime.v1 import runtime_pb as pb
from ziyixi_proto.wire_json import to_wire

REPAIR = "6f58d2d3-18b1-4681-a3bd-742c9b6e57ee"
RESUME = "5bcbb789-0248-4777-b099-c9c2a86b80ea"
REPAIR_NAME = "releases/" + REPAIR
REPAIRED_TARGETS = tuple(replace(x, request_id=REPAIR) for x in TARGETS)


def plan(state="repairable", reason_code=None):
    return pb.ReconcilePlan(
        name="reconcilePlan",
        state=state,
        base_release=NAME,
        base_etag="revision-3",
        fingerprint="f" * 64 if state in {"clean", "repairable"} else None,
        observed_at=TIME,
        reason_code=reason_code,
        changes=(
            pb.ReconcileChange(
                resource_key="platform-observer",
                action="update",
                reason_code="RUNTIME_FIELDS_CHANGED",
            ),
        )
        if state == "repairable"
        else (),
    )


def repaired(phase="ready", error_code=None):
    return replace(
        release(),
        name=REPAIR_NAME,
        request_id=REPAIR,
        targets=REPAIRED_TARGETS,
        source_release=NAME,
        phase=phase,
        error_code=error_code,
    )


def repaired_node():
    value = node()
    workloads = tuple(
        replace(
            x,
            release=replace(
                x.release,
                actual=replace(x.release.actual, request_id=REPAIR),
                desired=replace(x.release.desired, request_id=REPAIR),
            ),
        )
        for x in value.workloads
    )
    return replace(
        value,
        workloads=workloads,
        current_release=replace(
            value.current_release, name=REPAIR_NAME, request_id=REPAIR
        ),
    )


class ActionRepair(unittest.TestCase):
    def client(self, handler, clock=None):
        return support.ActionDeployment.client(self, handler, clock=clock)

    def test_plan_and_clean_repair_never_write_evidence_or_post(self):
        for operation in ("plan", "repair"):
            requests = []

            def handler(request, requests=requests):
                requests.append(request)
                return httpx.Response(200, json=to_wire(plan("clean")))

            with tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "receipt.json"
                result = execute(
                    self.client(handler), operation, REPAIR, evidence_file=path
                )
                self.assertFalse(path.exists())
            self.assertEqual(result["state"], "clean")
            self.assertEqual([x.method for x in requests], ["GET"])

    def test_repair_freezes_source_and_writes_only_verified_public_evidence(self):
        requests = []

        def handler(request):
            requests.append(request)
            if request.url.path.endswith("reconcilePlan"):
                return httpx.Response(200, json=to_wire(plan()))
            if request.url.path == "/api/v1/" + NAME:
                return httpx.Response(200, json=to_wire(release()))
            if request.method == "POST":
                self.assertEqual(request.url.path, "/api/v1/" + NAME + ":reconcile")
                self.assertEqual(
                    json.loads(request.content),
                    {
                        "etag": "revision-3",
                        "fingerprint": "f" * 64,
                        "request_id": REPAIR,
                    },
                )
                return httpx.Response(200, json=to_wire(repaired("accepted")))
            if request.url.path.endswith("nodeStatus"):
                return httpx.Response(200, json=to_wire(repaired_node()))
            return httpx.Response(200, json=to_wire(repaired()))

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "receipt.json"
            result = execute(self.client(handler), "repair", REPAIR, evidence_file=path)
            wire = json.loads(path.read_text())
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            self.assertEqual(
                set(wire), {"source_sha", "release", "etag", "phase", "targets"}
            )
            self.assertEqual(wire["release"], REPAIR_NAME)
            self.assertEqual(wire["source_sha"], TARGETS[0].source_sha)
            self.assertTrue(
                all(
                    set(x)
                    == {"workload_key", "source_sha", "image_digest", "request_id"}
                    for x in wire["targets"]
                )
            )
        self.assertEqual(result["source_release"], NAME)
        self.assertEqual(len([x for x in requests if x.method == "POST"]), 1)

    def test_explicit_resume_keeps_the_held_repair_targets_and_operation_identity(self):
        requests = []

        def handler(request):
            requests.append(request)
            if request.method == "POST":
                self.assertEqual(request.url.path, "/api/v1/" + REPAIR_NAME + ":resume")
                self.assertEqual(
                    json.loads(request.content),
                    {"etag": "revision-3", "request_id": RESUME},
                )
                return httpx.Response(200, json=to_wire(repaired("accepted")))
            if request.url.path.endswith("nodeStatus"):
                return httpx.Response(200, json=to_wire(repaired_node()))
            return httpx.Response(
                200,
                json=to_wire(repaired("held") if len(requests) == 1 else repaired()),
            )

        result = execute(
            self.client(handler), "resume", RESUME, release_name=REPAIR_NAME
        )
        self.assertEqual(
            (result["release"], result["source_release"]), (REPAIR_NAME, NAME)
        )
        self.assertFalse(any(x.url.path.endswith(":reconcile") for x in requests))

    def test_held_repair_and_manual_plan_never_resume_automatically(self):
        for state in ("manual", "held"):
            posts = []

            def handler(request, posts=posts, state=state):
                if request.url.path.endswith("reconcilePlan"):
                    value = (
                        plan("manual_required", "BUSINESS_PAUSED")
                        if state == "manual"
                        else plan()
                    )
                elif request.url.path == "/api/v1/" + NAME:
                    value = release()
                else:
                    posts.append(request.url.path)
                    value = repaired("held", "RELEASE_HELD")
                return httpx.Response(200, json=to_wire(value))

            with self.assertRaises(ReleaseFailure):
                execute(self.client(handler), "repair", REPAIR)
            self.assertFalse(any(x.endswith(":resume") for x in posts))

    def test_wrong_actual_digest_cannot_write_a_ready_receipt(self):
        clock = Clock()

        def handler(request):
            if request.url.path.endswith("reconcilePlan"):
                value = plan()
            elif request.url.path == "/api/v1/" + NAME:
                value = release()
            elif request.url.path.endswith("nodeStatus"):
                value = repaired_node()
                workload = value.workloads[0]
                value = replace(
                    value,
                    workloads=(
                        replace(
                            workload,
                            release=replace(
                                workload.release,
                                actual=replace(
                                    workload.release.actual,
                                    image_digest="sha256:" + "d" * 64,
                                ),
                            ),
                        ),
                        *value.workloads[1:],
                    ),
                )
            else:
                value = repaired()
            return httpx.Response(200, json=to_wire(value))

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "receipt.json"
            with self.assertRaisesRegex(ReleaseFailure, "RELEASE_OBSERVATION_TIMEOUT"):
                execute(
                    self.client(handler, clock),
                    "repair",
                    REPAIR,
                    timeout=30,
                    evidence_file=path,
                )
            self.assertFalse(path.exists())

    def test_receipt_refuses_overwrite_and_unready_operation(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "receipt.json"
            path.write_bytes(b"original")
            with self.assertRaisesRegex(
                ReleaseFailure, "RELEASE_EVIDENCE_WRITE_FAILED"
            ):
                write_evidence(path, repaired())
            self.assertEqual(path.read_bytes(), b"original")
            with self.assertRaisesRegex(ReleaseFailure, "RELEASE_EVIDENCE_INVALID"):
                write_evidence(Path(directory) / "new.json", repaired("held"))

    def test_duplicate_old_release_accepts_verified_ready_repair_without_draining(self):
        requests = []

        def handler(request):
            requests.append(request)
            if request.method == "POST":
                self.assertFalse(request.url.path.endswith(":resume"))
                self.assertFalse(request.url.path.endswith(":reconcile"))
                return httpx.Response(200, json=to_wire(release()))
            if request.url.path.endswith("nodeStatus"):
                return httpx.Response(200, json=to_wire(repaired_node()))
            return httpx.Response(200, json=to_wire(repaired()))

        result = self.client(handler).execute(
            TARGETS[0].source_sha, {x.workload_key: x.image_digest for x in TARGETS}
        )
        self.assertEqual(result.name, REPAIR_NAME)
        self.assertEqual(len(requests), 3)

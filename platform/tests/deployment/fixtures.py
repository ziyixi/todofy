"""Shared synthetic deployment fixtures without cluster or network access."""

import tempfile
from copy import deepcopy
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import yaml
from personal_cloud.deployment.admission import AdmissionBusy
from personal_cloud.deployment.controller import Controller
from personal_cloud.deployment.kubernetes import DependencyUnavailable
from personal_cloud.deployment.resources import Renderer
from personal_cloud.deployment.store import Store
from personal_cloud.status_daemon.config import Configuration, Workload
from ziyixi_proto.platform.runtime.v1 import runtime_pb as pb
from ziyixi_proto.platform.runtime.v1 import runtime_service_pb as api

AT = datetime(2026, 10, 2, 12, tzinfo=UTC)
STAMP = "2026-10-02T12:00:00Z"
SHA = "a" * 40
REQUEST = "89f6feb1-4287-4f22-a374-76b9e9c2b1c0"
IDENTITY = "afc6aa50-5a15-461d-b93c-dbd9115ccacb"
CONTINUE = "f219c057-fc33-4d8b-8819-d7a1f776b35f"
CONFIG = Configuration(
    "vps",
    "personal-cloud",
    (
        Workload(
            "newsletter", "newsletter", "newsletter", "newsletter-release", "newsletter"
        ),
        Workload(
            "platform-runtime",
            "platform-runtime",
            "platform-runtime",
            "platform-release",
            "personal-cloud",
        ),
    ),
    "example/project",
)
TARGETS = (
    pb.ReleaseTarget(
        workload_key="newsletter",
        source_sha=SHA,
        image_digest="sha256:" + "b" * 64,
        request_id=REQUEST,
    ),
    pb.ReleaseTarget(
        workload_key="platform-runtime",
        source_sha=SHA,
        image_digest="sha256:" + "c" * 64,
        request_id=REQUEST,
    ),
)


def asset():
    directory = Path(__file__).resolve().parents[2] / "k3s/newsletter"
    names = yaml.safe_load((directory / "kustomization.yaml").read_text())["resources"]
    return {
        "apiVersion": "v1",
        "kind": "List",
        "items": [
            item
            for name in names
            for item in yaml.safe_load_all((directory / name).read_text())
        ],
    }


def counts(names):
    return {name: 0 for name in names}


def drain(state="active", key=None):
    return {
        "version": 1,
        "state": state,
        "request_key": key,
        "busy": False,
        "inflight": counts(
            (
                "activities",
                "editions",
                "packets",
                "workflow_attempts",
                "notion_entities",
                "notion_versions",
                "delivery",
            )
        ),
        "unknown": counts(
            (
                "interrupted_activities",
                "packets",
                "workflow_attempts",
                "notion_entities",
                "notion_versions",
                "delivery",
            )
        ),
        "queued": counts(("editions", "collection_runs")),
    }


class Fixture:
    def initialize(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.at = AT
        self.events = []
        self.store = Store(Path(self.directory.name) / "ledger.sqlite3")
        self.resource_state = {}
        owner = self

        class Kube:
            fail = False
            replace_process = False

            def patch(inner, kind, name, change):
                if inner.fail:
                    raise DependencyUnavailable()
                owner.events.append(("patch", kind, name, deepcopy(change)))
                owner.resource_state.setdefault((kind, name), {}).update(
                    deepcopy(change)
                )

            def apply(inner, item):
                if inner.fail:
                    raise DependencyUnavailable()
                name, kind = item["metadata"]["name"], item["kind"]
                owner.events.append(("apply", kind, name, deepcopy(item)))
                owner.resource_state[(kind, name)] = deepcopy(item)
                if inner.replace_process and (kind, name) == (
                    "Deployment",
                    "platform-runtime",
                ):
                    raise SystemExit("synthetic-recreate")

            def close(inner):
                pass

        class Admission:
            state, unknown, busy = "active", False, False

            def call(inner, action, key):
                owner.events.append(("admission", action))
                if action == "begin":
                    inner.state = "draining"
                if action == "freeze":
                    if inner.busy:
                        raise AdmissionBusy("RELEASE_HELD")
                    inner.state = "frozen"
                if action == "resume":
                    inner.state = "active"
                    value = drain("resumed", key)
                else:
                    value = drain(inner.state, key if inner.state != "active" else None)
                value["unknown"]["packets"] = int(inner.unknown)
                value["inflight"]["activities"] = int(inner.busy)
                value["busy"] = inner.busy
                return value

            def close(inner):
                pass

        self.kube, self.admission = Kube(), Admission()
        self.generation = 3
        self.bad_digest = False
        self.health = "healthy"
        self.reads = SimpleNamespace(
            cache=SimpleNamespace(invalidate=Mock()), snapshot=self.snapshot
        )
        self.controller = self.make_controller()

    def make_controller(self, **options):
        return Controller(
            CONFIG,
            self.store,
            self.kube,
            self.admission,
            Renderer(CONFIG, asset=options.pop("asset", asset())),
            self.reads,
            source_sha=options.pop("source_sha", lambda: SHA),
            process_request_id=options.pop("process_request_id", REQUEST),
            clock=lambda: self.at,
            **options,
        )

    def snapshot(self):
        values = []
        for target in TARGETS:
            newsletter = target.workload_key == "newsletter"
            actual = pb.ReleaseTarget(
                workload_key=target.workload_key,
                source_sha=SHA,
                image_digest="sha256:" + "f" * 64
                if self.bad_digest
                else target.image_digest,
                request_id=REQUEST,
                generation=self.generation,
            )
            active = self.admission.state == "active"
            values.append(
                pb.WorkloadStatus(
                    name="workloads/" + target.workload_key,
                    workload_key=target.workload_key,
                    process_state="running",
                    admission_state=("accepting" if active else "frozen")
                    if newsletter
                    else "unsupported",
                    health_state=self.health if newsletter else "unsupported",
                    unknown_count=int(self.admission.unknown) if newsletter else None,
                    observed_at=self.at.isoformat().replace("+00:00", "Z"),
                    release=pb.ReleaseStatus(
                        state="ready" if active else "pending",
                        desired=target,
                        actual=actual,
                        observed_generation=self.generation,
                        observed_at=self.at.isoformat().replace("+00:00", "Z"),
                    ),
                )
            )
        return pb.NodeStatus(
            name="nodeStatus",
            node_key="vps",
            state="degraded" if self.health == "degraded" else "ready",
            observed_at=self.at.isoformat().replace("+00:00", "Z"),
            workloads=tuple(values),
        )

    def create(self, **changes):
        request = api.CreateReleaseRequest(
            release_id=IDENTITY, request_id=REQUEST, release=pb.Release(targets=TARGETS)
        )
        return self.controller.create(
            request
            if not changes
            else api.CreateReleaseRequest(**{**request.__dict__, **changes})
        )

    def until(self, checkpoint):
        for _ in range(25):
            if self.store.get(IDENTITY).checkpoint == checkpoint:
                return
            self.assertTrue(self.controller.step(), self.store.get(IDENTITY))
        self.fail("Checkpoint did not converge")

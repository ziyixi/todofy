"""Durable, single-operation reconciliation; restart resumes checkpoints, never held work."""

import threading
from datetime import datetime, timezone

from ziyixi_proto.common.errors.v1.errors_pb import CommonReason
from ziyixi_proto.platform.runtime.v1 import runtime_pb as pb
from ziyixi_proto.platform.runtime.v1.errors_pb import ErrorReason
from ziyixi_proto.rpc_status import RpcError
from ziyixi_proto.wire_json import from_wire, to_wire

from ..status_daemon.adapters import baked_source_sha
from .admission import AdmissionBusy, AdmissionConflict, AdmissionUnavailable
from .kubernetes import DependencyUnavailable
from .store import Record, Store

WAIT_SECONDS = 600


def _error(code, reason, message):
    return RpcError(code, reason.name, message, domain="platform.ziyixi.science")


class Controller:
    def __init__(
        self,
        config,
        store: Store,
        kube,
        admission,
        renderer,
        reads,
        *,
        source_sha=baked_source_sha,
        process_request_id="",
        clock=lambda: datetime.now(timezone.utc),
    ):
        self.config, self.store, self.kube, self.admission, self.renderer = (
            config,
            store,
            kube,
            admission,
            renderer,
        )
        self.reads, self.source_sha = reads, source_sha
        self.process_request_id, self.clock = process_request_id, clock
        self.workloads = renderer.workloads
        self.keys = {item.key for item in self.workloads.values()}
        self.stop = threading.Event()
        self.wake = threading.Event()
        self.thread = None
        self.worker_error = None
        self.step_lock = threading.Lock()
        self.installed = set()

    def create(self, request):
        targets = request.release.targets
        if (
            len(targets) != 2
            or {target.workload_key for target in targets} != self.keys
            or len({target.source_sha for target in targets}) != 1
            or any(
                target.request_id != request.request_id or target.generation is not None
                for target in targets
            )
        ):
            raise _error(
                "INVALID_ARGUMENT",
                CommonReason.BAD_REQUEST,
                "The release must select both configured workloads with one source and creation identity.",
            )
        body = {
            "request_id": request.request_id,
            "targets": [
                to_wire(target)
                for target in sorted(targets, key=lambda target: target.workload_key)
            ],
        }
        record = self.store.create(request.release_id, body)
        self.wake.set()
        return self.release(record)

    def get(self, request):
        return self.release(self.store.get(request.name.split("/", 1)[1]))

    def resume(self, request):
        record = self.store.resume(
            request.name.split("/", 1)[1], request.etag, request.request_id
        )
        self.wake.set()
        return self.release(record)

    def summary(self):
        record = self.store.latest()
        if record is None:
            return None
        result = pb.ReleaseSummary(
            name="releases/" + record.identity,
            request_id=record.body["request_id"],
            phase=record.phase,
            etag=record.etag,
            update_time=record.updated,
            error_code=record.error_code or None,
        )
        return from_wire(pb.ReleaseSummary, to_wire(result), strict=True).message

    @staticmethod
    def release(record: Record):
        result = pb.Release(
            name="releases/" + record.identity,
            request_id=record.body["request_id"],
            targets=tuple(
                from_wire(pb.ReleaseTarget, value, strict=True).message
                for value in record.body["targets"]
            ),
            phase=record.phase,
            etag=record.etag,
            create_time=record.created,
            update_time=record.updated,
            observed_workloads=tuple(
                from_wire(pb.WorkloadStatus, value, strict=True).message
                for value in record.observed
            ),
            error_code=record.error_code or None,
        )
        return from_wire(pb.Release, to_wire(result), strict=True).message

    def start(self):
        if self.thread is not None:
            raise RuntimeError("already_started")
        self.thread = threading.Thread(
            target=self._run, name="release-controller", daemon=True
        )
        self.thread.start()

    def close(self):
        self.stop.set()
        self.wake.set()
        if self.thread is not None:
            self.thread.join(timeout=30)
        self.admission.close()
        self.kube.close()

    def _run(self):
        while not self.stop.is_set():
            try:
                progressed = self.step()
                self.worker_error = None
                if progressed:
                    continue
            except Exception:  # noqa: BLE001 — a failed ledger is not permission for effects or raw tracebacks.
                self.worker_error = CommonReason.INTERNAL.name
            self.wake.wait(2)
            self.wake.clear()

    def _next(self, record, phase, checkpoint, *, observed=()):
        self.store.checkpoint(record.identity, phase, checkpoint, observed=observed)

    def _hold(self, record, reason, *, failed=False, observed=()):
        if record.checkpoint in {"resume", "unsuspend", "finish"}:
            # A lost resume acknowledgement may have reopened admission. Do not invent a closed gate
            # or force a different gate over unknown business work. Suspend new cron triggers if possible.
            try:
                self.kube.patch(
                    "CronJob", "newsletter-daily", {"spec": {"suspend": True}}
                )
            except DependencyUnavailable:
                pass
            if not observed:
                try:
                    observed = self._observations(self._snapshot())
                except Exception:  # noqa: BLE001 — a failed observation stays absent, never becomes "frozen".
                    observed = ()
        self.store.checkpoint(
            record.identity,
            "failed" if failed else "held",
            record.checkpoint,
            error_code=reason.name,
            observed=observed,
        )

    def _timed_out(self, record):
        at = datetime.fromisoformat(record.updated.replace("Z", "+00:00"))
        return (self.clock() - at).total_seconds() > WAIT_SECONDS

    def _snapshot(self):
        self.reads.cache.invalidate()
        return self.reads.snapshot()

    def _observations(self, snapshot):
        return tuple(
            to_wire(value)
            for value in snapshot.workloads
            if value.workload_key in self.keys
        )

    def _verified(self, snapshot, targets, *, resumed=False):
        observed = {
            value.workload_key: value
            for value in snapshot.workloads
            if value.workload_key in self.keys
        }
        if set(observed) != self.keys:
            return False
        for wanted in targets:
            value = observed[wanted.workload_key]
            actual = value.release.actual
            desired = value.release.desired
            try:
                age = (
                    self.clock()
                    - datetime.fromisoformat(value.observed_at.replace("Z", "+00:00"))
                ).total_seconds()
            except ValueError:
                return False
            if (
                not 0 <= age <= 60
                or actual is None
                or desired is None
                or actual.generation is None
                or value.release.observed_generation != actual.generation
                or (actual.source_sha, actual.image_digest, actual.request_id)
                != (wanted.source_sha, wanted.image_digest, wanted.request_id)
                or (desired.source_sha, desired.image_digest, desired.request_id)
                != (wanted.source_sha, wanted.image_digest, wanted.request_id)
                or (
                    wanted.generation is not None
                    and actual.generation != wanted.generation
                )
                or value.process_state != "running"
                or value.health_state not in {"healthy", "unsupported", "degraded"}
            ):
                return False
            newsletter = wanted.workload_key == self.workloads["newsletter"].key
            if value.health_state == "degraded" and (
                not newsletter
                or value.unknown_count is None
                or value.unknown_count <= 0
            ):
                return False
            if newsletter:
                if value.admission_state != ("accepting" if resumed else "frozen") or (
                    not resumed and value.unknown_count is None
                ):
                    return False
            elif value.admission_state != "unsupported":
                return False
            if resumed and value.release.state != "ready":
                return False
        return True

    def step(self):
        with self.step_lock:
            record = self.store.active()
            if record is None or self.stop.is_set():
                return False
            try:
                return self._step(record)
            except AdmissionConflict:
                self._hold(record, ErrorReason.RELEASE_HELD)
            except (DependencyUnavailable, AdmissionUnavailable):
                self._hold(record, CommonReason.UNAVAILABLE)
            except AdmissionBusy:
                if self._timed_out(record):
                    self._hold(record, ErrorReason.RELEASE_HELD)
            except RpcError as error:
                self._hold(
                    record,
                    CommonReason.UNAVAILABLE
                    if error.code == "UNAVAILABLE"
                    else ErrorReason.RELEASE_HELD,
                )
            except Exception:  # noqa: BLE001 — persist a safe failure; do not log private provider exceptions.
                self._hold(record, CommonReason.INTERNAL, failed=True)
            return False

    def _step(self, record):
        targets = self.release(record).targets
        newsletter = self.workloads["newsletter"]
        platform = self.workloads["personal-cloud"]
        platform_target = next(
            target for target in targets if target.workload_key == platform.key
        )
        resources = self.renderer.render(targets, record.identity)
        gate_key = "release-" + targets[0].source_sha
        checkpoint = record.checkpoint
        if checkpoint == "suspend":
            self.kube.patch("CronJob", "newsletter-daily", {"spec": {"suspend": True}})
            self._next(record, "draining", "begin")
        elif checkpoint == "begin":
            self.admission.call("begin", gate_key)
            self._next(record, "draining", "drain")
        elif checkpoint == "drain":
            value = self.admission.call("status", gate_key)
            if value["request_key"] != gate_key or value["state"] not in {
                "draining",
                "frozen",
            }:
                self._hold(record, ErrorReason.RELEASE_HELD)
                return False
            # Historical unknown outcomes stay visible; tracked activity still blocks freezing.
            if value["busy"]:
                if self._timed_out(record):
                    self._hold(record, ErrorReason.RELEASE_HELD)
                return False
            self._next(record, "frozen", "freeze")
        elif checkpoint == "freeze":
            self.admission.call("freeze", gate_key)
            # Durable BEFORE replacing this process. The new image, not the old process, supplies new manifests.
            self._next(record, "applying", "install_self")
        elif checkpoint == "install_self":
            if (
                self.source_sha() == platform_target.source_sha
                and self.process_request_id == platform_target.request_id
            ):
                self._next(record, "applying", "apply")
            elif record.identity not in self.installed:
                self.kube.apply(
                    next(
                        item
                        for item in resources
                        if item["kind"] == "Deployment"
                        and item["metadata"]["name"] == platform.deployment
                    )
                )
                self.installed.add(record.identity)
                return False
            elif self._timed_out(record):
                self._hold(record, ErrorReason.RELEASE_HELD)
                return False
            else:
                return False
        elif checkpoint == "apply":
            for item in resources:
                if self.stop.is_set():
                    return False
                if (
                    item["kind"] == "Deployment"
                    and item["metadata"]["name"] == platform.deployment
                ):
                    continue
                self.kube.apply(item)
            # A second recreation may be required when the new baked daemon pod template changed.
            self._next(record, "applying", "self_apply")
        elif checkpoint == "self_apply":
            self.kube.apply(
                next(
                    item
                    for item in resources
                    if item["kind"] == "Deployment"
                    and item["metadata"]["name"] == platform.deployment
                )
            )
            self._next(record, "verifying", "verify")
        elif checkpoint == "verify":
            snapshot = self._snapshot()
            if not self._verified(snapshot, targets):
                if self._timed_out(record):
                    self._hold(
                        record,
                        ErrorReason.RELEASE_HELD,
                        observed=self._observations(snapshot),
                    )
                return False
            self._next(
                record, "verifying", "activate", observed=self._observations(snapshot)
            )
        elif checkpoint == "activate":
            for item in (newsletter, platform):
                self.kube.patch(
                    "ConfigMap",
                    item.release_configmap,
                    {"data": {"phase": "activated"}},
                )
            self._next(record, "verifying", "resume")
        elif checkpoint == "resume":
            self.admission.call("resume", gate_key)
            self._next(record, "verifying", "unsuspend")
        elif checkpoint == "unsuspend":
            self.kube.patch("CronJob", "newsletter-daily", {"spec": {"suspend": False}})
            self._next(record, "verifying", "finish")
        elif checkpoint == "finish":
            snapshot = self._snapshot()
            if not self._verified(snapshot, targets, resumed=True):
                if self._timed_out(record):
                    self._hold(
                        record,
                        ErrorReason.RELEASE_HELD,
                        observed=self._observations(snapshot),
                    )
                return False
            self._next(record, "ready", "done", observed=self._observations(snapshot))
        else:
            raise ValueError("invalid_release_checkpoint")
        return True

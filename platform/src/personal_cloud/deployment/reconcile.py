"""Bounded server-side apply comparison of this image's fixed declared runtime resources."""

import hashlib
import json
import time
from datetime import datetime, timezone

from ziyixi_proto.platform.runtime.v1 import runtime_pb as pb
from ziyixi_proto.wire_json import from_wire, to_wire

from .admission import AdmissionUnavailable
from .kubernetes import DependencyUnavailable

PLAN_SECONDS = 25
RESOURCE_KEYS = {
    ("Deployment", "newsletter"): "newsletter",
    ("Deployment", "newsletter-config-sync"): "newsletter-config-sync",
    ("Deployment", "platform-runtime"): "platform-runtime",
    ("CronJob", "newsletter-daily"): "newsletter-daily",
    ("CronJob", "platform-observer"): "platform-observer",
    ("Service", "newsletter"): "newsletter-service",
    ("Service", "platform-runtime"): "platform-service",
    ("ConfigMap", "newsletter-release"): "newsletter-release",
    ("ConfigMap", "platform-release"): "platform-release",
    ("ConfigMap", "platform-runtime-config"): "platform-runtime-config",
    ("CronJob", "mailsort-runner"): "mailsort-runner",
    ("ConfigMap", "mailsort-runner-release"): "mailsort-runner-release",
    ("ConfigMap", "mailsort-runner-config"): "mailsort-runner-config",
}


def declared_view(value, declaration):
    """Compare declared fields only, while preserving meaningful missing/list differences."""
    if isinstance(declaration, dict):
        if not isinstance(value, dict):
            return None
        return {
            key: declared_view(value.get(key), child)
            for key, child in declaration.items()
        }
    if isinstance(declaration, list):
        if not isinstance(value, list):
            return None
        named = declaration and all(
            isinstance(item, dict) and "name" in item for item in declaration
        )
        if named:
            actual = {
                item.get("name"): item for item in value if isinstance(item, dict)
            }
            return [
                declared_view(actual.get(item["name"]), item) for item in declaration
            ]
        return (
            [declared_view(item, wanted) for item, wanted in zip(value, declaration)]
            if len(value) == len(declaration)
            else value
        )
    return value


class Planner:
    def __init__(
        self,
        store,
        renderer,
        kube,
        admission,
        *,
        clock=lambda: datetime.now(timezone.utc),
        monotonic=time.monotonic,
        source_sha=None,
    ):
        self.store, self.renderer, self.kube, self.admission = (
            store,
            renderer,
            kube,
            admission,
        )
        self.clock, self.monotonic = clock, monotonic
        self.source_sha = source_sha

    def _remaining(self, deadline):
        remaining = deadline - self.monotonic()
        if remaining <= 0:
            raise DependencyUnavailable()
        return min(5, remaining)

    def _plan(
        self,
        record,
        *,
        state,
        changes=(),
        template_changes=(),
        reason=None,
        fingerprint=None,
    ):
        value = pb.ReconcilePlan(
            name="reconcilePlan",
            state=state,
            observed_at=self.clock()
            .isoformat(timespec="seconds")
            .replace("+00:00", "Z"),
            base_release="releases/" + record.identity if record else None,
            base_etag=record.etag if record else None,
            changes=tuple(changes),
            template_changes=tuple(template_changes),
            reason_code=reason,
            fingerprint=fingerprint,
        )
        return from_wire(pb.ReconcilePlan, to_wire(value), strict=True).message

    def collect(self):
        record = self.store.latest()
        if record is None:
            return self._plan(None, state="unavailable", reason="NO_ACCEPTED_RELEASE")
        if record.phase != "ready":
            return self._plan(
                record, state="manual_required", reason="RELEASE_IN_PROGRESS"
            )
        changes, template_changes, live = [], [], []
        deadline = self.monotonic() + PLAN_SECONDS
        try:
            targets = tuple(
                from_wire(pb.ReleaseTarget, value, strict=True).message
                for value in record.body["targets"]
            )
            platform = self.renderer.workloads["personal-cloud"].key
            if self.source_sha is not None and any(
                target.workload_key == platform
                and target.source_sha != self.source_sha()
                for target in targets
            ):
                return self._plan(
                    record, state="manual_required", reason="RUNTIME_SOURCE_MISMATCH"
                )
            resources = self.renderer.render(
                targets, record.identity, gate_key=record.gate_key or None
            )
            daily = None
            aliases = {}
            for adapter, fixed in (
                ("newsletter", "newsletter"),
                ("personal-cloud", "platform-runtime"),
                ("mailsort-runner", "mailsort-runner"),
            ):
                workload = self.renderer.workloads.get(adapter)
                if workload is not None:
                    aliases[("Deployment", workload.deployment)] = fixed
                    aliases[("ConfigMap", workload.release_configmap)] = (
                        "platform-release"
                        if adapter == "personal-cloud"
                        else fixed + "-release"
                    )
            for desired in resources:
                kind, name = desired["kind"], desired["metadata"]["name"]
                key = RESOURCE_KEYS[(kind, aliases.get((kind, name), name))]
                change, fields, actual = self._compare(desired, key, deadline)
                live.append((key, fields))
                if change is not None:
                    (
                        template_changes
                        if key.startswith("mailsort-runner")
                        else changes
                    ).append(change)
                if key == "newsletter-daily":
                    daily = actual
            admission = self.admission.call(
                "status", "", timeout=self._remaining(deadline)
            )
            paused = admission["state"] != "active" or (
                daily is not None and daily.get("spec", {}).get("suspend") is True
            )
            if paused:
                return self._plan(
                    record,
                    state="manual_required",
                    changes=changes,
                    template_changes=template_changes,
                    reason="BUSINESS_PAUSED",
                )
            if any(
                change.action == "conflict" for change in (*changes, *template_changes)
            ):
                return self._plan(
                    record,
                    state="manual_required",
                    changes=changes,
                    template_changes=template_changes,
                    reason="RUNTIME_OWNERSHIP_CONFLICT",
                )
            encoded = json.dumps(
                {
                    "release": record.identity,
                    "etag": record.etag,
                    "targets": record.body["targets"],
                    "live": live,
                    "admission": admission["state"],
                    "suspended": False,
                },
                sort_keys=True,
                separators=(",", ":"),
            ).encode()
            return self._plan(
                record,
                state="repairable" if changes or template_changes else "clean",
                changes=changes,
                template_changes=template_changes,
                fingerprint=hashlib.sha256(encoded).hexdigest(),
            )
        except (DependencyUnavailable, AdmissionUnavailable):
            return self._plan(
                record,
                state="unavailable",
                changes=changes,
                template_changes=template_changes,
                reason="RUNTIME_COMPARISON_UNAVAILABLE",
            )

    def _compare(self, desired, key, deadline):
        change_type = (
            pb.RunnerTemplateChange
            if key.startswith("mailsort-runner")
            else pb.ReconcileChange
        )
        try:
            actual = self.kube.get(
                desired["kind"],
                desired["metadata"]["name"],
                timeout=self._remaining(deadline),
            )
        except DependencyUnavailable as error:
            if not error.missing:
                raise
            actual = None
        try:
            applied = self.kube.dry_run(desired, timeout=self._remaining(deadline))
        except DependencyUnavailable as error:
            if not error.conflict:
                raise
            return (
                change_type(
                    resource_key=key,
                    action="conflict",
                    reason_code="RUNTIME_OWNERSHIP_CONFLICT",
                ),
                declared_view(actual, desired),
                actual,
            )
        live_fields, wanted_fields = (
            declared_view(actual, desired),
            declared_view(applied, desired),
        )
        if actual is None:
            change = change_type(
                resource_key=key,
                action="create",
                reason_code="RUNTIME_RESOURCE_MISSING",
            )
        elif live_fields != wanted_fields:
            change = change_type(
                resource_key=key, action="update", reason_code="RUNTIME_FIELDS_CHANGED"
            )
        else:
            change = None
        return change, live_fields, actual

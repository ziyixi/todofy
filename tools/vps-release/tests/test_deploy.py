"""Synthetic daemon HTTP only: durable retry/resume identity and independent actual-image evidence."""

import asyncio
import json
import sys
import tempfile
import unittest
from dataclasses import replace
from datetime import datetime
from pathlib import Path

import httpx
from ziyixi_proto.platform.runtime.v1 import runtime_pb as pb
from ziyixi_proto.platform.runtime.v1 import runtime_service_pb as service
from ziyixi_proto.rpc_status import RpcError, status_body
from ziyixi_proto.wire_json import to_wire

TOOL = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TOOL))
from deploy import BINDINGS, Deployment, verified_snapshot
from release_identity import release_id, resume_id, verified_images
from transport import ReleaseFailure, TransientFailure, Transport, request_parts

SHA = "a" * 40
IDENTITY = release_id(SHA)
NAME = "releases/" + IDENTITY
TIME = "2026-10-03T00:00:00Z"
NOW = datetime.fromisoformat(TIME)
DIGESTS = {"newsletter": "sha256:" + "b" * 64, "platform-runtime": "sha256:" + "c" * 64}
TARGETS = tuple(
    pb.ReleaseTarget(
        workload_key=key, source_sha=SHA, image_digest=digest, request_id=IDENTITY
    )
    for key, digest in sorted(DIGESTS.items())
)
CREDENTIALS = {
    "PLATFORM_ACCESS_CLIENT_ID": "synthetic.access",
    "PLATFORM_ACCESS_CLIENT_SECRET": "a" * 64,
    "PLATFORM_DEPLOY_TOKEN": "b" * 64,
}


def release(phase="ready", *, error_code=None):
    return pb.Release(
        name=NAME,
        request_id=IDENTITY,
        targets=TARGETS,
        phase=phase,
        etag="revision-3",
        create_time=TIME,
        update_time=TIME,
        error_code=error_code,
    )


def node():
    workloads = []
    for target in TARGETS:
        evidence = replace(target, generation=3)
        workloads.append(
            pb.WorkloadStatus(
                name="workloads/" + target.workload_key,
                workload_key=target.workload_key,
                process_state="running",
                admission_state="accepting",
                health_state="healthy",
                observed_at=TIME,
                release=pb.ReleaseStatus(
                    state="ready",
                    desired=evidence,
                    actual=evidence,
                    observed_at=TIME,
                    observed_generation=3,
                ),
            )
        )
    return pb.NodeStatus(
        name="nodeStatus",
        node_key="vps",
        state="ready",
        observed_at=TIME,
        workloads=tuple(workloads),
        current_release=pb.ReleaseSummary(
            name=NAME,
            request_id=IDENTITY,
            phase="ready",
            etag="revision-3",
            update_time=TIME,
        ),
    )


class Clock:
    def __init__(self):
        self.time = 0

    def monotonic(self):
        return self.time

    def sleep(self, seconds):
        self.time += seconds


class ActionDeployment(unittest.TestCase):
    def client(self, handler, *, clock=None):
        transport = Transport(
            "platform-runtime.example.test",
            CREDENTIALS,
            transport=httpx.MockTransport(handler),
        )
        self.addCleanup(transport.close)
        clock = clock or Clock()
        return Deployment(
            transport, monotonic=clock.monotonic, sleep=clock.sleep, now=lambda: NOW
        )

    def test_push_uses_generated_body_and_requires_real_runtime_observation(self):
        requests = []

        def handler(request):
            requests.append(request)
            self.assertEqual(request.url.scheme, "https")
            self.assertEqual(request.url.host, "platform-runtime.example.test")
            self.assertEqual(
                request.headers["authorization"],
                "Bearer " + CREDENTIALS["PLATFORM_DEPLOY_TOKEN"],
            )
            if request.method == "POST":
                self.assertEqual(
                    dict(request.url.params),
                    {"release_id": IDENTITY, "request_id": IDENTITY},
                )
                self.assertEqual(
                    json.loads(request.content),
                    {"targets": [to_wire(target) for target in TARGETS]},
                )
                return httpx.Response(200, json=to_wire(release("accepted")))
            if request.url.path.endswith("nodeStatus"):
                return httpx.Response(200, json=to_wire(node()))
            return httpx.Response(200, json=to_wire(release()))

        self.assertEqual(self.client(handler).execute(SHA, DIGESTS).phase, "ready")
        self.assertEqual(
            [request.method for request in requests], ["POST", "GET", "GET"]
        )

    def test_response_loss_retries_the_identical_frozen_request_and_never_resumes_held(
        self,
    ):
        requests = []

        def handler(request):
            requests.append(request)
            if len(requests) == 1:
                raise httpx.ReadTimeout("synthetic response lost", request=request)
            return httpx.Response(
                200, json=to_wire(release("held", error_code="DRAIN_UNKNOWN"))
            )

        with self.assertRaisesRegex(ReleaseFailure, "DRAIN_UNKNOWN"):
            self.client(handler).execute(SHA, DIGESTS)
        self.assertEqual(len(requests), 2)
        self.assertEqual(requests[0].url, requests[1].url)
        self.assertEqual(requests[0].content, requests[1].content)
        self.assertTrue(
            all(not request.url.path.endswith(":resume") for request in requests)
        )

    def test_explicit_resume_uses_current_etag_stable_attempt_and_the_same_release(
        self,
    ):
        requests = []

        def handler(request):
            requests.append(request)
            if len(requests) == 1:
                return httpx.Response(200, json=to_wire(release("held")))
            if request.method == "POST":
                self.assertEqual(request.url.path, "/api/v1/" + NAME + ":resume")
                self.assertEqual(
                    json.loads(request.content),
                    {"request_id": resume_id(NAME, "revision-3"), "etag": "revision-3"},
                )
                self.assertFalse(request.url.query)
                return httpx.Response(200, json=to_wire(release()))
            return httpx.Response(200, json=to_wire(node()))

        self.assertEqual(self.client(handler).execute(SHA, resume=True).name, NAME)
        self.assertEqual(
            [request.method for request in requests], ["GET", "POST", "GET"]
        )
        self.assertNotEqual(
            resume_id(NAME, "revision-3"), resume_id(NAME, "revision-4")
        )

    def test_resume_uses_original_targets_even_if_the_same_source_was_rebuilt(self):
        rebuilt = replace(TARGETS[0], image_digest="sha256:" + "d" * 64)
        for observed, succeeds in (
            (node(), True),
            (
                replace(
                    node(),
                    workloads=(
                        replace(
                            node().workloads[0],
                            release=replace(
                                node().workloads[0].release,
                                actual=replace(rebuilt, generation=3),
                            ),
                        ),
                        node().workloads[1],
                    ),
                ),
                False,
            ),
        ):
            requests = []

            def handler(request, requests=requests, observed=observed):
                requests.append(request)
                if request.url.path.endswith("nodeStatus"):
                    return httpx.Response(200, json=to_wire(observed))
                return httpx.Response(
                    200,
                    json=to_wire(release("held" if len(requests) == 1 else "ready")),
                )

            with self.subTest(succeeds=succeeds):
                client = self.client(handler)
                if succeeds:
                    result = client.execute(SHA, resume=True, timeout=30)
                    self.assertEqual(result.targets, TARGETS)
                else:
                    with self.assertRaisesRegex(
                        ReleaseFailure, "RELEASE_OBSERVATION_TIMEOUT"
                    ):
                        client.execute(SHA, resume=True, timeout=30)
                self.assertEqual(requests[0].method, "GET")
                posts = [request for request in requests if request.method == "POST"]
                self.assertEqual(len(posts), 1)
                self.assertTrue(posts[0].url.path.endswith(":resume"))
                self.assertNotIn("targets", json.loads(posts[0].content))

    def test_resume_refuses_forged_frozen_targets_before_sending_a_mutation(self):
        wrong_id = resume_id(NAME, "other-revision")
        changes = (
            replace(release("held"), name="releases/" + wrong_id),
            replace(release("held"), request_id=wrong_id),
            replace(release("held"), targets=(TARGETS[0], TARGETS[0])),
            replace(
                release("held"),
                targets=(replace(TARGETS[0], workload_key="other"), TARGETS[1]),
            ),
            replace(
                release("held"),
                targets=(replace(TARGETS[0], source_sha="d" * 40), TARGETS[1]),
            ),
            replace(
                release("held"),
                targets=(replace(TARGETS[0], request_id=wrong_id), TARGETS[1]),
            ),
            replace(
                release("held"), targets=(replace(TARGETS[0], generation=3), TARGETS[1])
            ),
        )
        for response in changes:
            requests = []

            def handler(request, requests=requests, response=response):
                requests.append(request)
                return httpx.Response(200, json=to_wire(response))

            with (
                self.subTest(response=response),
                self.assertRaisesRegex(
                    ReleaseFailure, "RELEASE_ACKNOWLEDGEMENT_INVALID"
                ),
            ):
                self.client(handler).execute(SHA, resume=True)
            self.assertEqual([request.method for request in requests], ["GET"])

        malformed = to_wire(release("held"))
        malformed["targets"][0]["image_digest"] = "ghcr.io/other/image:latest"
        with self.assertRaisesRegex(ReleaseFailure, "DEPLOYMENT_RESPONSE_INVALID"):
            self.client(lambda _: httpx.Response(200, json=malformed)).execute(
                SHA, resume=True
            )

    def test_resume_refuses_new_image_input_and_never_creates_missing_release(self):
        requests = []

        def handler(request):
            requests.append(request)
            return httpx.Response(
                404,
                json=status_body(
                    RpcError(
                        "NOT_FOUND",
                        "RELEASE_NOT_FOUND",
                        "Missing release.",
                        domain="platform.ziyixi.science",
                    )
                ),
            )

        client = self.client(handler)
        with self.assertRaisesRegex(ReleaseFailure, "INVALID_DEPLOYMENT_IMAGES"):
            client.execute(SHA, DIGESTS, resume=True)
        self.assertEqual(requests, [])
        with self.assertRaisesRegex(ReleaseFailure, "RELEASE_NOT_FOUND"):
            client.execute(SHA, resume=True)
        self.assertEqual([request.method for request in requests], ["GET"])

    def test_resume_never_adopts_replacement_targets_from_later_receipts(self):
        requests = []
        changed = replace(
            release(),
            targets=(
                replace(TARGETS[0], image_digest="sha256:" + "d" * 64),
                TARGETS[1],
            ),
        )

        def handler(request):
            requests.append(request)
            return httpx.Response(
                200, json=to_wire(release("held") if len(requests) == 1 else changed)
            )

        with self.assertRaisesRegex(ReleaseFailure, "RELEASE_ACKNOWLEDGEMENT_INVALID"):
            self.client(handler).execute(SHA, resume=True)
        self.assertEqual([request.method for request in requests], ["GET", "POST"])

    def test_self_restart_beyond_three_transient_requests_still_verifies(self):
        clock, failures = Clock(), {"release": 6, "node": 4}

        def handler(request):
            if request.method == "POST":
                return httpx.Response(200, json=to_wire(release("accepted")))
            key = "node" if request.url.path.endswith("nodeStatus") else "release"
            if failures[key]:
                failures[key] -= 1
                return httpx.Response(503, content=b"synthetic-private-restart")
            return httpx.Response(
                200, json=to_wire(node() if key == "node" else release())
            )

        result = self.client(handler, clock=clock).execute(SHA, DIGESTS)
        self.assertEqual(result.phase, "ready")
        self.assertEqual(failures, {"release": 0, "node": 0})
        self.assertGreater(clock.time, 30)

    def test_create_and_resume_replay_identical_requests_through_response_losses(self):
        for resume in (False, True):
            with self.subTest(resume=resume):
                posts, clock = [], Clock()

                def handler(request, posts=posts):
                    if request.method == "POST":
                        posts.append(request)
                        if len(posts) <= 6:
                            raise httpx.ReadTimeout(
                                "synthetic response loss", request=request
                            )
                        return httpx.Response(200, json=to_wire(release("accepted")))
                    if request.url.path.endswith("nodeStatus"):
                        return httpx.Response(200, json=to_wire(node()))
                    return httpx.Response(
                        200, json=to_wire(release("ready" if posts else "held"))
                    )

                self.assertEqual(
                    self.client(handler, clock=clock)
                    .execute(SHA, None if resume else DIGESTS, resume=resume)
                    .phase,
                    "ready",
                )
                self.assertEqual(len(posts), 7)
                self.assertTrue(all(request.url == posts[0].url for request in posts))
                self.assertTrue(
                    all(request.content == posts[0].content for request in posts)
                )
                self.assertEqual(posts[0].url.path.endswith(":resume"), resume)

    def test_total_deadline_includes_create_and_never_sleeps_beyond_budget(self):
        clock, requests = Clock(), []

        def handler(request):
            requests.append(request)
            return httpx.Response(503, content=b"synthetic-private-restart")

        with self.assertRaisesRegex(ReleaseFailure, "RELEASE_OBSERVATION_TIMEOUT"):
            self.client(handler, clock=clock).execute(SHA, DIGESTS, timeout=30)
        self.assertEqual(clock.time, 30)
        self.assertEqual(len(requests), 6)
        self.assertTrue(
            all(request.content == requests[0].content for request in requests)
        )

    def test_newsletter_unknown_business_is_separate_from_verified_deployment(self):
        good = node()
        newsletter = next(
            item for item in good.workloads if item.workload_key == "newsletter"
        )
        changed = replace(newsletter, health_state="degraded", unknown_count=1)
        observed = replace(
            good,
            state="degraded",
            workloads=tuple(
                changed if item.workload_key == "newsletter" else item
                for item in good.workloads
            ),
        )
        self.assertTrue(verified_snapshot(observed, TARGETS, NAME, NOW))
        for invalid in (
            replace(changed, unknown_count=0),
            replace(changed, unknown_count=None),
            replace(changed, health_state="unhealthy"),
        ):
            with self.subTest(status=invalid):
                rejected = replace(
                    observed,
                    workloads=tuple(
                        invalid if item.workload_key == "newsletter" else item
                        for item in good.workloads
                    ),
                )
                self.assertFalse(verified_snapshot(rejected, TARGETS, NAME, NOW))

        def handler(request):
            return httpx.Response(
                200,
                json=to_wire(
                    observed if request.url.path.endswith("nodeStatus") else release()
                ),
            )

        deployment = self.client(handler)
        self.assertEqual(deployment.execute(SHA, DIGESTS).phase, "ready")
        self.assertEqual(
            deployment.business_state["newsletter"],
            {"health_state": "degraded", "unknown_count": 1},
        )

    def test_stale_or_forged_actual_provenance_and_unknown_generations_never_pass(self):
        good = node()
        self.assertTrue(verified_snapshot(good, TARGETS, NAME, NOW))
        item = good.workloads[0]
        changes = [
            replace(item, observed_at="2026-10-02T23:55:00Z"),
            replace(item, admission_state="frozen"),
            replace(item, health_state="unknown"),
            replace(item, release=replace(item.release, actual=None)),
            replace(
                item,
                release=replace(
                    item.release,
                    actual=replace(item.release.actual, source_sha="d" * 40),
                ),
            ),
            replace(
                item,
                release=replace(
                    item.release,
                    actual=replace(
                        item.release.actual, image_digest="sha256:" + "e" * 64
                    ),
                ),
            ),
            replace(item, release=replace(item.release, observed_generation=None)),
            replace(
                item,
                release=replace(
                    item.release, actual=replace(item.release.actual, generation=2)
                ),
            ),
        ]
        for invalid in changes:
            with self.subTest(status=invalid):
                self.assertFalse(
                    verified_snapshot(
                        replace(good, workloads=(invalid, good.workloads[1])),
                        TARGETS,
                        NAME,
                        NOW,
                    )
                )
        self.assertFalse(
            verified_snapshot(replace(good, current_release=None), TARGETS, NAME, NOW)
        )

    def test_ready_ack_without_verified_actual_times_out_and_mismatched_ack_fails(self):
        def handler(request):
            if request.url.path.endswith("nodeStatus"):
                return httpx.Response(
                    200, json=to_wire(replace(node(), state="unknown"))
                )
            return httpx.Response(200, json=to_wire(release()))

        with self.assertRaisesRegex(ReleaseFailure, "RELEASE_OBSERVATION_TIMEOUT"):
            self.client(handler).execute(SHA, DIGESTS, timeout=30)
        changed = replace(
            release(), targets=(replace(TARGETS[0], source_sha="d" * 40), TARGETS[1])
        )
        with self.assertRaisesRegex(ReleaseFailure, "RELEASE_ACKNOWLEDGEMENT_INVALID"):
            self.client(lambda _: httpx.Response(200, json=to_wire(changed))).execute(
                SHA, DIGESTS
            )


class TransportPolicy(unittest.TestCase):
    def call(self, response):
        transport = Transport(
            "platform-runtime.example.test",
            CREDENTIALS,
            transport=httpx.MockTransport(lambda _: response),
        )
        self.addCleanup(transport.close)
        return transport.call(
            BINDINGS["GetRelease"], service.GetReleaseRequest(name=NAME)
        )

    def test_redirect_duplicate_json_oversize_and_private_upstream_errors_fail_safely(
        self,
    ):
        for response, code in (
            (
                httpx.Response(302, headers={"Location": "https://other.example.test"}),
                "UPSTREAM_REDIRECT_REFUSED",
            ),
            (
                httpx.Response(200, content=b'{"phase":"ready","phase":"held"}'),
                "DEPLOYMENT_RESPONSE_INVALID",
            ),
            (httpx.Response(200, content=b"x" * 32769), "UPSTREAM_RESPONSE_TOO_LARGE"),
            (
                httpx.Response(400, json={"error": "synthetic-private-detail"}),
                "DEPLOYMENT_API_REJECTED",
            ),
        ):
            with self.subTest(code=code), self.assertRaisesRegex(ReleaseFailure, code):
                self.call(response)
        error = RpcError(
            "ABORTED",
            "ETAG_MISMATCH",
            "Read the current operation.",
            domain="platform.ziyixi.science",
        )
        with self.assertRaisesRegex(ReleaseFailure, "ETAG_MISMATCH"):
            self.call(httpx.Response(409, json=status_body(error)))

    def test_credentials_and_generated_route_type_are_explicit(self):
        for credentials in (
            {},
            {**CREDENTIALS, "PLATFORM_DEPLOY_TOKEN": "short"},
            {**CREDENTIALS, "PLATFORM_ACCESS_CLIENT_SECRET": "synthetic\ninvalid"},
        ):
            with self.assertRaisesRegex(
                ReleaseFailure, "DEPLOYMENT_CREDENTIALS_MISSING_OR_INVALID"
            ):
                Transport("platform-runtime.example.test", credentials)
        with self.assertRaisesRegex(ReleaseFailure, "INVALID_TYPED_REQUEST"):
            request_parts(
                BINDINGS["GetRelease"],
                service.GetWorkloadRequest(name="workloads/newsletter"),
            )

    def test_whole_request_deadline_bounds_a_slow_response_stream(self):
        class SlowStream(httpx.AsyncByteStream):
            async def __aiter__(self):
                await asyncio.sleep(0.02)
                yield b"{}"

        transport = Transport(
            "platform-runtime.example.test",
            CREDENTIALS,
            transport=httpx.MockTransport(
                lambda _: httpx.Response(200, stream=SlowStream())
            ),
        )
        self.addCleanup(transport.close)
        with self.assertRaises(TransientFailure):
            transport.call(
                BINDINGS["GetRelease"],
                service.GetReleaseRequest(name=NAME),
                timeout=0.001,
            )

    def test_public_profile_rejects_other_owner_tags_partial_digests_and_unstable_source(
        self,
    ):
        root = Path(self.enterContext(tempfile.TemporaryDirectory())).resolve()
        (root / "config").mkdir()
        (root / "config/cloud.toml").write_text("""version=1
zone="example.test"
repository="example/personal-cloud"
access_issuer="https://example.cloudflareaccess.com"
platform_hostname="fleet.example.test"
[vps]
platform_runtime_host="platform-runtime.example.test"
namespace="personal-cloud"
state_root="/srv/personal-cloud"
observer_node_key="vps"
""")
        images = {
            service: "ghcr.io/example/todofy-" + service + "@" + DIGESTS[key]
            for service, key in (
                ("newsletter", "newsletter"),
                ("platform", "platform-runtime"),
            )
        }
        self.assertEqual(verified_images(root, SHA, images)[1], DIGESTS)
        for invalid in (
            images["newsletter"].replace("example/", "other/"),
            "ghcr.io/example/todofy-newsletter:latest",
            images["newsletter"][:-1],
        ):
            with self.subTest(image=invalid), self.assertRaises(ValueError):
                verified_images(root, SHA, {**images, "newsletter": invalid})
        for sha in ("main", "a" * 39, SHA.upper()):
            with self.assertRaises(ValueError):
                verified_images(root, sha, images)


if __name__ == "__main__":
    unittest.main()

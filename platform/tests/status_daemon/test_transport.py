"""Transport boundaries and generated routes without real Kubernetes or Newsletter calls."""

import sys
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import Mock, patch

import httpx
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))
from personal_cloud.deployment.kubernetes import DependencyUnavailable
from personal_cloud.status_daemon.config import Configuration
from personal_cloud.status_daemon.reader import (
    MONITOR_URL,
    Reader,
    ReadError,
    read_json,
)
from personal_cloud.status_daemon.server import Cache, Service, create_app
from ziyixi_proto.platform.runtime.v1 import runtime_pb as pb
from ziyixi_proto.rpc_status import RpcError
from ziyixi_proto.wire_json import from_wire

if __package__:
    from .test_status import AT, CONFIG, REQUEST, deployment, monitor, pods, target
else:
    from test_status import AT, CONFIG, REQUEST, deployment, monitor, pods, target


class ReaderTests(unittest.TestCase):
    def setUp(self):
        self.config = Configuration(
            "vps", "personal-cloud", (CONFIG,), "example/project"
        )
        self.calls = []
        owner = self

        class Kube:
            def get(inner, kind, name, *, timeout):
                owner.calls.append((kind, name, timeout))
                if (kind, name) == ("ConfigMap", "newsletter-release"):
                    return target()
                if (kind, name) == ("Deployment", "newsletter"):
                    return deployment()
                owner.fail("Unconfigured provider request")

            def pods(inner, name, *, timeout):
                owner.calls.append(("Pod", name, timeout))
                owner.assertEqual(name, "newsletter")
                return pods()

            def close(inner):
                pass

        self.kube = Kube()

    def transport(self, url, headers, limit, timeout):
        self.calls.append((url, dict(headers), limit, timeout))
        self.assertEqual(url, MONITOR_URL)
        return monitor()

    def reader(self, kube=None, transport=None):
        return Reader(
            self.config,
            "monitor-only-synthetic-token",
            REQUEST,
            kube_client=kube or self.kube,
            transport=transport or self.transport,
            clock=lambda: AT,
        )

    def test_official_sdk_identity_and_monitor_token_have_separate_scopes(self):
        with patch(
            "personal_cloud.status_daemon.reader.Client", return_value=self.kube
        ) as sdk:
            value = Reader(
                self.config,
                "monitor-only-synthetic-token",
                REQUEST,
                token_file="synthetic-token",
                ca_file="synthetic-ca",
                transport=self.transport,
                clock=lambda: AT,
            ).collect()
        sdk.assert_called_once_with(
            "personal-cloud", token_file="synthetic-token", ca_file="synthetic-ca"
        )
        self.assertEqual(value.state, "ready")
        kube = [item for item in self.calls if item[0] != MONITOR_URL]
        self.assertEqual(
            [(item[0], item[1]) for item in kube],
            [
                ("ConfigMap", "newsletter-release"),
                ("Deployment", "newsletter"),
                ("Pod", "newsletter"),
                ("ConfigMap", "newsletter-release"),
            ],
        )
        self.assertTrue(all(0 < item[2] <= 12 for item in kube))
        app = next(item for item in self.calls if item[0] == MONITOR_URL)
        self.assertEqual(
            (app[1]["Authorization"], app[2]),
            ("Bearer monitor-only-synthetic-token", 16 * 1024),
        )

    def test_unavailable_dependencies_produce_200_capable_unknown_states(self):
        kube = Mock()
        kube.get.side_effect = DependencyUnavailable()
        value = self.reader(kube).collect()
        self.assertEqual(
            (
                value.state,
                value.workloads[0].process_state,
                value.workloads[0].release.state,
            ),
            ("unavailable", "unknown", "unknown"),
        )
        self.assertIsNone(value.workloads[0].release.desired)
        self.assertIsNone(value.workloads[0].release.actual)

    def test_missing_resources_differ_from_read_failures(self):
        kube = Mock()
        kube.get.side_effect = DependencyUnavailable(missing=True)
        kube.pods.side_effect = DependencyUnavailable(missing=True)
        value = self.reader(kube).collect()
        self.assertEqual(
            (
                value.state,
                value.workloads[0].process_state,
                value.workloads[0].release.state,
            ),
            ("missing", "missing", "missing"),
        )

    def test_target_change_during_read_is_not_acknowledged(self):
        original = self.kube.get
        reads = 0

        def changing(kind, name, *, timeout):
            nonlocal reads
            value = original(kind, name, timeout=timeout)
            if kind == "ConfigMap":
                reads += 1
                if reads > 1:
                    value["data"]["request_id"] = "bccf3a43-0499-4592-ad0c-126832e5d90b"
            return value

        self.kube.get = changing
        value = self.reader().collect()
        self.assertEqual(value.workloads[0].release.state, "unknown")
        self.assertIsNone(value.workloads[0].release.actual)

    def test_missing_private_monitor_does_not_hide_process_observation(self):
        reader = self.reader()
        reader.monitor_token = ""
        value = reader.collect()
        self.assertEqual(
            (
                value.workloads[0].process_state,
                value.workloads[0].health_state,
                value.workloads[0].release.state,
            ),
            ("running", "unknown", "unknown"),
        )

    def test_expired_collection_budget_does_not_initiate_another_read(self):
        times = iter([0, 13])
        reader = self.reader()
        reader.monotonic = lambda: next(times)
        value = reader.collect()
        self.assertEqual(value.state, "unavailable")
        self.assertEqual(self.calls, [])


class JSONTransport(unittest.TestCase):
    def client(
        self,
        body=b"{}",
        status=200,
        content_type="application/json",
        callback=None,
        **headers,
    ):
        def handle(request):
            if callback:
                callback(request)
            return httpx.Response(
                status,
                headers={"Content-Type": content_type, **headers},
                stream=httpx.ByteStream(body),
            )

        return httpx.Client(
            transport=httpx.MockTransport(handle),
            trust_env=False,
            follow_redirects=False,
        )

    def test_only_get_bounded_json_and_no_redirect_or_proxy_are_used(self):
        calls = []
        with self.client(callback=lambda request: calls.append(request)) as client:
            self.assertEqual(read_json(MONITOR_URL, {}, 10, 12, client=client), {})
        self.assertEqual((calls[0].method, str(calls[0].url)), ("GET", MONITOR_URL))
        self.assertEqual(calls[0].headers["Accept-Encoding"], "identity")
        self.assertTrue(
            all(value == 3 for value in calls[0].extensions["timeout"].values())
        )
        active = self.client()
        with (
            active,
            patch("personal_cloud.status_daemon.reader.httpx.Client") as factory,
        ):
            factory.return_value.__enter__.return_value = active
            read_json(MONITOR_URL, {}, 10, 12)
            factory.assert_called_once_with(trust_env=False, follow_redirects=False)

    def test_invalid_json_content_type_redirects_and_overlarge_responses_fail_safely(
        self,
    ):
        for options in (
            {"body": b'{"x":1,"x":2}'},
            {"body": b"[]"},
            {"content_type": "text/html"},
            {"body": b"x" * 11},
            {"status": 302, "Location": "http://forbidden/"},
            {"status": 403, "body": b"private-provider-message"},
            {"Content-Encoding": "gzip"},
            {"body": b'{"n":NaN}'},
        ):
            with (
                self.subTest(options=options),
                self.client(**options) as client,
                self.assertRaises(ReadError) as error,
            ):
                read_json(MONITOR_URL, {}, 10, 3, client=client)
            self.assertEqual(str(error.exception), "read_unavailable")


class API(unittest.TestCase):
    def setUp(self):
        self.reads, self.at = 0, 0

        class Reader:
            def collect(inner):
                self.reads += 1
                return pb.NodeStatus(
                    name="nodeStatus",
                    node_key="vps",
                    state="unknown",
                    observed_at="2026-10-02T12:00:00Z",
                    workloads=(
                        pb.WorkloadStatus(
                            name="workloads/newsletter",
                            workload_key="newsletter",
                            process_state="unknown",
                            admission_state="unknown",
                            health_state="unknown",
                            release=pb.ReleaseStatus(
                                state="unknown", observed_at="2026-10-02T12:00:00Z"
                            ),
                            observed_at="2026-10-02T12:00:00Z",
                        ),
                    ),
                )

        self.cache = Cache(Reader(), clock=lambda: self.at)
        self.service = Service(self.cache, ("newsletter",))

    def test_generated_routes_validate_before_any_provider_read(self):
        for route in (
            "/api/v1/nodeStatus?unexpected=1",
            "/api/v1/workloads?page_size=17",
            "/api/v1/workloads?page_size=1&page_size=1",
            "/api/v1/workloads?page_token=invalid",
            "/api/v1/workloads/unconfigured",
            "/api/v1/workloads%2Fnewsletter",
        ):
            with self.subTest(route=route), self.assertRaises(RpcError):
                self.service.get(route)
        self.assertEqual(self.reads, 0)
        self.assertEqual(
            self.service.get("/api/v1/workloads/newsletter").workload_key, "newsletter"
        )
        self.assertEqual(self.service.get("/api/v1/workloads").next_page_token, "")
        self.assertEqual(self.reads, 1)

    def test_cache_refresh_and_maximum_staleness_do_not_fabricate_observation_times(
        self,
    ):
        first = self.cache.get()
        self.at = 29
        self.assertIs(self.cache.get(), first)
        self.assertEqual(self.reads, 1)
        self.cache.reader.collect = unittest.mock.Mock(side_effect=ReadError())
        self.at = 30
        self.assertIs(self.cache.get(), first)
        self.at = 61
        with self.assertRaises(RpcError) as error:
            self.cache.get()
        self.assertEqual(error.exception.code, "UNAVAILABLE")

    def test_collection_cursors_are_bounded_and_summary_does_not_share_status_cache(
        self,
    ):
        snapshot = self.cache.get()
        second = replace(
            snapshot.workloads[0], name="workloads/other", workload_key="other"
        )
        self.cache.value = replace(snapshot, workloads=(*snapshot.workloads, second))
        self.service.keys = ("newsletter", "other")
        first = self.service.get("/api/v1/workloads?page_size=1")
        self.assertEqual(
            [item.workload_key for item in first.workloads], ["newsletter"]
        )
        last = self.service.get(
            "/api/v1/workloads?page_size=1&page_token=" + first.next_page_token
        )
        self.assertEqual(
            ([item.workload_key for item in last.workloads], last.next_page_token),
            (["other"], ""),
        )
        phase = "accepted"
        self.service.summary = lambda: pb.ReleaseSummary(
            name="releases/" + REQUEST,
            request_id=REQUEST,
            phase=phase,
            etag="revision-a",
            update_time="2026-10-02T12:00:00Z",
        )
        self.assertEqual(
            self.service.get("/api/v1/nodeStatus").current_release.phase, "accepted"
        )
        phase = "draining"
        self.assertEqual(
            self.service.get("/api/v1/nodeStatus").current_release.phase, "draining"
        )
        self.assertIsNone(self.cache.value.current_release)
        self.assertEqual(self.reads, 1)

    def test_asgi_errors_are_shared_google_status_and_lifespan_closes_dependencies(
        self,
    ):
        calls = []

        class Router:
            def authorize(inner, headers):
                calls.append("authorize")
                if headers.get("Authorization") != "Bearer synthetic-machine":
                    raise RpcError(
                        "UNAUTHENTICATED",
                        "AUTHENTICATION_REQUIRED",
                        "Machine authentication is required.",
                        domain="platform.ziyixi.science",
                    )

            def handle(inner, method, target, headers, body):
                calls.append((method, target))
                inner.authorize(headers)
                return 200, {"seen": body()}

            def close(inner):
                calls.append("close")

        with TestClient(create_app(self.service, Router())) as client:
            response = client.get("/api/v1/nodeStatus")
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.headers["Cache-Control"], "no-store")
            self.assertEqual(
                from_wire(pb.NodeStatus, response.json(), strict=True).message.state,
                "unknown",
            )
            response = client.post("/api/v1/releases", content=b"not-json")
            self.assertEqual(
                (response.status_code, response.json()["error"]["status"]),
                (401, "UNAUTHENTICATED"),
            )
            response = client.post(
                "/api/v1/releases",
                json={"value": 1},
                headers={"Authorization": "Bearer synthetic-machine"},
            )
            self.assertEqual(
                (response.status_code, response.json()), (200, {"seen": {"value": 1}})
            )
            response = client.post(
                "/api/v1/releases",
                content=b'{"x":1,"x":2}',
                headers={
                    "Authorization": "Bearer synthetic-machine",
                    "Content-Type": "application/json",
                },
            )
            self.assertEqual(
                (response.status_code, response.json()["error"]["status"]),
                (400, "INVALID_ARGUMENT"),
            )
            self.assertEqual(
                response.json()["error"]["details"][0]["domain"],
                "platform.ziyixi.science",
            )
        self.assertEqual(calls[-1], "close")

    def test_framework_has_no_parallel_schema_and_encoded_paths_do_not_change_identity(
        self,
    ):
        app = create_app(self.service)
        self.assertIsNone(app.openapi_url)
        with TestClient(app) as client:
            for path in ("/api/v1/workloads%2Fnewsletter", "/openapi.json", "/docs"):
                response = client.get(path)
                self.assertEqual(
                    (response.status_code, response.json()["error"]["status"]),
                    (404, "NOT_FOUND"),
                )
            response = client.put("/api/v1/nodeStatus")
            self.assertEqual(
                (response.status_code, response.json()["error"]["status"]),
                (405, "UNIMPLEMENTED"),
            )
        self.assertEqual(self.reads, 0)


class StreamingAPI(unittest.IsolatedAsyncioTestCase):
    async def test_authentication_rejection_does_not_consume_asgi_stream(self):
        consumed = False

        async def stream():
            nonlocal consumed
            consumed = True
            yield b"private-unparsed-request"

        class Router:
            def authorize(self, headers):
                raise RpcError(
                    "UNAUTHENTICATED",
                    "AUTHENTICATION_REQUIRED",
                    "Machine authentication is required.",
                    domain="platform.ziyixi.science",
                )

        service = Service(Cache(Mock()), ("newsletter",))
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=create_app(service, Router())),
            base_url="http://synthetic",
        ) as client:
            response = await client.post(
                "/api/v1/releases",
                content=stream(),
                headers={"Content-Type": "application/json"},
            )
        self.assertEqual(response.status_code, 401)
        self.assertFalse(consumed)

    async def test_body_stream_without_length_is_bounded_before_decoding(self):
        class Router:
            def authorize(self, headers):
                pass

            def handle(self, *args):
                raise AssertionError("Overlarge body reached controller")

        async def stream():
            yield b"x" * 16000
            yield b"x" * 1000

        service = Service(Cache(Mock()), ("newsletter",))
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=create_app(service, Router())),
            base_url="http://synthetic",
        ) as client:
            response = await client.post(
                "/api/v1/releases",
                content=stream(),
                headers={"Content-Type": "application/json"},
            )
        self.assertEqual(
            (response.status_code, response.json()["error"]["status"]),
            (400, "INVALID_ARGUMENT"),
        )


if __name__ == "__main__":
    unittest.main()

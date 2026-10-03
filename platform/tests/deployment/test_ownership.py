"""Two synthetic SSA cycles through the real SDK; not a live Kubernetes acceptance."""

import json
import tempfile
import unittest
from copy import deepcopy
from pathlib import Path
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

import yaml
from personal_cloud.deployment.kubernetes import Client, DependencyUnavailable
from personal_cloud.deployment.resources import Renderer
from personal_cloud.status_daemon.config import Configuration, Workload
from urllib3.response import HTTPResponse
from ziyixi_proto.platform.runtime.v1 import runtime_pb as pb


def fields(value, prefix=()):
    result = {}
    for key, child in value.items():
        path = (*prefix, key)
        if isinstance(child, dict):
            result.update(fields(child, path))
        else:
            result[path] = child
    return result


class Ownership:
    """Model SSA conflict, sharing and omission for scalar fields and atomic lists."""

    def __init__(self):
        self.values, self.owners, self.applied, self.calls = {}, {}, {}, []

    def request(self, _, method, url, **options):
        body = json.loads(options["body"])
        key = (body["kind"], body["metadata"]["name"])
        query = parse_qs(urlsplit(url).query)
        manager = query["fieldManager"][0]
        force = query["force"][0] == "true"
        self.calls.append((method, key, query, options["headers"], body))
        current = self.values.setdefault(key, {})
        owners = self.owners.setdefault(key, {})
        wanted = fields(body)
        for path, value in wanted.items():
            foreign = owners.get(path, set()) - {manager}
            if path in current and current[path] != value and foreign and not force:
                return HTTPResponse(
                    body=b'{"kind":"Status","reason":"Conflict","code":409}',
                    status=409,
                    headers={"Content-Type": "application/json"},
                )
        for path in self.applied.get((key, manager), set()) - set(wanted):
            owners.get(path, set()).discard(manager)
            if not owners.get(path):
                current.pop(path, None)
        for path, value in wanted.items():
            if current.get(path) != value:
                owners[path] = set()
            current[path] = value
            owners.setdefault(path, set()).add(manager)
        self.applied[(key, manager)] = set(wanted)
        if key[0] == "CronJob":
            current.setdefault(("spec", "suspend"), False)
        return HTTPResponse(
            body=b'{"metadata":{"resourceVersion":"synthetic"}}',
            status=200,
            headers={"Content-Type": "application/json"},
        )

    def legacy_update(self, key, path, value):
        self.values[key][path] = value
        self.owners[key][path] = {"OpenAPI-Generator/Update"}


class StatusOwnership(unittest.TestCase):
    def test_two_releases_preserve_suspension_and_tolerate_old_activated_ownership(
        self,
    ):
        directory = Path(__file__).resolve().parents[2] / "k3s/newsletter"
        names = yaml.safe_load((directory / "kustomization.yaml").read_text())[
            "resources"
        ]
        asset = {
            "apiVersion": "v1",
            "kind": "List",
            "items": [
                item
                for name in names
                for item in yaml.safe_load_all((directory / name).read_text())
            ],
        }
        config = Configuration(
            "vps",
            "personal-cloud",
            (
                Workload(
                    "newsletter",
                    "newsletter",
                    "newsletter",
                    "newsletter-release",
                    "newsletter",
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
        renderer = Renderer(config, asset=asset)
        selected = {"newsletter-release", "platform-release", "newsletter-daily"}
        for legacy in (False, True):
            with (
                self.subTest(legacy=legacy),
                tempfile.TemporaryDirectory() as temporary,
            ):
                token = Path(temporary) / "token"
                token.write_text("synthetic-projected-token-value")
                active = Client(
                    "personal-cloud", token_file=str(token), ca_file="synthetic-ca"
                )
                self.addCleanup(active.close)
                server = Ownership()
                with patch(
                    "kubernetes.client.rest.urllib3.PoolManager.request",
                    autospec=True,
                    side_effect=server.request,
                ):
                    for source in asset["items"]:
                        if source["metadata"]["name"] in selected:
                            bootstrap = deepcopy(source)
                            bootstrap["metadata"]["namespace"] = config.namespace
                            active.apply(bootstrap)
                    if legacy:
                        for name in ("newsletter-release", "platform-release"):
                            server.legacy_update(
                                ("ConfigMap", name), ("data", "phase"), "activated"
                            )
                        server.legacy_update(
                            ("CronJob", "newsletter-daily"), ("spec", "suspend"), False
                        )
                    for generation in ("a", "b"):
                        targets = tuple(
                            pb.ReleaseTarget(
                                workload_key=item.key,
                                source_sha=generation * 40,
                                image_digest="sha256:" + generation * 64,
                                request_id="89f6feb1-4287-4f22-a374-76b9e9c2b1c0",
                            )
                            for item in config.workloads
                        )
                        active.patch(
                            "CronJob", "newsletter-daily", {"spec": {"suspend": True}}
                        )
                        for resource in renderer.render(targets, "synthetic-release"):
                            name = resource["metadata"]["name"]
                            if name not in selected:
                                continue
                            active.apply(resource)
                            self.assertIs(
                                server.values[("CronJob", "newsletter-daily")][
                                    ("spec", "suspend")
                                ],
                                True,
                            )
                            if resource["kind"] == "ConfigMap":
                                active.patch(
                                    "ConfigMap", name, {"data": {"phase": "applying"}}
                                )
                                self.assertEqual(
                                    server.values[("ConfigMap", name)][
                                        ("data", "phase")
                                    ],
                                    "applying",
                                )
                        for name in ("newsletter-release", "platform-release"):
                            active.patch(
                                "ConfigMap", name, {"data": {"phase": "activated"}}
                            )
                        active.patch(
                            "CronJob", "newsletter-daily", {"spec": {"suspend": False}}
                        )

                        # The old manifest policy must conflict: otherwise this simulator
                        # would not detect the production regression it is intended to cover.
                        wrong = next(
                            item
                            for item in renderer.render(targets, "synthetic-release")
                            if item["metadata"]["name"] == "newsletter-release"
                        )
                        wrong["data"]["phase"] = "applying"
                        with self.assertRaises(DependencyUnavailable):
                            active.apply(wrong)
                status = "personal-cloud-runtime-status"
                self.assertEqual(
                    server.owners[("ConfigMap", "newsletter-release")][
                        ("data", "phase")
                    ],
                    {status},
                )
                self.assertEqual(
                    server.owners[("CronJob", "newsletter-daily")][("spec", "suspend")],
                    {status},
                )
                for method, _, query, headers, body in server.calls:
                    self.assertEqual(method, "PATCH")
                    self.assertEqual(
                        headers["Content-Type"], "application/apply-patch+yaml"
                    )
                    manager = query["fieldManager"][0]
                    self.assertEqual(
                        query["force"], ["true" if manager == status else "false"]
                    )
                    if manager == status:
                        self.assertEqual(
                            set(body),
                            {
                                "apiVersion",
                                "kind",
                                "metadata",
                                "data" if body["kind"] == "ConfigMap" else "spec",
                            },
                        )
                        self.assertEqual(
                            set(body.get("data", body.get("spec"))),
                            {"phase" if body["kind"] == "ConfigMap" else "suspend"},
                        )


if __name__ == "__main__":
    unittest.main()

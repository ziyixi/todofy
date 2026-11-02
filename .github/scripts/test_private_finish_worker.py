"""Finishing a partial private release never repeats its collector mutation."""

import importlib.util
import io
import json
import os
import tempfile
import unittest
from contextlib import contextmanager, redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

ROOT = Path(__file__).absolute().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "private_finish_worker", ROOT / ".github/scripts/private_finish_worker.py"
)
finish = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(finish)
PARENT, PRIVATE, DIGEST = "a" * 40, "b" * 40, "sha256:" + "c" * 64
API = "https://api.github.com/repos/ziyixi/todofy"


class FinishWorker(unittest.TestCase):
    def fixture(self, root):
        commands, requests, order = [], [], []
        deployment = {
            "metadata": {
                "labels": {
                    "app.kubernetes.io/part-of": "quant",
                    "app.kubernetes.io/managed-by": "quant-k3s-install",
                },
                "annotations": {"quant.ziyixi.science/install-id": "d" * 64},
            }
        }

        def kubectl(arguments, **options):
            self.assertEqual(arguments[0], "get")
            self.assertNotIn("Secret", arguments)
            commands.append(arguments)
            return SimpleNamespace(stdout=json.dumps(deployment))

        @contextmanager
        def session(_root):
            yield SimpleNamespace(run=kubectl)

        def owned(document, install_id):
            self.assertEqual(install_id, "d" * 64)
            if (
                document["metadata"]["labels"].get("app.kubernetes.io/part-of")
                != "quant"
            ):
                raise ValueError("quant_install_identity_collision")

        def request(url, *, token, method="GET", body=None):
            requests.append((url, method, body))
            if method == "GET" and url == API + "/git/ref/heads/main":
                return {"object": {"sha": PARENT}}
            if method == "POST" and url == API + "/deployments":
                return {"statuses_url": API + "/deployments/2/statuses"}
            if method == "POST" and url == API + "/deployments/2/statuses":
                order.append(body["state"])
                return {}
            raise AssertionError("Unexpected request, including any business mutation")

        def execute(arguments, **options):
            commands.append(arguments)
            self.assertNotIn(arguments[0], {"docker", "kubectl"})
            self.assertFalse(
                any(
                    "collector_image" in item or "image.digest" in item
                    for item in arguments
                )
            )
            if arguments[:2] == ["bazel", "build"]:
                self.assertEqual(arguments[2], "@private//quant:worker_artifact")
            if arguments[:2] == ["bazel", "cquery"]:
                return SimpleNamespace(returncode=0, stdout="worker.tar\n")
            return SimpleNamespace(returncode=0, stdout="")

        def prepare(run, output, work, config):
            self.assertEqual(
                output("@private//quant:worker_artifact"), root / "worker.tar"
            )
            run(["node", "tools/cf-guard/cf-guard.mjs"])
            return "prepared"

        def deploy(run, options, prepared, source):
            self.assertEqual((prepared, source), ("prepared", PRIVATE))
            order.append("deploy")
            run(
                [
                    "bazel",
                    "run",
                    "@private//quant/worker:wrangler",
                    *options,
                    "--",
                    "deploy",
                ]
            )
            order.append("healthy")

        release = SimpleNamespace(
            ROOT=root,
            checked_source=Mock(return_value=(PARENT, PRIVATE)),
            configuration=Mock(return_value={}),
            require_private_package=Mock(),
            registry_digest=Mock(return_value=DIGEST),
            observe_collector_release=Mock(
                side_effect=lambda *args: order.append("collector_verified")
            ),
            prepare_worker=Mock(side_effect=prepare),
            deploy_worker=Mock(side_effect=deploy),
            request=Mock(side_effect=request),
        )
        for name in (
            "_publish",
            "publish_image",
            "install_collector",
            "ensure_installed",
            "ensure_provider_inputs",
            "rollout_collector",
        ):
            setattr(
                release,
                name,
                Mock(side_effect=AssertionError("Collector writes forbidden")),
            )
        return release, session, owned, commands, requests, order, deployment, execute

    def test_finishes_worker_only_and_records_new_receipt_after_health(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            release, session, owned, commands, requests, order, _, execute = (
                self.fixture(root)
            )
            with (
                patch.dict(
                    os.environ,
                    {"GITHUB_TOKEN": "synthetic", "GITHUB_ACTOR": "synthetic"},
                ),
                patch.object(finish.subprocess, "run", side_effect=execute),
                redirect_stdout(io.StringIO()),
            ):
                finish.complete(release, session, owned)
        self.assertEqual(
            order, ["collector_verified", "in_progress", "deploy", "healthy", "success"]
        )
        release.observe_collector_release.assert_called_once()
        self.assertEqual(
            release.observe_collector_release.call_args.args[1:3], (PRIVATE, DIGEST)
        )
        release.deploy_worker.assert_called_once()
        for name in (
            "_publish",
            "publish_image",
            "install_collector",
            "ensure_installed",
            "ensure_provider_inputs",
            "rollout_collector",
        ):
            getattr(release, name).assert_not_called()
        writes = [(url, body) for url, method, body in requests if method == "POST"]
        self.assertEqual(len(writes), 3)
        self.assertEqual(writes[0][1]["ref"], PARENT)
        self.assertEqual(writes[0][1]["environment"], "private")
        self.assertEqual(writes[0][1]["payload"]["private_sha"], PRIVATE)
        self.assertTrue(all(url.startswith(API + "/deployments") for url, _ in writes))
        self.assertEqual(
            sum(command[:2] == ["bazel", "build"] for command in commands), 1
        )

    def test_wrong_gate_main_registry_ownership_or_runtime_identity_cannot_deploy(self):
        for failure in ("gate", "main", "digest", "owner", "install_id", "observer"):
            with (
                self.subTest(failure=failure),
                tempfile.TemporaryDirectory() as directory,
            ):
                release, session, owned, commands, requests, _, deployment, execute = (
                    self.fixture(Path(directory))
                )
                if failure == "gate":
                    release.checked_source.side_effect = ValueError(
                        "private_release_ci_not_green"
                    )
                elif failure == "main":
                    release.request.side_effect = lambda *args, **options: {
                        "object": {"sha": "e" * 40}
                    }
                elif failure == "digest":
                    release.registry_digest.return_value = (
                        "synthetic-private-invalid-digest"
                    )
                elif failure == "owner":
                    deployment["metadata"]["labels"]["app.kubernetes.io/part-of"] = (
                        "foreign"
                    )
                elif failure == "install_id":
                    deployment["metadata"]["annotations"] = {}
                else:
                    # The existing observer's ready result covers native source, actual Pod
                    # imageID, observedGeneration and readiness; it refuses each mismatch.
                    release.observe_collector_release.side_effect = ValueError(
                        "private_release_not_observed"
                    )
                with (
                    patch.dict(
                        os.environ,
                        {"GITHUB_TOKEN": "synthetic", "GITHUB_ACTOR": "synthetic"},
                    ),
                    patch.object(finish.subprocess, "run", side_effect=execute),
                    self.assertRaises(ValueError),
                ):
                    finish.complete(release, session, owned)
                release.prepare_worker.assert_not_called()
                release.deploy_worker.assert_not_called()
                self.assertFalse(any(method == "POST" for _, method, _ in requests))
                self.assertFalse(
                    any(command[:2] == ["bazel", "build"] for command in commands)
                )

    def test_worker_failure_marks_only_the_new_receipt_failed(self):
        with tempfile.TemporaryDirectory() as directory:
            release, session, owned, _, requests, order, _, execute = self.fixture(
                Path(directory)
            )
            release.deploy_worker.side_effect = ValueError(
                "private_worker_health_not_observed"
            )
            with (
                patch.dict(
                    os.environ,
                    {"GITHUB_TOKEN": "synthetic", "GITHUB_ACTOR": "synthetic"},
                ),
                patch.object(finish.subprocess, "run", side_effect=execute),
                self.assertRaisesRegex(
                    ValueError, "private_worker_health_not_observed"
                ),
            ):
                finish.complete(release, session, owned)
        self.assertEqual(order, ["collector_verified", "in_progress", "failure"])
        self.assertFalse(
            any(body and body.get("state") == "success" for _, _, body in requests)
        )

    def test_failed_command_never_publishes_private_output(self):
        private = "synthetic-private-key 192.0.2.7 /private/data"
        with tempfile.TemporaryDirectory() as directory:
            release, session, owned, _, requests, _, _, _ = self.fixture(
                Path(directory)
            )
            with (
                patch.dict(
                    os.environ, {"GITHUB_TOKEN": private, "GITHUB_ACTOR": "synthetic"}
                ),
                patch.object(
                    finish.subprocess,
                    "run",
                    return_value=SimpleNamespace(
                        returncode=1, stdout=private, stderr=private
                    ),
                ),
                self.assertRaisesRegex(
                    ValueError, "^private_finish_worker_command_failed$"
                ) as failure,
            ):
                finish.complete(release, session, owned)
        self.assertNotIn(private, str(failure.exception))
        self.assertFalse(any(method == "POST" for _, method, _ in requests))

    def test_provider_cannot_redirect_receipt_token_to_another_endpoint(self):
        with tempfile.TemporaryDirectory() as directory:
            release, session, owned, _, requests, _, _, execute = self.fixture(
                Path(directory)
            )
            request = release.request.side_effect

            def response(url, **options):
                value = request(url, **options)
                if options.get("method") == "POST" and url == API + "/deployments":
                    value["statuses_url"] = "https://private.invalid/statuses"
                return value

            release.request.side_effect = response
            with (
                patch.dict(
                    os.environ,
                    {"GITHUB_TOKEN": "synthetic", "GITHUB_ACTOR": "synthetic"},
                ),
                patch.object(finish.subprocess, "run", side_effect=execute),
                self.assertRaisesRegex(
                    ValueError, "private_finish_worker_receipt_invalid"
                ),
            ):
                finish.complete(release, session, owned)
        release.deploy_worker.assert_not_called()
        self.assertEqual(sum(method == "POST" for _, method, _ in requests), 1)


if __name__ == "__main__":
    unittest.main()

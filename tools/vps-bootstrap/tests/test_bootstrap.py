"""Synthetic bootstrap boundaries. Never install a service or contact a cluster."""

import contextlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from subprocess import CompletedProcess
from unittest.mock import patch

import yaml
from personal_cloud.deployment.resources import Renderer
from personal_cloud.status_daemon.config import configuration
from ziyixi_proto.platform.runtime.v1 import runtime_pb as pb

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "tools/vps-bootstrap"))

import binaries
import cluster
import firewall
import host
import install
import observer_policy
import prepare

import config

SHA = "a" * 40
IMAGES = {
    "newsletter": "ghcr.io/ziyixi/todofy-newsletter@sha256:" + "b" * 64,
    "platform": "ghcr.io/ziyixi/todofy-platform@sha256:" + "c" * 64,
}
PATHS = {
    "NEWSLETTER_DATA_DIR": "/var/lib/newsletter",
    "CODEX_HOME": "/var/lib/newsletter-auth",
    "NEWSLETTER_CODEX_HOME": "/var/lib/newsletter-auth",
    "NEWSLETTER_CONTENT_CONFIG_DIR": "/var/lib/newsletter-config",
}


def newsletter_container(runtime):
    deployment = next(
        item
        for item in runtime["items"]
        if item["kind"] == "Deployment" and item["metadata"]["name"] == "newsletter"
    )
    return deployment["spec"]["template"]["spec"]["containers"][0]


class BootstrapTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name).resolve()

    def bundle(self):
        output = self.base / "public-bundle"
        deployment = yaml.safe_load(
            (ROOT / "platform/k3s/newsletter/deployment.yaml").read_text()
        )
        for variable in deployment["spec"]["template"]["spec"]["containers"][0]["env"]:
            if variable["name"] == "NEWSLETTER_BOOTSTRAP_DRAIN_KEY":
                variable["value"] = "release-" + SHA
        runtime = {
            "apiVersion": "v1",
            "kind": "List",
            "items": [
                deployment,
                {
                    "kind": "CronJob",
                    "metadata": {"name": "newsletter-daily"},
                    "spec": {},
                },
            ],
        }
        with patch.object(prepare, "render", return_value=runtime):
            prepare.prepare(ROOT, SHA, IMAGES, output)
        return output

    def private(self):
        editor = "e" * 40
        send = "s" * 40
        value = {
            "schema_version": 1,
            "newsletter_env": {
                "NEWSLETTER_EDITOR_TOKEN": editor,
                "NEWSLETTER_SEND_TOKEN": send,
                "NEWSLETTER_MONITOR_TOKEN": "m" * 40,
            },
            "trigger_env": {
                "NEWSLETTER_EDITOR_TOKEN": editor,
                "NEWSLETTER_SEND_TOKEN": send,
            },
            "platform_env": {"PLATFORM_DEPLOY_TOKEN": "p" * 40},
            "fleet_key": "d" * 64,
            "connector_token": "t" * 80,
            "old_paths": {},
        }
        path = self.base / "credentials.json"
        path.write_text(json.dumps(value))
        path.chmod(0o600)
        return path, value

    def test_prepare_accepts_only_verified_images_and_keeps_initial_runtime_held(self):
        bundle = self.bundle()
        value = config.load_bundle(bundle)
        self.assertEqual(value["source_sha"], SHA)
        self.assertIn("installer/binaries.py", value["files"])
        self.assertEqual(
            value["files"]["installer/binaries.py"],
            config.checksum(bundle / "installer/binaries.py"),
        )
        runtime = config.read_json(bundle / "runtime.json")
        self.assertTrue(runtime["items"][1]["spec"]["suspend"])
        env = runtime["items"][0]["spec"]["template"]["spec"]["containers"][0]["env"]
        variables = {item["name"]: item["value"] for item in env}
        self.assertEqual(variables["NEWSLETTER_BOOTSTRAP_DRAIN_KEY"], "release-" + SHA)
        self.assertEqual(variables["CODEX_HOME"], "/var/lib/newsletter-auth")
        k3s_unit = (bundle / "units/k3s.service").read_text()
        self.assertIn("iptables-restore --noflush", k3s_unit)
        self.assertIn("ip6tables-restore --noflush", k3s_unit)
        self.assertNotIn("cloudflared.service", k3s_unit)
        connector_unit = (bundle / "units/cloudflared-platform.service").read_text()
        self.assertIn("Type=notify\n", connector_unit)
        self.assertIn("TimeoutStartSec=15\n", connector_unit)
        self.assertIn("DynamicUser=true", connector_unit)
        self.assertIn(
            "LoadCredential=connector-token:/etc/cloudflared/platform-token",
            connector_unit,
        )
        self.assertIn("--token-file %d/connector-token", connector_unit)
        self.assertNotIn("--token ", connector_unit)
        self.assertEqual(
            connector_unit.replace("@CLOUDFLARED@", str(binaries.CONNECTOR))
            .split("ExecStart=", 1)[1]
            .splitlines()[0],
            str(binaries.CONNECTOR)
            + " --no-autoupdate tunnel run --token-file %d/connector-token",
        )

    def test_unsupported_or_missing_connector_pin_is_refused(self):
        bundle = self.bundle()
        versions_path = bundle / "versions.json"
        manifest_path = bundle / "manifest.json"
        original = config.read_json(versions_path)
        for connector in (
            None,
            {},
            {"version": "2025.3.2", "linux_amd64_sha256": "a" * 64},
            {"version": "2026.8.2", "linux_amd64_sha256": "not-a-checksum"},
            {"version": "2026.8.2", "linux_amd64_sha256": "a" * 64, "url": "x"},
        ):
            with self.subTest(connector=connector):
                versions = {**original, "cloudflared": connector}
                versions_path.write_text(json.dumps(versions))
                manifest = config.read_json(manifest_path)
                manifest["files"]["versions.json"] = config.checksum(versions_path)
                manifest_path.write_text(json.dumps(manifest))
                with self.assertRaisesRegex(config.BootstrapError, "VERSIONS_INVALID"):
                    config.load_bundle(bundle)

    def test_rendered_daily_trigger_passes_the_real_client_configuration_contract(self):
        runtime = prepare.render(ROOT, SHA, IMAGES)
        daily = next(
            item
            for item in runtime["items"]
            if item["kind"] == "CronJob"
            and item["metadata"]["name"] == "newsletter-daily"
        )
        trigger = daily["spec"]["jobTemplate"]["spec"]["template"]["spec"][
            "containers"
        ][0]
        self.assertEqual(trigger["command"][0], "newsletter-trigger")
        environment = {
            "NEWSLETTER_EDITOR_TOKEN": "synthetic-editor-token-32-characters",
            "NEWSLETTER_SEND_TOKEN": "synthetic-sender-token-32-characters",
            "NEWSLETTER_ISSUE_DATE": "2026-09-05",
            "PYTHONNOUSERSITE": "1",
            **{item["name"]: item["value"] for item in trigger["env"]},
        }
        # The trigger is deliberately stdlib-only. Run its actual argument parser and
        # Config.from_args in this locked Python environment, without importing an
        # application into Platform. Check-only exits before any provider or send call;
        # deny socket creation as an independent guard against accidental network use.
        script = """
import runpy
import socket
import sys
from unittest.mock import patch
trigger = runpy.run_path(sys.argv[1], run_name="newsletter_trigger_contract")
with patch.object(socket, "socket", side_effect=AssertionError("Network use is forbidden")):
    trigger["main"](sys.argv[2:])
"""
        command = [
            sys.executable,
            "-c",
            script,
            str(ROOT / "newsletter/src/newsletter/trigger.py"),
            *trigger["command"][1:],
            "--check-config",
        ]
        result = subprocess.run(
            command,
            env=environment,
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout), {"configuration": "valid", "send_enabled": True}
        )
        for invalid in ("true", "0"):
            with self.subTest(internal_http=invalid):
                result = subprocess.run(
                    command,
                    env={**environment, "NEWSLETTER_ALLOW_INTERNAL_HTTP": invalid},
                    capture_output=True,
                    text=True,
                    timeout=10,
                    check=False,
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(
                    "NEWSLETTER_SERVICE_URL must be a fixed HTTPS origin", result.stderr
                )

    def test_bootstrap_and_daemon_keep_canonical_paths_under_another_host_state_root(
        self,
    ):
        root = self.base / "profile"
        (root / "config").mkdir(parents=True)
        profile = (
            (ROOT / "config/cloud.toml")
            .read_text()
            .replace('state_root = "/srv/todofy"', 'state_root = "/srv/alternate"')
            .replace('repository = "ziyixi/todofy"', 'repository = "example/project"')
        )
        (root / "config/cloud.toml").write_text(profile)
        for directory in ("platform", "newsletter"):
            (root / directory).symlink_to(ROOT / directory, target_is_directory=True)
        images = {
            name: value.replace("ghcr.io/ziyixi/", "ghcr.io/example/")
            for name, value in IMAGES.items()
        }
        normal = prepare.render(root, SHA, images)
        bundle = self.base / "full-bundle"
        prepare.prepare(root, SHA, images, bundle)
        initial = config.read_json(bundle / "runtime.json")
        runtime_config = next(
            item["data"]["runtime.json"]
            for item in normal["items"]
            if item["metadata"]["name"] == "platform-runtime-config"
        )
        targets = tuple(
            pb.ReleaseTarget(
                workload_key="platform-runtime" if service == "platform" else service,
                source_sha=SHA,
                image_digest=images[service].split("@", 1)[1],
                request_id=item["data"]["request_id"],
            )
            for service in ("newsletter", "platform")
            for item in normal["items"]
            if item["kind"] == "ConfigMap"
            and item["metadata"]["name"] == service + "-release"
        )
        applied = {
            "items": Renderer(configuration(runtime_config), asset=normal).render(
                targets, targets[0].request_id
            )
        }
        for stage, runtime in (
            ("normal", normal),
            ("bootstrap", initial),
            ("first_daemon_apply", applied),
        ):
            with self.subTest(stage=stage):
                container = newsletter_container(runtime)
                env = {item["name"]: item.get("value") for item in container["env"]}
                self.assertEqual({key: env.get(key) for key in PATHS}, PATHS)
                mounts = {
                    item["name"]: item["mountPath"]
                    for item in container["volumeMounts"]
                }
                self.assertEqual(
                    mounts,
                    {
                        "data": PATHS["NEWSLETTER_DATA_DIR"],
                        "auth": PATHS["NEWSLETTER_CODEX_HOME"],
                        "config": PATHS["NEWSLETTER_CONTENT_CONFIG_DIR"],
                    },
                )
                sync = next(
                    item
                    for item in runtime["items"]
                    if item["metadata"]["name"] == "newsletter-config-sync"
                )["spec"]["template"]["spec"]
                initializer = sync["initContainers"][0]
                self.assertEqual(initializer["image"], images["newsletter"])
                self.assertEqual(sync["containers"][0]["image"], initializer["image"])
                self.assertEqual(
                    initializer["command"],
                    ["python", "-m", "newsletter.config_sync", "initialize"],
                )
                self.assertEqual(
                    {item["name"]: item["value"] for item in initializer["env"]},
                    {
                        "NEWSLETTER_CONFIG_REPOSITORY": "example/project",
                        "NEWSLETTER_CONTENT_CONFIG_DIR": PATHS[
                            "NEWSLETTER_CONTENT_CONFIG_DIR"
                        ],
                    },
                )
                self.assertEqual(
                    initializer["volumeMounts"], sync["containers"][0]["volumeMounts"]
                )
                observer = next(
                    item
                    for item in runtime["items"]
                    if item["metadata"]["name"] == "platform-observer"
                )["spec"]["jobTemplate"]["spec"]["template"]["spec"]
                self.assertEqual(
                    [
                        item["image"]
                        for item in (
                            *observer["initContainers"],
                            *observer["containers"],
                        )
                    ],
                    [images["platform"], images["platform"]],
                )
                self.assertEqual(
                    observer["initContainers"][0]["securityContext"]["runAsUser"], 65534
                )
                self.assertNotIn("env", observer["initContainers"][0])
                self.assertFalse(observer["automountServiceAccountToken"])
        foundation = config.read_json(bundle / "foundation.json")
        for item in foundation["items"]:
            if item["kind"] == "PersistentVolume":
                self.assertTrue(
                    item["spec"]["hostPath"]["path"].startswith("/srv/alternate/")
                )

    def test_unverified_image_is_refused_before_any_output_is_created(self):
        output = self.base / "rejected"
        images = {**IMAGES, "platform": "ghcr.io/ziyixi/todofy-platform:latest"}
        with self.assertRaises(ValueError):
            prepare.prepare(ROOT, SHA, images, output)
        self.assertFalse(output.exists())

    def test_bundle_tampering_is_refused(self):
        bundle = self.bundle()
        (bundle / "runtime.json").write_text("{}")
        with self.assertRaisesRegex(config.BootstrapError, "BUNDLE_HASH_MISMATCH"):
            config.load_bundle(bundle)

    def test_foundation_substitutes_every_namespace_and_persistent_path(self):
        profile = {"vps": {"namespace": "fresh-cloud", "state_root": "/srv/fresh"}}
        resources = prepare.foundation(ROOT, profile)["items"]
        for resource in resources:
            if resource["kind"] == "Namespace":
                self.assertEqual(resource["metadata"]["name"], "fresh-cloud")
            if "namespace" in resource["metadata"]:
                self.assertEqual(resource["metadata"]["namespace"], "fresh-cloud")
            for subject in resource.get("subjects", []):
                self.assertEqual(subject["namespace"], "fresh-cloud")
            if resource["kind"] == "PersistentVolume":
                self.assertEqual(
                    resource["spec"]["claimRef"]["namespace"], "fresh-cloud"
                )
                self.assertTrue(
                    resource["spec"]["hostPath"]["path"].startswith("/srv/fresh/")
                )

    def test_credentials_are_owner_only_and_precisely_scoped(self):
        path, value = self.private()
        allowed = prepare.allowed_keys(ROOT)
        self.assertEqual(config.credentials(path, allowed), value)
        path.chmod(0o644)
        with self.assertRaisesRegex(
            config.BootstrapError, "CREDENTIAL_FILE_NOT_PRIVATE"
        ):
            config.credentials(path, allowed)
        path.chmod(0o600)
        for key in ("HOME", "OPENAI_API_KEY", "NEWSLETTER_CODEX_HOME"):
            changed = json.loads(json.dumps(value))
            changed["newsletter_env"][key] = "private-value"
            path.write_text(json.dumps(changed))
            with self.assertRaisesRegex(
                config.BootstrapError, "CREDENTIAL_ENV_INVALID"
            ):
                config.credentials(path, allowed)

    def test_monitor_has_a_distinct_identity_and_shared_trigger_auth_is_preserved(self):
        path, value = self.private()
        value["newsletter_env"]["NEWSLETTER_MONITOR_TOKEN"] = value["platform_env"][
            "PLATFORM_DEPLOY_TOKEN"
        ]
        path.write_text(json.dumps(value))
        with self.assertRaisesRegex(
            config.BootstrapError, "MONITOR_IDENTITY_NOT_DISTINCT"
        ):
            config.credentials(path, prepare.allowed_keys(ROOT))

    def test_runtime_rejected_machine_credentials_fail_bootstrap_preflight(self):
        cases = (
            ("missing_editor", None, "NEWSLETTER_EDITOR_CREDENTIAL_INVALID"),
            ("short_editor", "e" * 23, "NEWSLETTER_EDITOR_CREDENTIAL_INVALID"),
            ("long_editor", "e" * 513, "NEWSLETTER_EDITOR_CREDENTIAL_INVALID"),
            (
                "editor_whitespace",
                "e" * 24 + " ",
                "NEWSLETTER_EDITOR_CREDENTIAL_INVALID",
            ),
            ("editor_equals_send", "s" * 40, "NEWSLETTER_EDITOR_IDENTITY_NOT_DISTINCT"),
            ("platform_equals_send", "s" * 40, "PLATFORM_IDENTITY_NOT_DISTINCT"),
        )
        for case, invalid, code in cases:
            with self.subTest(case=case):
                path, value = self.private()
                if case == "platform_equals_send":
                    value["platform_env"]["PLATFORM_DEPLOY_TOKEN"] = invalid
                elif invalid is None:
                    value["newsletter_env"].pop("NEWSLETTER_EDITOR_TOKEN")
                    value["trigger_env"].pop("NEWSLETTER_EDITOR_TOKEN")
                else:
                    value["newsletter_env"]["NEWSLETTER_EDITOR_TOKEN"] = invalid
                    value["trigger_env"]["NEWSLETTER_EDITOR_TOKEN"] = invalid
                path.write_text(json.dumps(value))
                with self.assertRaisesRegex(config.BootstrapError, code):
                    config.credentials(path, prepare.allowed_keys(ROOT))

    def test_migration_copies_opaque_state_without_deleting_source(self):
        source = self.base / "original"
        source.mkdir()
        (source / "opaque.db").write_bytes(b"synthetic private bytes")
        destination = self.base / "state"
        with (
            patch.object(host, "stopped_sources"),
            patch.object(os, "chown"),
            patch.object(os, "fchown"),
        ):
            host.migrate(destination, {"data": source}, SHA)
            host.migrate(destination, {"data": source}, SHA)
        self.assertEqual(
            (source / "opaque.db").read_bytes(), b"synthetic private bytes"
        )
        self.assertEqual(
            (destination / "newsletter/data/opaque.db").read_bytes(),
            b"synthetic private bytes",
        )
        self.assertEqual((destination / "platform").stat().st_mode & 0o777, 0o700)
        self.assertEqual((destination / "observer").stat().st_mode & 0o777, 0o700)
        self.assertEqual(
            (destination / ".bootstrap-state.json").stat().st_mode & 0o777, 0o600
        )

    def test_migration_refuses_unknown_destination_and_symlinked_sources(self):
        destination = self.base / "state/newsletter/data"
        destination.mkdir(parents=True)
        sentinel = destination / "existing"
        sentinel.write_text("preserve")
        with (
            patch.object(os, "chown"),
            self.assertRaisesRegex(config.BootstrapError, "DESTINATION_STATE_CONFLICT"),
        ):
            host.migrate(self.base / "state", {}, SHA)
        self.assertEqual(sentinel.read_text(), "preserve")
        source = self.base / "linked"
        source.symlink_to(destination, target_is_directory=True)
        with self.assertRaisesRegex(config.BootstrapError, "HOST_SYMLINK_REFUSED"):
            host.migrate(self.base / "other-state", {"data": source}, SHA)

    def test_running_container_check_reads_only_mount_metadata(self):
        source = self.base / "source"
        responses = [
            CompletedProcess([], 0, b"abcdef\n", b""),
            CompletedProcess(
                [], 0, json.dumps([{"Source": str(source)}]).encode(), b""
            ),
        ]
        with (
            patch.object(shutil, "which", return_value="/usr/bin/docker"),
            patch.object(host, "command", side_effect=responses) as command,
            self.assertRaisesRegex(
                config.BootstrapError, "LEGACY_CONTAINER_STILL_RUNNING"
            ),
        ):
            host.stopped_sources([source])
        self.assertEqual(
            command.call_args_list[1].args[0][2:4], ["--format", "{{json .Mounts}}"]
        )

    def test_firewall_owns_one_chain_and_never_changes_ssh_or_existing_chains(self):
        for ipv6 in (False, True):
            rules = firewall.rules(ipv6, include_jump=True).decode()
            self.assertIn("-F PCLOUD-K3S", rules)
            self.assertNotIn("-F INPUT", rules)
            self.assertNotIn("--dport 22", rules)
            self.assertIn("6443,10250", rules)
            self.assertIn("--dport 8472", rules)
            self.assertEqual("10.42.0.0/16" in rules, not ipv6)
        result = CompletedProcess([], 0, b"-A PCLOUD-K3S -j ACCEPT\n", b"")
        with (
            patch.object(firewall, "command", return_value=result),
            self.assertRaisesRegex(config.BootstrapError, "FOREIGN_FIREWALL_CHAIN"),
        ):
            firewall.install()

    def test_secrets_use_private_stdin_and_same_ssa_manager_as_normal_releases(self):
        _, private = self.private()
        with patch.object(cluster, "kubectl") as kubectl:
            cluster.secrets(
                {"namespace": "personal-cloud", "fleet_host": "fleet.example.com"},
                private,
            )
        args = kubectl.call_args.args[0]
        self.assertEqual(
            args,
            ["apply", "--server-side", "--field-manager=personal-cloud", "-f", "-"],
        )
        self.assertNotIn(private["fleet_key"], " ".join(args))
        payload = json.loads(kubectl.call_args.kwargs["data"])
        self.assertEqual(len(payload["items"]), 4)
        self.assertTrue(
            all(resource["kind"] == "Secret" for resource in payload["items"])
        )

    def test_orchestration_verifies_inputs_before_writes_and_finishes_held(self):
        bundle = self.bundle()
        private_path, _ = self.private()
        order = []
        mocks = []
        functions = [
            (host, "bootstrap_completed", False),
            (install, "preflight", str(binaries.CONNECTOR)),
            (binaries, "install_connector", None),
            (host, "migrate", None),
            (host, "retire_legacy_runtime", None),
            (observer_policy, "install", None),
            (firewall, "install", None),
            (cluster, "start", None),
            (cluster, "apply", None),
            (cluster, "secrets", None),
            (cluster, "held_runtime", None),
            (cluster, "services", None),
            (host, "complete_bootstrap", None),
        ]
        with contextlib.ExitStack() as stack:
            stack.enter_context(patch.object(os, "geteuid", return_value=0))
            for module, name, result in functions:

                def invoke(*args, _name=name, _result=result, **kwargs):
                    order.append(_name)
                    return _result

                mocks.append(
                    stack.enter_context(patch.object(module, name, side_effect=invoke))
                )
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                install.install(bundle, private_path)
        self.assertEqual(order, [name for _, name, _ in functions])
        events = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(events[-1]["status"], "complete_held")
        self.assertTrue(
            all(set(event) == {"event", "phase", "status"} for event in events)
        )

    def test_completed_bootstrap_is_a_noop_after_release_activation(self):
        bundle = self.bundle()
        output = io.StringIO()
        mutations = (
            (install, "credentials"),
            (install, "preflight"),
            (binaries, "install_connector"),
            (host, "migrate"),
            (host, "retire_legacy_runtime"),
            (observer_policy, "install"),
            (firewall, "install"),
            (cluster, "start"),
            (cluster, "apply"),
            (cluster, "secrets"),
            (cluster, "held_runtime"),
            (cluster, "services"),
            (host, "complete_bootstrap"),
        )
        with (
            contextlib.ExitStack() as stack,
            patch.object(os, "geteuid", return_value=0),
            patch.object(host, "bootstrap_completed", return_value=True) as completed,
            contextlib.redirect_stdout(output),
        ):
            for module, name in mutations:
                stack.enter_context(
                    patch.object(module, name, side_effect=AssertionError(name))
                )
            install.install(bundle, self.base / "removed-credentials.json")
        completed.assert_called_once_with(config.checksum(bundle / "manifest.json"))
        self.assertEqual(
            json.loads(output.getvalue()),
            {
                "event": "vps_bootstrap",
                "phase": "bootstrap",
                "status": "already_initialized",
            },
        )

    def test_services_failure_does_not_mark_success_and_same_bundle_can_retry(self):
        bundle = self.bundle()
        private_path, _ = self.private()
        functions = (
            (install, "preflight", str(binaries.CONNECTOR)),
            (binaries, "install_connector", None),
            (host, "migrate", None),
            (host, "retire_legacy_runtime", None),
            (observer_policy, "install", None),
            (firewall, "install", None),
            (cluster, "start", None),
            (cluster, "apply", None),
            (cluster, "secrets", None),
            (cluster, "held_runtime", None),
        )
        with (
            contextlib.ExitStack() as stack,
            patch.object(os, "geteuid", return_value=0),
            patch.object(host, "bootstrap_completed", return_value=False),
            patch.object(host, "complete_bootstrap") as complete,
            patch.object(
                cluster,
                "services",
                side_effect=[config.BootstrapError("SYNTHETIC_FAILURE"), None],
            ) as services,
            contextlib.redirect_stdout(io.StringIO()),
        ):
            for module, name, result in functions:
                stack.enter_context(patch.object(module, name, return_value=result))
            with self.assertRaisesRegex(config.BootstrapError, "SYNTHETIC_FAILURE"):
                install.install(bundle, private_path)
            complete.assert_not_called()
            install.install(bundle, private_path)
        self.assertEqual(services.call_count, 2)
        complete.assert_called_once_with(config.checksum(bundle / "manifest.json"))

    def test_connector_ready_failure_prevents_marker_until_retry_succeeds(self):
        bundle = self.bundle()
        private_path, _ = self.private()
        connector_directory = self.base / "cloudflared"
        connector_directory.mkdir()
        functions = (
            (install, "preflight", str(binaries.CONNECTOR)),
            (binaries, "install_connector", None),
            (host, "migrate", None),
            (host, "retire_legacy_runtime", None),
            (observer_policy, "install", None),
            (firewall, "install", None),
            (cluster, "start", None),
            (cluster, "apply", None),
            (cluster, "secrets", None),
            (cluster, "held_runtime", None),
        )

        def path(value):
            if value == "/etc/cloudflared":
                return connector_directory
            return Path(value)

        with (
            contextlib.ExitStack() as stack,
            patch.object(os, "geteuid", return_value=0),
            patch.object(host, "bootstrap_completed", return_value=False),
            patch.object(host, "complete_bootstrap") as complete,
            patch.object(cluster, "Path", side_effect=path),
            patch.object(cluster, "write_file"),
            patch.object(
                cluster,
                "command",
                side_effect=[
                    None,
                    config.BootstrapError("SYSTEM_COMMAND_FAILED"),
                    None,
                    None,
                ],
            ) as command,
            contextlib.redirect_stdout(io.StringIO()),
        ):
            for module, name, result in functions:
                stack.enter_context(patch.object(module, name, return_value=result))
            with self.assertRaisesRegex(config.BootstrapError, "SYSTEM_COMMAND_FAILED"):
                install.install(bundle, private_path)
            complete.assert_not_called()
            startup = command.call_args_list[-1]
            self.assertEqual(
                startup.args[0],
                ["systemctl", "enable", "--now", "cloudflared-platform.service"],
            )
            self.assertGreater(startup.kwargs["timeout"], 15)
            install.install(bundle, private_path)
        complete.assert_called_once_with(config.checksum(bundle / "manifest.json"))

    def test_completion_marker_is_atomic_root_owned_and_rejects_other_bundles(self):
        marker = self.base / "completion.json"
        original_stat = Path.stat
        marker_owner = 0

        def stat(path, *, follow_symlinks=True):
            attributes = original_stat(path, follow_symlinks=follow_symlinks)
            if path == marker:
                values = list(attributes)
                values[4] = marker_owner
                return os.stat_result(values)
            return attributes

        with (
            patch.object(host, "COMPLETION_MARKER", marker),
            patch.object(os, "fchown") as ownership,
        ):
            self.assertFalse(host.bootstrap_completed("a" * 64))
            host.complete_bootstrap("a" * 64)
            ownership.assert_called_once()
            self.assertEqual(ownership.call_args.args[1:], (0, 0))
            self.assertEqual(marker.stat().st_mode & 0o777, 0o600)
            self.assertFalse(list(self.base.glob(".personal-cloud-*")))
            with patch.object(Path, "stat", stat):
                self.assertTrue(host.bootstrap_completed("a" * 64))
                with self.assertRaisesRegex(
                    config.BootstrapError,
                    "BOOTSTRAP_ALREADY_INITIALIZED_DIFFERENT_BUNDLE",
                ):
                    host.bootstrap_completed("b" * 64)
                marker_owner = 10001
                with self.assertRaisesRegex(
                    config.BootstrapError, "BOOTSTRAP_COMPLETION_MARKER_INVALID"
                ):
                    host.bootstrap_completed("a" * 64)
                marker_owner = 0
                marker.chmod(0o644)
                with self.assertRaisesRegex(
                    config.BootstrapError, "BOOTSTRAP_COMPLETION_MARKER_INVALID"
                ):
                    host.bootstrap_completed("a" * 64)

    def test_legacy_units_are_disabled_after_preservation_without_removing_state(self):
        responses = [
            CompletedProcess([], 0, b"loaded\n", b""),
            CompletedProcess([], 1, b"not-found\n", b""),
            CompletedProcess([], 0, b"", b""),
        ]
        with patch.object(host, "command", side_effect=responses) as command:
            host.retire_legacy_runtime()
        self.assertEqual(
            command.call_args_list[-1].args[0],
            ["systemctl", "disable", "--now", "docker.socket"],
        )
        self.assertTrue(
            all("rm" not in call.args[0] for call in command.call_args_list)
        )


if __name__ == "__main__":
    unittest.main()

"""Synthetic bootstrap boundaries. Never install a service or contact a cluster."""

import contextlib
import io
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from subprocess import CompletedProcess
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "tools/vps-bootstrap"))

import cluster
import firewall
import host
import install
import prepare

import config

SHA = "a" * 40
IMAGES = {
    "newsletter": "ghcr.io/ziyixi/todofy-newsletter@sha256:" + "b" * 64,
    "platform": "ghcr.io/ziyixi/todofy-platform@sha256:" + "c" * 64,
}


class BootstrapTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name).resolve()

    def bundle(self):
        output = self.base / "public-bundle"
        runtime = {
            "apiVersion": "v1",
            "kind": "List",
            "items": [
                {
                    "kind": "Deployment",
                    "metadata": {"name": "newsletter"},
                    "spec": {
                        "template": {
                            "spec": {
                                "containers": [
                                    {
                                        "env": [
                                            {
                                                "name": "NEWSLETTER_BOOTSTRAP_DRAIN_KEY",
                                                "value": "release-" + SHA,
                                            }
                                        ]
                                    }
                                ]
                            }
                        }
                    },
                },
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
        self.assertIn("DynamicUser=true", connector_unit)
        self.assertIn(
            "LoadCredential=connector-token:/etc/cloudflared/platform-token",
            connector_unit,
        )
        self.assertIn("--token-file %d/connector-token", connector_unit)

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
            (install, "preflight", "/usr/bin/cloudflared"),
            (host, "migrate", None),
            (host, "retire_legacy_runtime", None),
            (firewall, "install", None),
            (cluster, "start", None),
            (cluster, "apply", None),
            (cluster, "secrets", None),
            (cluster, "held_runtime", None),
            (cluster, "services", None),
        ]
        with contextlib.ExitStack() as stack:
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

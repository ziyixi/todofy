"""Pinned host policy and bounded installer checks; never load a kernel profile."""

import hashlib
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import call, patch

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "tools/vps-bootstrap"))

import observer_policy as policy

from config import BootstrapError

SOURCE = ROOT / "platform/apparmor" / policy.PROFILE


class ObserverPolicyTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name).resolve()
        self.bundle = self.base / "bundle"
        (self.bundle / "units").mkdir(parents=True)
        self.source = self.bundle / "units" / policy.PROFILE
        self.content = SOURCE.read_bytes()
        self.source.write_bytes(self.content)
        self.destination = self.base / "host" / policy.PROFILE
        self.destination.parent.mkdir()
        self.enabled = self.base / "enabled"
        self.enabled.write_text("Y\n")
        self.profiles = self.base / "profiles"
        self.profiles.write_text("containerd-default (enforce)\n")

    def environment(self):
        return (
            patch.object(policy.os, "geteuid", return_value=0),
            patch.object(policy.platform, "system", return_value="Linux"),
            patch.object(
                policy.platform,
                "freedesktop_os_release",
                return_value={"ID": "ubuntu", "VERSION_ID": "24.04"},
            ),
            patch.object(policy, "DESTINATION", self.destination),
            patch.object(policy, "ENABLED", self.enabled),
            patch.object(policy, "PROFILES", self.profiles),
            patch.object(
                policy, "secure_path", side_effect=lambda path, **kwargs: Path(path)
            ),
        )

    def enter_environment(self):
        for manager in self.environment():
            self.enterContext(manager)

    def test_baseline_and_exact_send_only_methods_are_pinned(self):
        self.assertEqual(
            hashlib.sha256(self.content).hexdigest(), policy.PROFILE_SHA256
        )
        text = self.content.decode()
        rules = [
            line.strip()
            for line in text.splitlines()
            if line.lstrip().startswith("dbus")
        ]
        self.assertEqual(len(rules), 7)
        self.assertTrue(
            all(
                rule.startswith("dbus (send) bus=system path=/org/freedesktop/")
                for rule in rules
            )
        )
        self.assertNotIn("member=GetAll", text)
        self.assertNotIn("member=Set", text)
        self.assertNotIn("dbus (receive", text)
        self.assertIn("deny mount,", text)
        self.assertIn("deny /sys/kernel/security/** rwklx,", text)
        for unit in ("k3s", "cloudflared", "ssh", "cloudflared_2dplatform"):
            self.assertIn(
                "path=/org/freedesktop/systemd1/unit/" + unit + "_2eservice", text
            )

    def test_syntax_failure_cannot_write_or_load_profile(self):
        self.enter_environment()

        def command(argv, **kwargs):
            if "--skip-kernel-load" in argv:
                raise BootstrapError("SYSTEM_COMMAND_FAILED")

        with (
            patch.object(policy, "command", side_effect=command),
            patch.object(policy.host, "write_file") as writer,
            self.assertRaises(BootstrapError),
        ):
            policy.install(self.bundle)
        writer.assert_not_called()
        self.assertFalse(self.destination.exists())

    def test_install_only_loads_profile_after_stdin_compile_without_service_restart(
        self,
    ):
        self.enter_environment()

        def command(argv, **kwargs):
            if "--replace" in argv:
                self.profiles.write_text(policy.PROFILE + " (enforce)\n")

        def write_file(path, content, **kwargs):
            self.assertEqual(kwargs, {"mode": 0o644})
            path.write_bytes(content)

        with (
            patch.object(policy, "command", side_effect=command) as commands,
            patch.object(policy.host, "write_file", side_effect=write_file) as writer,
        ):
            policy.install(self.bundle)
        writer.assert_called_once_with(self.destination, self.content, mode=0o644)
        self.assertEqual(
            commands.call_args_list,
            [
                call(["systemctl", "is-active", "--quiet", "apparmor.service"]),
                call(["systemctl", "is-enabled", "--quiet", "apparmor.service"]),
                call(
                    [
                        str(policy.PARSER),
                        "--skip-kernel-load",
                        "--skip-cache",
                        "--quiet",
                    ],
                    data=self.content,
                ),
                call(
                    [
                        str(policy.PARSER),
                        "--replace",
                        "--skip-cache",
                        "--quiet",
                        str(self.destination),
                    ]
                ),
            ],
        )

    def test_foreign_source_or_destination_is_never_overwritten(self):
        self.enter_environment()
        for target in (self.source, self.destination):
            with self.subTest(target=target.name):
                self.source.write_bytes(self.content)
                self.destination.unlink(missing_ok=True)
                target.write_bytes(b"foreign policy")
                with (
                    patch.object(policy, "command") as commands,
                    patch.object(policy.host, "write_file") as writer,
                    self.assertRaises(BootstrapError),
                ):
                    policy.install(self.bundle)
                writer.assert_not_called()
                commands.assert_not_called()
                self.assertEqual(target.read_bytes(), b"foreign policy")

    def test_same_name_kernel_profile_without_known_file_is_refused_in_any_mode(self):
        self.enter_environment()
        for mode in ("enforce", "complain"):
            self.profiles.write_text(policy.PROFILE + " (" + mode + ")\n")
            with (
                patch.object(policy, "command") as commands,
                patch.object(policy.host, "write_file") as writer,
                self.assertRaisesRegex(BootstrapError, "FOREIGN_OBSERVER_POLICY"),
            ):
                policy.install(self.bundle)
            writer.assert_not_called()
            commands.assert_not_called()

    def test_known_file_is_reused_and_exact_enforce_mode_is_required(self):
        self.enter_environment()
        self.destination.write_bytes(self.content)
        with (
            patch.object(policy, "command"),
            patch.object(policy.host, "write_file") as writer,
            self.assertRaisesRegex(BootstrapError, "OBSERVER_POLICY_NOT_ENFORCING"),
        ):
            policy.install(self.bundle)
        writer.assert_not_called()

    def test_secure_path_rejects_foreign_owner_writable_mode_or_symlink(self):
        for uid, gid, mode in (
            (10001, 0, 0o644),
            (0, 10001, 0o644),
            (0, 0, 0o664),
            (0, 0, 0o600),
        ):
            with (
                patch.object(
                    Path,
                    "stat",
                    return_value=SimpleNamespace(
                        st_uid=uid, st_gid=gid, st_mode=0o100000 | mode
                    ),
                ),
                self.assertRaisesRegex(BootstrapError, "OBSERVER_POLICY_PATH_INVALID"),
            ):
                policy.secure_path(self.source, mode=0o644)
        self.source.unlink()
        self.source.symlink_to(self.base / "missing")
        with self.assertRaisesRegex(BootstrapError, "HOST_SYMLINK_REFUSED"):
            policy.secure_path(self.source)


if __name__ == "__main__":
    unittest.main()

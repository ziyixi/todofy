"""Pinned host tools use synthetic downloads and isolated paths, never real services."""

import contextlib
import hashlib
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "tools/vps-bootstrap"))

import binaries
import cluster
import host
import install

import config

CONTENT = b"synthetic official connector executable"
EXPECTED = hashlib.sha256(CONTENT).hexdigest()
VERSIONS = {"cloudflared": {"version": "2026.8.2", "linux_amd64_sha256": EXPECTED}}


class Response(io.BytesIO):
    def geturl(self):
        return "https://release-assets.githubusercontent.com/synthetic-public-asset"


class BinaryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name).resolve()
        self.base.chmod(0o755)
        self.connector = self.base / "usr/local/libexec/personal-cloud/cloudflared"

    @contextlib.contextmanager
    def synthetic_root(self, *, unsafe=None, owner=0, mode=None):
        original_stat = Path.stat

        def stat(path, *, follow_symlinks=True):
            values = list(original_stat(path, follow_symlinks=follow_symlinks))
            values[4] = owner if path == unsafe else 0
            if path == unsafe and mode is not None:
                values[0] = (values[0] & ~0o7777) | mode
            if path != self.base and self.base not in path.parents:
                values[0] &= ~0o022
                values[0] |= 0o001
            return os.stat_result(values)

        with (
            patch.object(binaries, "CONNECTOR", self.connector),
            patch.object(Path, "stat", stat),
            patch.object(os, "chown"),
            patch.object(os, "fchown"),
        ):
            yield

    def download(self, content=CONTENT):
        opener = Mock()
        opener.open.return_value = Response(content)
        return opener

    def test_fresh_host_downloads_only_the_pinned_dedicated_connector_and_reuses_it(
        self,
    ):
        global_binary = self.base / "usr/bin/cloudflared"
        global_binary.parent.mkdir(parents=True)
        global_binary.write_bytes(b"existing SSH connector")
        ssh_unit = self.base / "existing-ssh.service"
        ssh_unit.write_bytes(b"existing independent SSH unit")
        opener = self.download()
        with (
            self.synthetic_root(),
            patch.object(binaries.urllib.request, "build_opener", return_value=opener),
        ):
            self.assertEqual(
                binaries.connector_preflight(VERSIONS), str(self.connector)
            )
            self.assertFalse(self.connector.exists())
            binaries.install_connector(VERSIONS)
            inode = self.connector.stat().st_ino
            with patch.object(
                host, "write_file", side_effect=AssertionError("rewrite")
            ):
                binaries.install_connector(VERSIONS)
            self.assertEqual(self.connector.stat().st_ino, inode)
        opener.open.assert_called_once_with(
            "https://github.com/cloudflare/cloudflared/releases/download/2026.8.2/"
            "cloudflared-linux-amd64",
            timeout=30,
        )
        self.assertEqual(self.connector.read_bytes(), CONTENT)
        self.assertEqual(self.connector.stat().st_mode & 0o777, 0o755)
        self.assertEqual(global_binary.read_bytes(), b"existing SSH connector")
        self.assertEqual(ssh_unit.read_bytes(), b"existing independent SSH unit")
        self.assertFalse(list(self.connector.parent.glob(".personal-cloud-*")))

    def test_foreign_existing_connector_is_rejected_before_download_without_overwrite(
        self,
    ):
        self.connector.parent.mkdir(parents=True)
        self.connector.write_bytes(b"foreign installation")
        self.connector.chmod(0o755)
        with (
            self.synthetic_root(),
            patch.object(binaries.urllib.request, "build_opener") as network,
            self.assertRaisesRegex(config.BootstrapError, "FOREIGN_PLATFORM_CONNECTOR"),
        ):
            binaries.install_connector(VERSIONS)
        network.assert_not_called()
        self.assertEqual(self.connector.read_bytes(), b"foreign installation")

    def test_existing_connector_requires_root_owner_and_exact_executable_mode(self):
        self.connector.parent.mkdir(parents=True)
        self.connector.write_bytes(CONTENT)
        self.connector.chmod(0o755)
        with (
            self.synthetic_root(unsafe=self.connector, owner=10001),
            self.assertRaisesRegex(config.BootstrapError, "FOREIGN_PLATFORM_CONNECTOR"),
        ):
            binaries.connector_preflight(VERSIONS)
        for mode in (0o644, 0o775, 0o4755):
            with self.subTest(mode=mode):
                self.connector.chmod(mode)
                with (
                    self.synthetic_root(unsafe=self.connector, mode=mode),
                    self.assertRaisesRegex(
                        config.BootstrapError, "FOREIGN_PLATFORM_CONNECTOR"
                    ),
                ):
                    binaries.connector_preflight(VERSIONS)

    def test_existing_connector_directory_is_never_adopted_or_permission_changed(self):
        self.connector.parent.mkdir(parents=True)
        with (
            self.synthetic_root(unsafe=self.connector.parent, owner=10001),
            patch.object(host, "directory") as directory,
            self.assertRaisesRegex(
                config.BootstrapError, "CONNECTOR_DIRECTORY_INVALID"
            ),
        ):
            binaries.install_connector(VERSIONS)
        directory.assert_not_called()
        for mode in (0o777, 0o700):
            with self.subTest(mode=mode):
                self.connector.parent.chmod(mode)
                with (
                    self.synthetic_root(),
                    self.assertRaisesRegex(
                        config.BootstrapError, "CONNECTOR_DIRECTORY_INVALID"
                    ),
                ):
                    binaries.connector_preflight(VERSIONS)
                self.assertEqual(self.connector.parent.stat().st_mode & 0o777, mode)

    def test_symlinked_and_broken_connector_paths_are_refused(self):
        self.connector.parent.mkdir(parents=True)
        self.connector.symlink_to(self.base / "missing")
        with (
            self.synthetic_root(),
            self.assertRaisesRegex(config.BootstrapError, "HOST_SYMLINK_REFUSED"),
        ):
            binaries.connector_preflight(VERSIONS)
        self.connector.unlink()
        self.connector.parent.rmdir()
        self.connector.parent.symlink_to(self.base, target_is_directory=True)
        with (
            self.synthetic_root(),
            self.assertRaisesRegex(config.BootstrapError, "HOST_SYMLINK_REFUSED"),
        ):
            binaries.connector_preflight(VERSIONS)

    def test_checksum_failure_leaves_no_binary_or_download_staging_file(self):
        self.connector.parent.mkdir(parents=True)
        with (
            self.synthetic_root(),
            patch.object(
                binaries.urllib.request,
                "build_opener",
                return_value=self.download(b"bad"),
            ),
            self.assertRaisesRegex(config.BootstrapError, "BINARY_CHECKSUM_MISMATCH"),
        ):
            binaries.install_connector(VERSIONS)
        self.assertFalse(self.connector.exists())
        self.assertFalse(list(self.connector.parent.glob(".personal-cloud-*")))

    def test_interrupted_download_leaves_no_staging_file(self):
        self.connector.parent.mkdir(parents=True)
        opener = self.download()
        opener.open.return_value.read = Mock(side_effect=TimeoutError("synthetic"))
        with (
            self.synthetic_root(),
            patch.object(binaries.urllib.request, "build_opener", return_value=opener),
            self.assertRaises(TimeoutError),
        ):
            binaries.install_connector(VERSIONS)
        self.assertFalse(self.connector.exists())
        self.assertFalse(list(self.connector.parent.glob(".personal-cloud-*")))

    def test_download_deadline_and_insecure_redirect_are_refused(self):
        self.connector.parent.mkdir(parents=True)
        opener = self.download()
        with (
            self.synthetic_root(),
            patch.object(binaries.urllib.request, "build_opener", return_value=opener),
            patch.object(binaries.time, "monotonic", side_effect=[0, 601]),
            self.assertRaisesRegex(config.BootstrapError, "BINARY_DOWNLOAD_TOO_LARGE"),
        ):
            binaries.install_connector(VERSIONS)
        opener = self.download()
        opener.open.return_value.geturl = Mock(return_value="http://insecure.example")
        with (
            self.synthetic_root(),
            patch.object(binaries.urllib.request, "build_opener", return_value=opener),
            self.assertRaisesRegex(config.BootstrapError, "BINARY_SOURCE_INVALID"),
        ):
            binaries.install_connector(VERSIONS)
        self.assertFalse(self.connector.exists())
        self.assertFalse(list(self.connector.parent.glob(".personal-cloud-*")))

    def test_oversized_download_is_rejected_before_writing_its_chunk(self):
        class OversizedChunk:
            def __len__(self):
                return 200 * 1024 * 1024 + 1

        self.connector.parent.mkdir(parents=True)
        opener = self.download()
        opener.open.return_value.read = Mock(return_value=OversizedChunk())
        with (
            self.synthetic_root(),
            patch.object(binaries.urllib.request, "build_opener", return_value=opener),
            self.assertRaisesRegex(config.BootstrapError, "BINARY_DOWNLOAD_TOO_LARGE"),
        ):
            binaries.install_connector(VERSIONS)
        self.assertFalse(self.connector.exists())
        self.assertFalse(list(self.connector.parent.glob(".personal-cloud-*")))

    def test_atomic_install_failure_removes_both_temporary_files(self):
        self.connector.parent.mkdir(parents=True)
        with (
            self.synthetic_root(),
            patch.object(
                binaries.urllib.request, "build_opener", return_value=self.download()
            ),
            patch.object(
                os, "replace", side_effect=OSError("synthetic replace failure")
            ),
            self.assertRaises(OSError),
        ):
            binaries.install_connector(VERSIONS)
        self.assertFalse(self.connector.exists())
        self.assertFalse(list(self.connector.parent.glob(".personal-cloud-*")))

    def test_download_cannot_overwrite_a_destination_created_while_reading(self):
        self.connector.parent.mkdir(parents=True)
        opener = self.download()

        def opening(*args, **kwargs):
            self.connector.write_bytes(b"preserve concurrent file")
            return Response(CONTENT)

        opener.open.side_effect = opening
        with (
            self.synthetic_root(),
            patch.object(binaries.urllib.request, "build_opener", return_value=opener),
            self.assertRaisesRegex(config.BootstrapError, "MANAGED_FILE_CONFLICT"),
        ):
            binaries.install_connector(VERSIONS)
        self.assertEqual(self.connector.read_bytes(), b"preserve concurrent file")
        self.assertFalse(list(self.connector.parent.glob(".personal-cloud-*")))

    def test_k3s_uses_the_same_downloader_with_its_existing_pin_and_error_identity(
        self,
    ):
        versions = {"k3s": {"version": "v1.37.1+k3s1", "linux_amd64_sha256": "a" * 64}}
        with patch.object(binaries, "pinned_binary") as downloader:
            cluster.pinned_binary(versions)
        downloader.assert_called_once_with(
            cluster.BINARY,
            "https://github.com/k3s-io/k3s/releases/download/v1.37.1%2Bk3s1/k3s",
            "a" * 64,
            "FOREIGN_K3S_INSTALLATION",
        )

    def test_preflight_succeeds_without_global_cloudflared_and_checks_its_own_unit(
        self,
    ):
        bundle = self.base / "bundle"
        (bundle / "units").mkdir(parents=True)
        (bundle / "versions.json").write_text(json.dumps(VERSIONS))
        for name in ("k3s.service", "cloudflared-platform.service", "k3s-config.yaml"):
            (bundle / "units" / name).write_text("ExecStart=@CLOUDFLARED@\n")
        mapped = self.base / "host"
        mapped.mkdir()

        def real_path(path):
            if str(path).startswith("/etc/"):
                return mapped / Path(path).name
            return Path(path)

        def which(name):
            self.assertNotEqual(name, "cloudflared")
            return "/usr/bin/" + name

        with (
            self.synthetic_root(),
            patch.object(os, "geteuid", return_value=0),
            patch.object(install.platform, "system", return_value="Linux"),
            patch.object(install.platform, "machine", return_value="x86_64"),
            patch.object(
                install.platform,
                "freedesktop_os_release",
                return_value={"ID": "ubuntu", "VERSION_ID": "24.04"},
            ),
            patch.object(install.shutil, "which", side_effect=which),
            patch.object(install.observer_policy, "preflight"),
            patch.object(host, "real_path", side_effect=real_path),
        ):
            self.assertEqual(install.preflight(bundle), str(self.connector))
            (mapped / "cloudflared-platform.service").write_text("foreign unit")
            with self.assertRaisesRegex(config.BootstrapError, "SYSTEM_UNIT_CONFLICT"):
                install.preflight(bundle)


if __name__ == "__main__":
    unittest.main()

"""Synthetic namespace grants and owner file IO; never contact a real Kubernetes API."""

import base64
import contextlib
import copy
import io
import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from subprocess import CompletedProcess
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "tools/vps-bootstrap"))

import reader

from config import BootstrapError

NAMESPACE = "personal-cloud"
CERTIFICATE = "-----BEGIN CERTIFICATE-----\nsynthetic-ca\n-----END CERTIFICATE-----\n"
CA = base64.b64encode(CERTIFICATE.encode()).decode()
TOKEN = "synthetic-reader-token." + "a" * 40
OLD_TOKEN = "synthetic-old-reader-token." + "b" * 40


class ReaderTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name).resolve()
        self.home_root = self.base / "home"
        self.home = self.home_root / "readeruser"
        self.home.mkdir(parents=True)
        self.home.chmod(0o750)
        self.directory = self.home / ".kube"
        self.path = self.directory / (reader.NAME + ".json")
        self.owner = SimpleNamespace(
            pw_name="readeruser", pw_uid=1000, pw_gid=1000, pw_dir=str(self.home)
        )
        self.calls = []
        self.existing = {}
        self.expiration = (
            (datetime.now(timezone.utc) + timedelta(hours=1))
            .replace(microsecond=0)
            .isoformat()
            .replace("+00:00", "Z")
        )
        self.token_response = {
            "status": {"token": TOKEN, "expirationTimestamp": self.expiration}
        }
        self.token_hook = None

    @contextlib.contextmanager
    def synthetic_owner(self, *, unsafe=None, uid=1000, mode=None):
        original_open, original_fstat = os.open, os.fstat
        paths = {}

        def open_file(name, flags, mode=0o777, *, dir_fd=None):
            descriptor = original_open(name, flags, mode, dir_fd=dir_fd)
            paths[descriptor] = (
                (paths[dir_fd] / name) if dir_fd is not None else Path(name)
            )
            return descriptor

        def file_stat(descriptor):
            values = list(original_fstat(descriptor))
            values[4] = uid if paths.get(descriptor) == unsafe else 1000
            if paths.get(descriptor) == unsafe and mode is not None:
                values[0] = (values[0] & ~0o7777) | mode
            return os.stat_result(values)

        with (
            patch.object(reader, "HOME_ROOT", self.home_root),
            patch.dict(os.environ, {"SUDO_UID": "1000"}),
            patch.object(os, "geteuid", return_value=0),
            patch.object(reader.pwd, "getpwuid", return_value=self.owner),
            patch.object(os, "open", side_effect=open_file),
            patch.object(os, "fstat", side_effect=file_stat),
            patch.object(os, "fchown") as chown,
            patch.object(reader, "command", side_effect=self.api),
        ):
            yield chown

    def api(self, argv, *, data=None, **kwargs):
        self.calls.append((argv, data))
        args = argv[len(reader.KUBECTL) :]
        if args[:3] == ["get", "configmap", "kube-root-ca.crt"]:
            value = {"data": {"ca.crt": CERTIFICATE}}
        elif args[0] == "get":
            value = self.existing.get(args[1])
            if value is None:
                return CompletedProcess(argv, 0, b"", b"")
        elif args[0] == "apply":
            value = {}
        elif args[:2] == ["create", "--raw"]:
            if self.token_hook:
                self.token_hook()
            value = self.token_response
        else:
            raise AssertionError("Unexpected synthetic command")
        return CompletedProcess(argv, 0, json.dumps(value).encode(), b"")

    def managed_file(self, *, mode=0o700):
        self.directory.mkdir(exist_ok=True)
        self.directory.chmod(mode)
        self.path.write_text(json.dumps(reader._kubeconfig(NAMESPACE, CA, OLD_TOKEN)))
        self.path.chmod(0o600)

    def assert_no_grants(self):
        self.assertFalse(
            any(
                argv[len(reader.KUBECTL)] in {"apply", "create"}
                for argv, _ in self.calls
            )
        )

    def test_native_rbac_has_only_exact_namespace_read_resources(self):
        objects = reader.resources(NAMESPACE)
        self.assertEqual(
            [obj["kind"] for obj in objects], ["ServiceAccount", "Role", "RoleBinding"]
        )
        for obj in objects:
            self.assertEqual(
                obj["metadata"],
                {
                    "name": reader.NAME,
                    "namespace": NAMESPACE,
                    "labels": {reader.MANAGED_LABEL: reader.NAME},
                },
            )
        self.assertFalse(objects[0]["automountServiceAccountToken"])
        self.assertEqual(
            objects[2]["subjects"],
            [{"kind": "ServiceAccount", "name": reader.NAME, "namespace": NAMESPACE}],
        )
        self.assertEqual(
            objects[2]["roleRef"],
            {
                "apiGroup": "rbac.authorization.k8s.io",
                "kind": "Role",
                "name": reader.NAME,
            },
        )
        rules = objects[1]["rules"]
        self.assertEqual(
            [(rule["apiGroups"], rule["resources"], rule["verbs"]) for rule in rules],
            [
                ([""], ["pods", "services"], ["get", "list", "watch"]),
                (["apps"], ["deployments", "replicasets"], ["get", "list", "watch"]),
                (["batch"], ["jobs", "cronjobs"], ["get", "list", "watch"]),
                ([""], ["configmaps"], ["get"]),
            ],
        )
        self.assertEqual(
            rules[-1]["resourceNames"], ["newsletter-release", "platform-release"]
        )
        serialized = json.dumps(objects).lower()
        for denied in (
            "secrets",
            "pods/log",
            "pods/exec",
            "serviceaccounts/token",
            "clusterrole",
            '"*"',
            '"create"',
            '"patch"',
            '"delete"',
            '"update"',
            "platform-runtime-config",
        ):
            self.assertNotIn(denied, serialized)

    def test_fresh_grant_is_private_and_returns_actual_clamped_expiry_only(self):
        with (
            self.synthetic_owner() as chown,
            contextlib.redirect_stdout(io.StringIO()) as output,
            contextlib.redirect_stderr(io.StringIO()) as error,
        ):
            self.assertEqual(reader.install_reader(NAMESPACE), self.expiration)
        self.assertEqual(output.getvalue() + error.getvalue(), "")
        self.assertEqual(self.home.stat().st_mode & 0o777, 0o750)
        self.assertEqual(self.directory.stat().st_mode & 0o777, 0o700)
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)
        chown.assert_called_with(unittest.mock.ANY, 1000, 1000)
        self.assertEqual(
            json.loads(self.path.read_text()), reader._kubeconfig(NAMESPACE, CA, TOKEN)
        )
        self.assertFalse((self.directory / "config").exists())
        self.assertFalse(list(self.directory.glob("." + reader.NAME + "-*")))
        token_calls = [(argv, data) for argv, data in self.calls if "--raw" in argv]
        self.assertEqual(len(token_calls), 1)
        argv, data = token_calls[0]
        self.assertEqual(
            argv[-4:],
            [
                "--raw",
                f"/api/v1/namespaces/{NAMESPACE}/serviceaccounts/{reader.NAME}/token",
                "-f",
                "-",
            ],
        )
        self.assertEqual(
            json.loads(data)["spec"], {"audiences": [], "expirationSeconds": 31536000}
        )
        self.assertNotIn(TOKEN, json.dumps([call[0] for call in self.calls]))
        self.assertNotIn(
            TOKEN, json.dumps([json.loads(data) for _, data in self.calls if data])
        )

    def test_exact_managed_renewal_preserves_existing_directory_and_default_config(
        self,
    ):
        self.managed_file(mode=0o750)
        default = self.directory / "config"
        default.write_bytes(b"existing unrelated default kubeconfig")
        original = default.stat().st_ino
        self.existing = {
            obj["kind"]: copy.deepcopy(obj) for obj in reader.resources(NAMESPACE)
        }
        with self.synthetic_owner():
            self.assertEqual(reader.install_reader(NAMESPACE), self.expiration)
        self.assertEqual(self.directory.stat().st_mode & 0o777, 0o750)
        self.assertEqual(default.read_bytes(), b"existing unrelated default kubeconfig")
        self.assertEqual(default.stat().st_ino, original)
        self.assertEqual(
            json.loads(self.path.read_text())["users"][0]["user"]["token"], TOKEN
        )

    def test_foreign_reader_file_never_reaches_api_or_overwrites(self):
        self.managed_file()
        canonical = reader._kubeconfig(NAMESPACE, CA, OLD_TOKEN)
        variants = []
        value = copy.deepcopy(canonical)
        value["users"][0]["user"] = {"exec": {"command": "foreign"}}
        variants.append(value)
        value = copy.deepcopy(canonical)
        value["clusters"][0]["cluster"]["insecure-skip-tls-verify"] = True
        variants.append(value)
        value = copy.deepcopy(canonical)
        value["contexts"][0]["context"]["namespace"] = "other-namespace"
        variants.append(value)
        variants.extend([{}, [], "not a config"])
        for value in variants:
            with self.subTest(value=value):
                self.calls.clear()
                self.path.write_text(json.dumps(value))
                before = self.path.read_bytes()
                with self.synthetic_owner(), self.assertRaises(BootstrapError):
                    reader.install_reader(NAMESPACE)
                self.assertEqual(self.calls, [])
                self.assertEqual(self.path.read_bytes(), before)

    def test_foreign_cluster_certificate_is_not_renewed(self):
        self.managed_file()
        self.path.write_text(
            json.dumps(reader._kubeconfig(NAMESPACE, "different-ca", OLD_TOKEN))
        )
        with (
            self.synthetic_owner(),
            self.assertRaisesRegex(BootstrapError, "READER_CLUSTER_CONFLICT"),
        ):
            reader.install_reader(NAMESPACE)
        self.assert_no_grants()

    def test_unsafe_owners_permissions_and_namespace_are_refused_before_api(self):
        self.managed_file()
        for path, uid, mode in (
            (self.home, 0, None),
            (self.home, 1000, 0o770),
            (self.directory, 0, None),
            (self.directory, 1000, 0o777),
            (self.path, 0, None),
            (self.path, 1000, 0o644),
        ):
            with self.subTest(path=path, uid=uid, mode=mode):
                self.calls.clear()
                with (
                    self.synthetic_owner(unsafe=path, uid=uid, mode=mode),
                    self.assertRaises(BootstrapError),
                ):
                    reader.install_reader(NAMESPACE)
                self.assertEqual(self.calls, [])
        for namespace in ("", "other/namespace", "trailing-", "a" * 64, 123):
            with (
                self.subTest(namespace=namespace),
                self.synthetic_owner(),
                self.assertRaisesRegex(BootstrapError, "READER_NAMESPACE_INVALID"),
            ):
                reader.install_reader(namespace)

    def test_owner_must_come_from_sudo_and_standard_user_home(self):
        with self.synthetic_owner():
            for identifier in ("", "0", "abc"):
                with (
                    self.subTest(identifier=identifier),
                    patch.dict(os.environ, {"SUDO_UID": identifier}),
                    self.assertRaisesRegex(BootstrapError, "READER_OWNER_INVALID"),
                ):
                    reader.install_reader(NAMESPACE)
            with (
                patch.object(os, "geteuid", return_value=1000),
                self.assertRaisesRegex(BootstrapError, "READER_ROOT_REQUIRED"),
            ):
                reader.install_reader(NAMESPACE)
            self.owner.pw_dir = str(self.base / "nonstandard")
            with self.assertRaisesRegex(BootstrapError, "READER_HOME_INVALID"):
                reader.install_reader(NAMESPACE)
        self.assertEqual(self.calls, [])

    def test_symlinked_reader_and_directory_are_refused_without_following(self):
        self.directory.mkdir()
        foreign = self.base / "foreign"
        foreign.write_bytes(b"untouched")
        self.path.symlink_to(foreign)
        with (
            self.synthetic_owner(),
            self.assertRaisesRegex(BootstrapError, "READER_FILE_INVALID"),
        ):
            reader.install_reader(NAMESPACE)
        self.path.unlink()
        self.directory.rmdir()
        self.directory.symlink_to(self.base, target_is_directory=True)
        with (
            self.synthetic_owner(),
            self.assertRaisesRegex(BootstrapError, "READER_DIRECTORY_INVALID"),
        ):
            reader.install_reader(NAMESPACE)
        self.assertEqual(self.calls, [])
        self.assertEqual(foreign.read_bytes(), b"untouched")

    def test_directory_swap_during_token_request_cannot_write_outside_opened_directory(
        self,
    ):
        self.directory.mkdir()
        foreign = self.base / "foreign-directory"
        foreign.mkdir()
        default = foreign / "config"
        default.write_bytes(b"untouched")

        def swap():
            self.directory.rename(self.home / "retained-kube")
            self.directory.symlink_to(foreign, target_is_directory=True)

        self.token_hook = swap
        with (
            self.synthetic_owner(),
            self.assertRaisesRegex(BootstrapError, "READER_DIRECTORY_CHANGED"),
        ):
            reader.install_reader(NAMESPACE)
        self.assertEqual(list(foreign.iterdir()), [default])
        self.assertEqual(default.read_bytes(), b"untouched")
        self.assertFalse(list((self.home / "retained-kube").iterdir()))

    def test_fifo_reader_file_is_refused_without_blocking_or_reading(self):
        self.directory.mkdir()
        os.mkfifo(self.path, 0o600)
        with self.synthetic_owner():
            original_open = os.open

            def bounded_open(name, flags, *args, **kwargs):
                if name == reader.NAME + ".json":
                    self.assertTrue(flags & os.O_NONBLOCK)
                return original_open(name, flags, *args, **kwargs)

            with (
                patch.object(os, "open", side_effect=bounded_open),
                self.assertRaisesRegex(BootstrapError, "READER_FILE_INVALID"),
            ):
                reader.install_reader(NAMESPACE)
        self.assertEqual(self.calls, [])

    def test_foreign_existing_native_resource_cannot_be_adopted_or_expanded(self):
        objects = reader.resources(NAMESPACE)
        variants = []
        for obj in objects:
            value = copy.deepcopy(obj)
            value["metadata"]["labels"] = {reader.MANAGED_LABEL: "foreign"}
            variants.append(value)
        value = copy.deepcopy(objects[0])
        value["automountServiceAccountToken"] = True
        variants.append(value)
        value = copy.deepcopy(objects[0])
        value["secrets"] = [{"name": "foreign-private-secret"}]
        variants.append(value)
        value = copy.deepcopy(objects[1])
        value["rules"][0]["verbs"].append("delete")
        variants.append(value)
        value = copy.deepcopy(objects[2])
        value["subjects"][0]["namespace"] = "foreign"
        variants.append(value)
        for value in variants:
            with self.subTest(kind=value["kind"]):
                self.calls.clear()
                self.existing = {value["kind"]: value}
                with (
                    self.synthetic_owner(),
                    self.assertRaisesRegex(BootstrapError, "READER_RESOURCE_CONFLICT"),
                ):
                    reader.install_reader(NAMESPACE)
                self.assert_no_grants()
                self.assertFalse(self.path.exists())

    def test_invalid_token_or_expiration_never_creates_reader_file_or_prints_token(
        self,
    ):
        invalid = [
            {"token": TOKEN, "expirationTimestamp": "not a timestamp"},
            {"token": TOKEN, "expirationTimestamp": "2020-01-01T00:00:00Z"},
            {"token": TOKEN, "expirationTimestamp": "2099-01-01T00:00:00Z"},
            {"token": TOKEN, "expirationTimestamp": "2027-01-01T00:00:00"},
            {"token": "short", "expirationTimestamp": self.expiration},
            None,
        ]
        for status in invalid:
            with self.subTest(status=status):
                self.token_response = {"status": status}
                with (
                    self.synthetic_owner(),
                    contextlib.redirect_stdout(io.StringIO()) as output,
                    contextlib.redirect_stderr(io.StringIO()) as error,
                    self.assertRaisesRegex(BootstrapError, "READER_TOKEN_INVALID"),
                ):
                    reader.install_reader(NAMESPACE)
                self.assertFalse(self.path.exists())
                self.assertEqual(output.getvalue() + error.getvalue(), "")


if __name__ == "__main__":
    unittest.main()

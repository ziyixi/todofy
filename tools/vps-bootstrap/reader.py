"""Optional namespace-only diagnostics; native token issuance never copies admin credentials."""

import base64
import json
import os
import pwd
import re
import stat
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import host
from runner import command

from config import BootstrapError, require

NAME = "personal-cloud-reader"
HOME_ROOT = Path("/home")
SERVER = "https://127.0.0.1:6443"
EXPIRATION_SECONDS = 365 * 24 * 60 * 60
MANAGED_LABEL = "app.kubernetes.io/managed-by"
KUBECTL = ["/usr/local/bin/k3s", "kubectl"]


def resources(namespace):
    """Only the selected namespace; no token creation, logs, exec or private ConfigMaps."""
    metadata = {
        "name": NAME,
        "namespace": namespace,
        "labels": {MANAGED_LABEL: NAME},
    }
    return [
        {
            "apiVersion": "v1",
            "kind": "ServiceAccount",
            "metadata": metadata,
            "automountServiceAccountToken": False,
        },
        {
            "apiVersion": "rbac.authorization.k8s.io/v1",
            "kind": "Role",
            "metadata": metadata,
            "rules": [
                {
                    "apiGroups": [""],
                    "resources": ["pods", "services"],
                    "verbs": ["get", "list", "watch"],
                },
                {
                    "apiGroups": ["apps"],
                    "resources": ["deployments", "replicasets"],
                    "verbs": ["get", "list", "watch"],
                },
                {
                    "apiGroups": ["batch"],
                    "resources": ["jobs", "cronjobs"],
                    "verbs": ["get", "list", "watch"],
                },
                {
                    "apiGroups": [""],
                    "resources": ["configmaps"],
                    "resourceNames": ["newsletter-release", "platform-release"],
                    "verbs": ["get"],
                },
            ],
        },
        {
            "apiVersion": "rbac.authorization.k8s.io/v1",
            "kind": "RoleBinding",
            "metadata": metadata,
            "roleRef": {
                "apiGroup": "rbac.authorization.k8s.io",
                "kind": "Role",
                "name": NAME,
            },
            "subjects": [
                {"kind": "ServiceAccount", "name": NAME, "namespace": namespace}
            ],
        },
    ]


def _owner():
    require(os.geteuid() == 0, "READER_ROOT_REQUIRED")
    identifier = os.environ.get("SUDO_UID", "")
    require(identifier.isdigit() and int(identifier) >= 1000, "READER_OWNER_INVALID")
    try:
        owner = pwd.getpwuid(int(identifier))
    except KeyError:
        raise BootstrapError("READER_OWNER_INVALID") from None
    require(
        re.fullmatch(r"[a-z_][a-z0-9_-]{0,31}", owner.pw_name)
        and Path(owner.pw_dir) == HOME_ROOT / owner.pw_name,
        "READER_HOME_INVALID",
    )
    host.real_path(owner.pw_dir)
    return owner


def _directory(name, owner, *, parent=None, create=False):
    created = False
    if create:
        try:
            os.mkdir(name, 0o700, dir_fd=parent)
            created = True
        except FileExistsError:
            pass
    try:
        descriptor = os.open(
            name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent
        )
    except FileNotFoundError:
        if parent is not None and not create:
            return None
        raise BootstrapError("READER_DIRECTORY_INVALID") from None
    except OSError:
        raise BootstrapError("READER_DIRECTORY_INVALID") from None
    try:
        attributes = os.fstat(descriptor)
        if created and attributes.st_uid == 0:
            os.fchown(descriptor, owner.pw_uid, owner.pw_gid)
            os.fchmod(descriptor, 0o700)
            attributes = os.fstat(descriptor)
        require(
            attributes.st_uid == owner.pw_uid
            and not stat.S_IMODE(attributes.st_mode) & 0o022,
            "READER_DIRECTORY_INVALID",
        )
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def _kubeconfig(namespace, certificate, token):
    return {
        "apiVersion": "v1",
        "kind": "Config",
        "clusters": [
            {
                "name": NAME,
                "cluster": {
                    "server": SERVER,
                    "certificate-authority-data": certificate,
                },
            }
        ],
        "users": [{"name": NAME, "user": {"token": token}}],
        "contexts": [
            {
                "name": NAME,
                "context": {"cluster": NAME, "user": NAME, "namespace": namespace},
            }
        ],
        "current-context": NAME,
        "extensions": [{"name": NAME, "extension": {"schema_version": 1}}],
    }


def _existing(directory, owner, namespace, certificate=None):
    if directory is None:
        return False
    try:
        descriptor = os.open(
            NAME + ".json",
            os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
            dir_fd=directory,
        )
    except FileNotFoundError:
        return False
    except OSError:
        raise BootstrapError("READER_FILE_INVALID") from None
    with os.fdopen(descriptor, "rb") as source:
        attributes = os.fstat(source.fileno())
        require(
            stat.S_ISREG(attributes.st_mode)
            and attributes.st_uid == owner.pw_uid
            and stat.S_IMODE(attributes.st_mode) == 0o600
            and attributes.st_size <= 262144,
            "READER_FILE_INVALID",
        )
        try:
            value = json.loads(source.read(262145))
        except (ValueError, UnicodeError):
            raise BootstrapError("READER_FILE_CONFLICT") from None
    try:
        existing_certificate = value["clusters"][0]["cluster"][
            "certificate-authority-data"
        ]
        existing_token = value["users"][0]["user"]["token"]
        require(
            isinstance(existing_certificate, str)
            and 1 <= len(existing_certificate) <= 65536
            and isinstance(existing_token, str)
            and re.fullmatch(r"[A-Za-z0-9_.-]{24,16384}", existing_token)
            and value == _kubeconfig(namespace, existing_certificate, existing_token),
            "READER_FILE_CONFLICT",
        )
        if certificate is not None:
            require(existing_certificate == certificate, "READER_CLUSTER_CONFLICT")
    except (KeyError, IndexError, TypeError):
        raise BootstrapError("READER_FILE_CONFLICT") from None
    return True


def _write(directory, owner, namespace, certificate, token):
    temporary = "." + NAME + "-" + uuid.uuid4().hex
    descriptor = os.open(
        temporary,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
        0o600,
        dir_fd=directory,
    )
    try:
        with os.fdopen(descriptor, "wb") as output:
            os.fchmod(output.fileno(), 0o600)
            os.fchown(output.fileno(), owner.pw_uid, owner.pw_gid)
            output.write(
                (
                    json.dumps(
                        _kubeconfig(namespace, certificate, token), sort_keys=True
                    )
                    + "\n"
                ).encode()
            )
            output.flush()
            os.fsync(output.fileno())
        if _existing(directory, owner, namespace, certificate):
            os.replace(
                temporary, NAME + ".json", src_dir_fd=directory, dst_dir_fd=directory
            )
        else:
            # A fresh destination must still be absent; link refuses a concurrent foreign file.
            os.link(
                temporary,
                NAME + ".json",
                src_dir_fd=directory,
                dst_dir_fd=directory,
                follow_symlinks=False,
            )
        os.fsync(directory)
    finally:
        try:
            os.unlink(temporary, dir_fd=directory)
        except FileNotFoundError:
            pass


def _response(raw):
    require(len(raw) <= 65536, "READER_RESPONSE_INVALID")
    try:
        value = json.loads(raw)
    except (ValueError, UnicodeError):
        raise BootstrapError("READER_RESPONSE_INVALID") from None
    require(isinstance(value, dict), "READER_RESPONSE_INVALID")
    return value


def _ensure_resources(namespace):
    selected = resources(namespace)
    for desired in selected:
        result = command(
            KUBECTL
            + [
                "get",
                desired["kind"],
                NAME,
                "-n",
                namespace,
                "--ignore-not-found",
                "-o",
                "json",
            ]
        )
        if not result.stdout.strip():
            continue
        current = _response(result.stdout)
        metadata = current.get("metadata", {})
        require(
            isinstance(metadata, dict)
            and metadata.get("name") == NAME
            and metadata.get("namespace") == namespace
            and metadata.get("labels") == {MANAGED_LABEL: NAME}
            and not metadata.get("ownerReferences")
            and all(
                current.get(field) == value
                for field, value in desired.items()
                if field != "metadata"
            ),
            "READER_RESOURCE_CONFLICT",
        )
        if desired["kind"] == "ServiceAccount":
            require(
                not current.get("secrets") and not current.get("imagePullSecrets"),
                "READER_RESOURCE_CONFLICT",
            )
    command(
        KUBECTL + ["apply", "--server-side", "--field-manager=" + NAME, "-f", "-"],
        data=json.dumps(
            {"apiVersion": "v1", "kind": "List", "items": selected}
        ).encode(),
    )


def _certificate(namespace):
    result = command(
        KUBECTL
        + ["get", "configmap", "kube-root-ca.crt", "-n", namespace, "-o", "json"]
    )
    data = _response(result.stdout).get("data", {})
    require(isinstance(data, dict), "READER_CA_INVALID")
    value = data.get("ca.crt")
    require(
        isinstance(value, str)
        and value.startswith("-----BEGIN CERTIFICATE-----\n")
        and "-----END CERTIFICATE-----" in value,
        "READER_CA_INVALID",
    )
    return base64.b64encode(value.encode()).decode()


def _token(namespace):
    request = {
        "apiVersion": "authentication.k8s.io/v1",
        "kind": "TokenRequest",
        "spec": {"audiences": [], "expirationSeconds": EXPIRATION_SECONDS},
    }
    # Kubernetes defaults empty audiences to its own API audiences and may shorten the requested lifetime.
    result = command(
        KUBECTL
        + [
            "create",
            "--raw",
            f"/api/v1/namespaces/{namespace}/serviceaccounts/{NAME}/token",
            "-f",
            "-",
        ],
        data=json.dumps(request).encode(),
    )
    status = _response(result.stdout).get("status", {})
    require(isinstance(status, dict), "READER_TOKEN_INVALID")
    token, expiration = status.get("token"), status.get("expirationTimestamp")
    require(
        isinstance(token, str)
        and re.fullmatch(r"[A-Za-z0-9_.-]{24,16384}", token)
        and isinstance(expiration, str)
        and len(expiration) <= 40,
        "READER_TOKEN_INVALID",
    )
    try:
        expires = datetime.fromisoformat(expiration.replace("Z", "+00:00"))
    except ValueError:
        raise BootstrapError("READER_TOKEN_INVALID") from None
    now = datetime.now(timezone.utc)
    require(
        expires.tzinfo is not None
        and now < expires <= now + timedelta(seconds=EXPIRATION_SECONDS + 60),
        "READER_TOKEN_INVALID",
    )
    return token, expires.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def install_reader(namespace: str) -> str:
    """Create or renew the dedicated reader; return only its actual expiration timestamp."""
    require(
        isinstance(namespace, str)
        and re.fullmatch(r"[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?", namespace),
        "READER_NAMESPACE_INVALID",
    )
    owner = _owner()
    home = _directory(owner.pw_dir, owner)
    directory = None
    try:
        directory = _directory(".kube", owner, parent=home)
        _existing(directory, owner, namespace)
        certificate = _certificate(namespace)
        _existing(directory, owner, namespace, certificate)
        _ensure_resources(namespace)
        token, expiration = _token(namespace)
        if directory is None:
            directory = _directory(".kube", owner, parent=home, create=True)
        current = os.stat(".kube", dir_fd=home, follow_symlinks=False)
        opened = os.fstat(directory)
        require(
            stat.S_ISDIR(current.st_mode)
            and (current.st_dev, current.st_ino) == (opened.st_dev, opened.st_ino),
            "READER_DIRECTORY_CHANGED",
        )
        _write(directory, owner, namespace, certificate, token)
        return expiration
    except OSError:
        raise BootstrapError("READER_FILE_UNAVAILABLE") from None
    finally:
        if directory is not None:
            os.close(directory)
        os.close(home)

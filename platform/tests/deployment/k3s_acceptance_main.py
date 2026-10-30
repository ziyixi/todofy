"""Run the existing SSA assertions against one disposable, API-only k3s cluster."""

import importlib
import json
import os
import subprocess
import tempfile
import time
import unittest
import uuid
from pathlib import Path

ROOT = Path(__file__).absolute().parents[2]
# This digest pins the isolated test fixture, independently of the VPS installer.
IMAGE_DIGEST = "sha256:ca7f37d993d82ef0dcdcfecb2e0e2618ea541dbaffc620c8cedebe01a82acd0d"


def docker(*args, **kwargs):
    return subprocess.run(["docker", *args], check=True, text=True, **kwargs)


def main():
    name = "todofy-k3s-acceptance-" + uuid.uuid4().hex
    version = json.loads((ROOT / "versions.json").read_text())["k3s"]["version"]
    image = "docker.io/rancher/k3s:" + version.replace("+", "-") + "@" + IMAGE_DIGEST
    with tempfile.TemporaryDirectory(
        prefix="k3s-acceptance-", dir=os.environ["TEST_TMPDIR"]
    ) as temporary:
        directory = Path(temporary)
        try:
            docker(
                "run",
                "--detach",
                "--privileged",
                "--name",
                name,
                "--platform",
                "linux/amd64",
                "--publish",
                "127.0.0.1:6443:6443",
                "--tmpfs",
                "/run",
                "--tmpfs",
                "/var/run",
                "--mount",
                "type=volume,source=" + name + ",target=/var/lib/rancher/k3s",
                image,
                "server",
                "--disable-agent",
                "--disable=traefik,servicelb,metrics-server,local-storage,coredns",
            )
            actual = docker(
                "exec", name, "k3s", "--version", capture_output=True
            ).stdout
            if not actual.startswith("k3s version " + version + " ("):
                raise ValueError("The isolated k3s version differs from versions.json")
            kubectl = [
                "exec",
                "--env",
                "KUBECONFIG=/etc/rancher/k3s/k3s.yaml",
                name,
                "/bin/kubectl",
            ]
            for _ in range(60):
                ready = subprocess.run(
                    ["docker", *kubectl, "get", "--raw=/readyz"],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    check=False,
                )
                if ready.returncode == 0:
                    break
                time.sleep(2)
            docker(*kubectl, "get", "--raw=/readyz", stdout=subprocess.DEVNULL)
            for filename in ("namespace.yaml", "rbac.yaml"):
                docker(
                    "cp",
                    "--follow-link",
                    str(ROOT / "k3s/bootstrap" / filename),
                    name + ":/tmp/" + filename,
                )
            docker(
                *kubectl, "apply", "-f", "/tmp/namespace.yaml", "-f", "/tmp/rbac.yaml"
            )
            docker(
                "cp", name + ":/etc/rancher/k3s/k3s.yaml", str(directory / "kubeconfig")
            )
            docker(
                "cp",
                name + ":/var/lib/rancher/k3s/server/tls/server-ca.crt",
                str(directory / "ca.crt"),
            )
            with (directory / "token").open("w") as token:
                docker(
                    *kubectl,
                    "-n",
                    "personal-cloud",
                    "create",
                    "token",
                    "platform-controller",
                    "--duration=10m",
                    stdout=token,
                )
            for file in directory.iterdir():
                file.chmod(0o600)
            # The original module evaluates its isolated-fixture decorator during import.
            os.environ["K3S_ACCEPTANCE_DIR"] = str(directory)
            module = importlib.import_module("tests.deployment.test_k3s_acceptance")
            suite = unittest.defaultTestLoader.loadTestsFromModule(module)
            if not suite.countTestCases():
                raise ValueError("The declared k3s acceptance module contains no tests")
            result = unittest.TextTestRunner(verbosity=2).run(suite)
            return 0 if result.wasSuccessful() and not result.skipped else 1
        finally:
            subprocess.run(
                ["docker", "rm", "--force", name],
                check=False,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            subprocess.run(
                ["docker", "volume", "rm", name],
                check=False,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )


if __name__ == "__main__":
    raise SystemExit(main())

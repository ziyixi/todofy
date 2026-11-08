"""Run Bazel's installer with real curl against a synthetic loopback download service."""

import hashlib
import http.server
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path

from workflow_sources import ROOT, workflow_data

ACTION = ROOT / ".github/actions/setup-bazel/action.yml"
VERSION = "9.3.1"
SOURCE = "https://releases.bazel.build/9.3.1/release/bazel-9.3.1-linux-x86_64"
SHA256 = "7f775b54bbec487efaf0f49ccda1d2ed02cd34f582edfdd6aeeec76e39ef585c"
PAYLOAD = b"synthetic Bazel download\n"
PREVIOUS = b"previous verified Bazel binary\n"


def install_script():
    return workflow_data(ACTION)["runs"]["steps"][0]["run"]


class DownloadService:
    """Serve scripted responses; the final response repeats until the client stops."""

    def __init__(self, responses):
        self.responses = responses
        self.requests = []
        service = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802 - BaseHTTPRequestHandler's method name
                index = min(len(service.requests), len(service.responses) - 1)
                service.requests.append(self.path)
                status, body = service.responses[index]
                self.send_response(status)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}/bazel"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *args):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()


def run_installer(directory, url, *, existing=None, version=VERSION):
    """Replace only the URL and checksum in the action's own shell step, never invoke its binary."""
    script = install_script()
    if script.count(SOURCE) != 1 or script.count(SHA256) != 1:
        raise AssertionError("The installer source or checksum changed")
    script = script.replace(SOURCE, url).replace(SHA256, hashlib.sha256(PAYLOAD).hexdigest())
    temporary = Path(directory)
    (temporary / ".bazelversion").write_text(version + "\n")
    runner = temporary / "runner"
    output = runner / "bazel-tools/bazel"
    if existing is not None:
        output.parent.mkdir(parents=True)
        output.write_bytes(existing)
        output.chmod(0o755)
    github_path = temporary / "github-path"
    environment = {
        **os.environ,
        "RUNNER_TEMP": str(runner),
        "GITHUB_PATH": str(github_path),
        "NO_PROXY": "127.0.0.1",
        "no_proxy": "127.0.0.1",
    }
    if sys.platform == "darwin":
        # macOS sha256sum lacks GNU options; shasum performs the same real checksum verification.
        tools = temporary / "checksum-tools"
        tools.mkdir()
        checksum = tools / "sha256sum"
        checksum.write_text('#!/bin/sh\nexec /usr/bin/shasum -a 256 "$@"\n')
        checksum.chmod(0o755)
        environment["PATH"] = str(tools) + os.pathsep + os.environ["PATH"]
    result = subprocess.run(
        ["bash", "-e", "-c", script],
        cwd=temporary,
        env=environment,
        capture_output=True,
        text=True,
        timeout=15,
        check=False,
    )
    return result, output, github_path


class BazelSetup(unittest.TestCase):
    def test_keeps_the_fixed_version_checksum_and_official_source(self):
        script = install_script()
        self.assertEqual((ROOT / ".bazelversion").read_text().strip(), VERSION)
        self.assertEqual(script.count(SOURCE), 1)
        self.assertEqual(script.count(SHA256), 1)
        self.assertIn('test "$(cat .bazelversion)" = ' + VERSION, script)
        for option in ("--retry 3", "--retry-delay 2", "--connect-timeout 10", "--max-time 45"):
            self.assertIn(option, script)
        self.assertNotIn("https://github.com/bazelbuild/bazel/releases/", script)
        for install in ("chmod +x", "mv -f", '>> "$GITHUB_PATH"'):
            self.assertLess(script.index("sha256sum --check --status"), script.index(install))

    def test_recovers_from_504_in_one_invocation_and_installs_verified_bytes(self):
        with (
            DownloadService([(504, b"gateway timeout"), (200, PAYLOAD)]) as service,
            tempfile.TemporaryDirectory() as directory,
        ):
            result, output, github_path = run_installer(directory, service.url, existing=PREVIOUS)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(service.requests, ["/bazel", "/bazel"])
            self.assertEqual(output.read_bytes(), PAYLOAD)
            self.assertTrue(os.access(output, os.X_OK))
            self.assertEqual(github_path.read_text(), str(output.parent) + "\n")
            self.assertFalse(output.with_name("bazel.partial").exists())

    def test_corrupt_download_never_installs_or_registers_a_path(self):
        for existing in (None, PREVIOUS):
            with (
                self.subTest(existing=existing is not None),
                DownloadService([(200, b"corrupt download")]) as service,
                tempfile.TemporaryDirectory() as directory,
            ):
                result, output, github_path = run_installer(directory, service.url, existing=existing)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(service.requests, ["/bazel"])
                self.assertFalse(github_path.exists())
                self.assertFalse(output.with_name("bazel.partial").exists())
                if existing is None:
                    self.assertFalse(output.exists())
                    self.assertEqual(list(output.parent.iterdir()), [])
                else:
                    self.assertEqual(output.read_bytes(), existing)
                    self.assertEqual(output.stat().st_mode & 0o777, 0o755)

    def test_persistent_failure_exhausts_bounded_attempts_and_preserves_the_binary(self):
        with (
            DownloadService([(504, b"gateway timeout")]) as service,
            tempfile.TemporaryDirectory() as directory,
        ):
            result, output, github_path = run_installer(directory, service.url, existing=PREVIOUS)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(service.requests, ["/bazel"] * 4)
            self.assertEqual(output.read_bytes(), PREVIOUS)
            self.assertEqual(output.stat().st_mode & 0o777, 0o755)
            self.assertFalse(github_path.exists())
            self.assertFalse(output.with_name("bazel.partial").exists())

    def test_rejects_an_unexpected_version_before_downloading(self):
        with (
            DownloadService([(200, PAYLOAD)]) as service,
            tempfile.TemporaryDirectory() as directory,
        ):
            result, output, github_path = run_installer(directory, service.url, version="0.0.0")
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(service.requests, [])
            self.assertFalse(output.exists())
            self.assertFalse(github_path.exists())


if __name__ == "__main__":
    unittest.main()

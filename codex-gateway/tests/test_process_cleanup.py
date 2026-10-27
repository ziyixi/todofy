"""Offline process supervision checks with synthetic sleeping child processes."""

import os
import pathlib
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

from codex_gateway import _launch


def running(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    status = pathlib.Path(f"/proc/{pid}/stat")
    if sys.platform == "linux":
        try:
            stat = status.read_text()
        except FileNotFoundError:
            return False
        return stat.split(")", 1)[1].strip().split()[0] != "Z"
    return True


class ProcessCleanupTests(unittest.TestCase):
    def test_a_process_that_exits_during_the_status_read_is_not_running(self):
        with (
            patch.object(sys, "platform", "linux"),
            patch.object(os, "kill"),
            patch.object(pathlib.Path, "read_text", side_effect=FileNotFoundError),
        ):
            self.assertFalse(running(12345))

    def run_supervisor(self, directory: pathlib.Path, *, nested_parent: bool):
        receipt = directory / "pids"
        child = (
            "import os,pathlib,subprocess,sys,time; "
            "child=subprocess.Popen([sys.executable,'-c','import time;time.sleep(60)']); "
            f"pathlib.Path({str(receipt)!r}).write_text(str(os.getpid())+' '+str(child.pid)); "
            "time.sleep(60)"
        )
        launch = (
            "import importlib.util,sys,types; "
            f"spec=importlib.util.spec_from_file_location('launch',{_launch.__file__!r}); "
            "module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module); "
            "sys.modules['codex_cli_bin']=types.SimpleNamespace("
            "bundled_codex_path=lambda:sys.executable,bundled_path_dir=lambda:None); "
            f"sys.argv=['synthetic-launch','-c',{child!r}]; module.main()"
        )
        if nested_parent:
            launch = (
                "import subprocess,sys,time; "
                f"subprocess.Popen([sys.executable,'-c',{launch!r}]); time.sleep(60)"
            )
        parent = subprocess.Popen(
            [sys.executable, "-c", launch],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        try:
            deadline = time.monotonic() + 5
            while not receipt.exists() and time.monotonic() < deadline:
                time.sleep(0.02)
            self.assertTrue(
                receipt.exists(), "Synthetic supervised process did not start"
            )
            pids = [int(value) for value in receipt.read_text().split()]
            self.assertTrue(all(running(pid) for pid in pids))
            parent.send_signal(signal.SIGKILL if nested_parent else signal.SIGTERM)
            parent.wait(timeout=5)
            deadline = time.monotonic() + 5
            while any(running(pid) for pid in pids) and time.monotonic() < deadline:
                time.sleep(0.02)
            self.assertFalse(any(running(pid) for pid in pids))
        finally:
            if parent.poll() is None:
                parent.kill()
                parent.wait(timeout=5)
            if receipt.exists():
                for pid in [int(value) for value in receipt.read_text().split()]:
                    try:
                        os.kill(pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass

    def test_sdk_process_termination_kills_descendants(self):
        with tempfile.TemporaryDirectory(prefix="model-supervisor-test-") as directory:
            self.run_supervisor(pathlib.Path(directory), nested_parent=False)

    @unittest.skipUnless(sys.platform == "linux", "Linux parent-death signal")
    def test_abrupt_server_parent_death_kills_model_descendants(self):
        with tempfile.TemporaryDirectory(prefix="model-supervisor-test-") as directory:
            self.run_supervisor(pathlib.Path(directory), nested_parent=True)

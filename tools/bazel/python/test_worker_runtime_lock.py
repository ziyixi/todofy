"""The deployable Worker SDK follows its Pyodide lock, independently of host tools."""

import ast
import os
import tomllib
import unittest
from email.parser import Parser
from pathlib import Path

from python.runfiles import runfiles


class WorkerRuntimeLockTest(unittest.TestCase):
    def test_frozen_wheel_and_module_import_match_pylock(self):
        files = runfiles.Create()
        workspace = os.environ["TEST_WORKSPACE"]
        lock = tomllib.loads(
            Path(files.Rlocation(workspace + "/todofy/pylock.toml")).read_text()
        )
        sdk = next(
            package
            for package in lock["packages"]
            if package["name"] == "workers-runtime-sdk"
        )
        module = ast.parse(
            Path(files.Rlocation(workspace + "/MODULE.bazel")).read_text()
        )
        references = []
        for call in ast.walk(module):
            if (
                not isinstance(call, ast.Call)
                or not isinstance(call.func, ast.Name)
                or call.func.id != "http_archive"
            ):
                continue
            names = [keyword for keyword in call.keywords if keyword.arg == "name"]
            if names and ast.literal_eval(names[0].value) == "workers_runtime_sdk":
                references.append(call)
        self.assertEqual(len(references), 1)
        reference = {
            keyword.arg: ast.literal_eval(keyword.value)
            for keyword in references[0].keywords
            if keyword.arg in {"urls", "sha256"}
        }
        self.assertEqual(reference["urls"], [sdk["wheels"][0]["url"]])
        self.assertEqual(reference["sha256"], sdk["wheels"][0]["hashes"]["sha256"])
        metadata = files.Rlocation(
            f"workers_runtime_sdk/workers_runtime_sdk-{sdk['version']}.dist-info/METADATA"
        )
        self.assertIsNotNone(metadata)
        self.assertEqual(
            Parser().parsestr(Path(metadata).read_text())["Version"], sdk["version"]
        )

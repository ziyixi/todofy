"""Bazel migration metadata must not publish applications through legacy path rules."""

import unittest

from ci_changes import classify


class BazelMigrationTests(unittest.TestCase):
    def test_only_bazel_inputs_select_no_legacy_checks_or_publications(self):
        paths = [
            "MODULE.bazel", "MODULE.bazel.lock", ".bazelrc", ".bazelversion", "REPO.bazel",
            "tasks/worker/BUILD.bazel", "packages/edge-auth/BUILD.bazel", "contracts/BUILD.bazel",
            "proto/bazel/codegen.bzl", "proto/tools/bazel_codegen.py", "proto/tools/schema_golden.py",
            "tools/bazel/ci/plan.py",
        ]
        for path in paths:
            with self.subTest(path=path):
                self.assertFalse(any(classify([path]).values()))

    def test_production_source_beside_build_metadata_still_selects_its_release(self):
        result = classify(["tasks/worker/BUILD.bazel", "tasks/worker/src/planning.ts"])
        self.assertTrue(result["tasks_check"])
        self.assertTrue(result["tasks_deploy"])

    def test_legacy_generators_keep_their_consumer_checks_and_release_selection(self):
        result = classify(["proto/tools/gen_py.py"])
        self.assertTrue(result["proto"])
        self.assertTrue(result["newsletter_deploy"])
        self.assertTrue(result["codex_gateway_deploy"])


if __name__ == "__main__":
    unittest.main()

"""The repository audits read every public package: one list entry per package root, which names its subpackages."""

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).absolute().parents[2]
AUDIT = re.compile(r'"//([^:"]*):source_audit_files"')


def roots():
    text = (ROOT / "BUILD.bazel").read_text()
    block = text.split('name = "repository_audit_files"', 1)[1].split("\n)\n", 1)[0]
    return AUDIT.findall(block)


def audited(package):
    """Packages whose audit sources the package's own source_audit_files reaches through deps."""
    found, pending = set(), [package]
    while pending:
        current = pending.pop()
        if current in found:
            continue
        found.add(current)
        build = ROOT / current / "BUILD.bazel"
        if build.is_file():
            pending += [label for label in AUDIT.findall(build.read_text()) if label != current]
    return found


class AuditSources(unittest.TestCase):
    def test_the_repository_list_names_package_roots_only(self):
        for package in roots():
            with self.subTest(package=package):
                self.assertTrue("/" not in package or re.fullmatch(r"packages/[^/]+", package))

    def test_each_root_audits_every_subpackage_its_checks_reach(self):
        # A new subpackage joins its root's check suite; its sources must join the root's audit sources too.
        for package in roots():
            build = ROOT / package / "BUILD.bazel"
            checked = set(re.findall(r'"//(' + re.escape(package) + r'/[^:"]+):check"', build.read_text()))
            with self.subTest(package=package or "//"):
                self.assertLessEqual(checked, audited(package))


if __name__ == "__main__":
    unittest.main()

"""Unit tests for pytest_completeness.py: python3 -m unittest discover -s .github/scripts"""

import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from xml.sax.saxutils import quoteattr

sys.path.insert(0, str(Path(__file__).parent))
import pytest_completeness

IDS = [
    "tests/runtime/test_a.py::test_one",
    "tests/runtime/test_a.py::test_two[x-1]",
    "tests/runtime/test_b.py::test_three",
    "tests/runtime/test_c.py::Group::test_four",
]


def collected(ids=IDS, count=None):
    count = len(ids) if count is None else count
    return "\n".join([*ids, "", f"{count} tests collected in 0.50s"]) + "\n"


def junit(cases, errors=0, failures=None):
    """One shard's JUnit XML; ``cases`` are (id, outcome) with outcome None, "failure", "error" or "skipped"."""
    body = []
    for test_id, outcome in cases:
        classname, name = pytest_completeness.junit_key(test_id)
        inner = f"<{outcome} message='m'/>" if outcome else ""
        body.append(f'<testcase classname={quoteattr(classname)} name={quoteattr(name)} time="1.5">{inner}</testcase>')
    failures = sum(outcome == "failure" for _, outcome in cases) if failures is None else failures
    errors = errors or sum(outcome == "error" for _, outcome in cases)
    return (
        f'<?xml version="1.0" encoding="utf-8"?><testsuites><testsuite name="pytest" errors="{errors}" '
        f'failures="{failures}" skipped="0" tests="{len(cases)}">{"".join(body)}</testsuite></testsuites>'
    )


class Check(unittest.TestCase):
    def check(self, shards, ids=IDS, skips=(), expected_shards=None, count=None):
        with tempfile.TemporaryDirectory() as tmp:
            files = []
            for index, cases in enumerate(shards):
                path = Path(tmp) / f"runtime-{index}.xml"
                path.write_text(cases if isinstance(cases, str) else junit(cases))
                files.append(path)
            problems, seconds, _ = pytest_completeness.check(
                collected(ids, count), files, len(shards) if expected_shards is None else expected_shards, set(skips)
            )
        return problems, seconds

    def passing(self):
        return [[(IDS[0], None), (IDS[1], None)], [(IDS[2], None), (IDS[3], None)]]

    def test_every_id_once_and_passed_is_complete(self):
        problems, seconds = self.check(self.passing())
        self.assertEqual(problems, [])
        self.assertEqual(
            seconds, {"tests/runtime/test_a.py": 3.0, "tests/runtime/test_b.py": 1.5, "tests/runtime/test_c.py": 1.5}
        )

    def test_a_missing_id_fails(self):
        problems, _ = self.check([[(IDS[0], None), (IDS[1], None)], [(IDS[2], None)]])
        self.assertTrue(any("did not run" in problem and IDS[3] in problem for problem in problems), problems)

    def test_an_id_run_twice_fails(self):
        shards = self.passing()
        shards[1].append((IDS[0], None))
        problems, _ = self.check(shards)
        self.assertTrue(any("more than once" in problem for problem in problems), problems)

    def test_an_id_that_was_not_collected_fails(self):
        shards = self.passing()
        shards[0].append(("tests/runtime/test_z.py::test_new", None))
        problems, _ = self.check(shards)
        self.assertTrue(any("not collected" in problem for problem in problems), problems)

    def test_a_failure_or_an_error_fails(self):
        for outcome in ("failure", "error"):
            with self.subTest(outcome=outcome):
                shards = self.passing()
                shards[1][0] = (IDS[2], outcome)
                problems, _ = self.check(shards)
                self.assertTrue(any(IDS[2] in problem for problem in problems), problems)

    def test_a_skip_fails_unless_it_is_expected(self):
        shards = self.passing()
        shards[0][1] = (IDS[1], "skipped")
        problems, _ = self.check(shards)
        self.assertTrue(any("skipped" in problem for problem in problems), problems)
        self.assertEqual(self.check(shards, skips=[IDS[1]])[0], [])

    def test_an_expected_skip_that_ran_instead_fails(self):
        """The skip count must equal the serial baseline's: a listed skip that ran means the list is stale."""
        problems, _ = self.check(self.passing(), skips=[IDS[1]])
        self.assertTrue(any("ran instead" in problem and IDS[1] in problem for problem in problems), problems)

    def test_an_expected_skip_that_is_not_collected_fails(self):
        problems, _ = self.check(self.passing(), skips=["tests/runtime/test_gone.py::test_x"])
        self.assertTrue(any("not collected" in problem for problem in problems), problems)

    def test_a_missing_shard_file_fails(self):
        problems, _ = self.check(self.passing(), expected_shards=3)
        self.assertTrue(
            any("one JUnit file per shard 0..2, found shards [0, 1]" in problem for problem in problems), problems
        )

    def test_a_collection_error_in_a_shard_fails(self):
        shards = self.passing()
        shards[1] = junit(shards[1], errors=1)
        problems, _ = self.check(shards)
        self.assertTrue(any("outside its test cases" in problem for problem in problems), problems)

    def test_a_count_that_disagrees_with_the_listed_ids_fails(self):
        problems, _ = self.check(self.passing(), count=5)
        self.assertTrue(any("collected 5 tests" in problem for problem in problems), problems)

    def test_ids_that_share_a_junit_name_are_refused(self):
        aliased = [*IDS, "tests/runtime/test_c/Group.py::test_four"]
        self.assertEqual(
            pytest_completeness.junit_key(aliased[-1]),
            pytest_completeness.junit_key("tests/runtime/test_c.py::Group::test_four"),
        )
        problems, _ = self.check(self.passing(), ids=aliased)
        self.assertTrue(any("same JUnit name" in problem for problem in problems), problems)


class Collection(unittest.TestCase):
    """A test file that errors or skips at collection has no ids, so the plan and the id check never see it."""

    def check(self, text, on_disk=None):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "runtime-0.xml"
            path.write_text(junit([(test_id, None) for test_id in IDS]))
            return pytest_completeness.check(text, [path], 1, set(), on_disk=on_disk)[0]

    def test_a_clean_collection_passes(self):
        self.assertEqual(self.check(collected(), on_disk=["tests/runtime/test_a.py", "tests/runtime/test_b.py"]), [])

    def test_a_module_level_skip_fails(self):
        """pytest.skip(allow_module_level=True) or importorskip: "-ra" (addopts) prints the collector's skip."""
        text = collected().replace("\n\n", "\n\nSKIPPED [1] tests/runtime/test_d.py:2: not today\n", 1)
        problems = self.check(text)
        self.assertTrue(
            any("skipped or failed a collector" in problem and "test_d.py" in problem for problem in problems)
        )

    def test_a_collection_error_fails(self):
        text = collected().replace("4 tests collected in", "4 tests collected, 1 error in")
        problems = self.check(text)
        self.assertTrue(any("skipped or failed a collector" in problem for problem in problems), problems)

    def test_a_test_file_on_disk_without_a_collected_test_fails(self):
        """Also without "-ra": a file that vanished from the collection is found on disk."""
        on_disk = [
            "tests/runtime/test_a.py",
            "tests/runtime/test_b.py",
            "tests/runtime/test_c.py",
            "tests/runtime/test_d.py",
        ]
        problems = self.check(collected(), on_disk=on_disk)
        self.assertTrue(
            any("no collected test" in problem and "test_d.py" in problem for problem in problems), problems
        )

    def test_test_files_are_found_as_pytest_names_them(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for name in (
                "test_x.py",
                "y_test.py",
                "helper.py",
                "conftest.py",
                "sub/test_z.py",
                "__pycache__/test_x.py",
            ):
                (root / name).parent.mkdir(parents=True, exist_ok=True)
                (root / name).write_text("")
            found = [Path(path).relative_to(root).as_posix() for path in pytest_completeness.test_files(root)]
        self.assertEqual(found, ["sub/test_z.py", "test_x.py", "y_test.py"])

    def test_ids_are_not_mistaken_for_collection_trouble(self):
        ids = [*IDS, "tests/runtime/test_d.py::test_error_is_reported[ERROR collected errors]"]
        self.assertEqual(pytest_completeness.collection_trouble(collected(ids)), [])


class Serial(unittest.TestCase):
    """Files of todofy-runtime-serial.txt run alone, after the shard's xdist run, into <name>-<I>-serial.xml."""

    SERIAL = frozenset({"tests/runtime/test_b.py"})

    def check(self, files, shards=2, serial=SERIAL):
        with tempfile.TemporaryDirectory() as tmp:
            paths = []
            for name, cases in files.items():
                path = Path(tmp) / name
                path.write_text(junit(cases))
                paths.append(path)
            return pytest_completeness.check(collected(), paths, shards, set(), set(serial))[0]

    def passing(self):
        return {
            "runtime-0.xml": [(IDS[0], None), (IDS[1], None)],
            "runtime-1.xml": [(IDS[3], None)],
            "runtime-1-serial.xml": [(IDS[2], None)],
        }

    def test_serial_files_in_their_own_run_pass(self):
        self.assertEqual(self.check(self.passing()), [])

    def test_a_serial_file_run_under_xdist_fails(self):
        files = self.passing()
        files["runtime-1.xml"].append(files.pop("runtime-1-serial.xml")[0])
        problems = self.check(files)
        self.assertTrue(any(IDS[2] in problem and "xdist run" in problem for problem in problems), problems)

    def test_another_file_in_a_serial_run_fails(self):
        files = self.passing()
        files["runtime-1-serial.xml"].append(files["runtime-1.xml"].pop())
        problems = self.check(files)
        self.assertTrue(any(IDS[3] in problem and "serial run" in problem for problem in problems), problems)

    def test_a_serial_file_that_was_not_collected_fails(self):
        problems = self.check(self.passing(), serial={*self.SERIAL, "tests/runtime/test_gone.py"})
        self.assertTrue(any("serial files that were not collected" in problem for problem in problems), problems)

    def test_a_serial_file_does_not_stand_in_for_a_missing_shard(self):
        files = self.passing()
        del files["runtime-1.xml"]
        files["runtime-1-serial.xml"].append((IDS[3], None))
        problems = self.check(files, serial={*self.SERIAL, "tests/runtime/test_c.py"})
        self.assertTrue(any("one JUnit file per shard" in problem for problem in problems), problems)

    def test_unexpected_junit_files_fail(self):
        for extra in ("runtime-1-serial.xml", "runtime-2-serial.xml", "runtime-0.xml", "notes.xml"):
            with self.subTest(extra=extra):
                files = self.passing()
                files["other/" + extra if extra in files else extra] = []
                with tempfile.TemporaryDirectory() as tmp:
                    paths = []
                    for name, cases in files.items():
                        path = Path(tmp) / name
                        path.parent.mkdir(parents=True, exist_ok=True)
                        path.write_text(junit(cases))
                        paths.append(path)
                    problems = pytest_completeness.check(collected(), paths, 2, set(), self.SERIAL)[0]
                self.assertTrue(problems, extra)


class JunitKey(unittest.TestCase):
    def test_matches_pytest_junitxml(self):
        self.assertEqual(
            pytest_completeness.junit_key("tests/runtime/test_x.py::test_y[a/b::c.py]"),
            ("tests.runtime.test_x", "test_y[a/b::c.py]"),
        )
        self.assertEqual(
            pytest_completeness.junit_key("tests/runtime/test_x.py::Klass::test_y"),
            ("tests.runtime.test_x.Klass", "test_y"),
        )


class Main(unittest.TestCase):
    def test_exit_code_and_durations_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "ids.txt").write_text(collected())
            (root / "junit").mkdir()
            (root / "junit" / "runtime-0.xml").write_text(junit([(test_id, None) for test_id in IDS]))
            (root / "skips.txt").write_text("# none expected\n")
            args = ["--collected", str(root / "ids.txt"), "--junit-dir", str(root / "junit"), "--shards", "1"]
            args += ["--expected-skips", str(root / "skips.txt"), "--durations-out", str(root / "d.json")]
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(pytest_completeness.main(args), 0)
                self.assertEqual(json.loads((root / "d.json").read_text())["tests/runtime/test_a.py"], 3.0)
                self.assertEqual(pytest_completeness.main([*args[:5], "2"]), 1)

    def test_test_root_and_serial_options(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "ids.txt").write_text(collected())
            (root / "junit").mkdir()
            serial = [test_id for test_id in IDS if test_id.startswith("tests/runtime/test_b.py")]
            (root / "junit" / "runtime-0.xml").write_text(
                junit([(test_id, None) for test_id in IDS if test_id not in serial])
            )
            (root / "junit" / "runtime-0-serial.xml").write_text(junit([(test_id, None) for test_id in serial]))
            (root / "serial.txt").write_text("# alone\ntests/runtime/test_b.py  # timing\n")
            tests = root / "tests" / "runtime"
            tests.mkdir(parents=True)
            for name in ("test_a.py", "test_b.py", "test_c.py", "harness.py"):
                (tests / name).write_text("")
            args = ["--collected", str(root / "ids.txt"), "--junit-dir", str(root / "junit"), "--shards", "1"]
            args += ["--serial", str(root / "serial.txt"), "--test-root", "tests/runtime"]
            cwd = os.getcwd()
            os.chdir(root)
            try:
                with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                    self.assertEqual(pytest_completeness.main(args), 0)
                    (tests / "test_d.py").write_text("")  # on disk, never collected
                    self.assertEqual(pytest_completeness.main(args), 1)
            finally:
                os.chdir(cwd)


if __name__ == "__main__":
    unittest.main()

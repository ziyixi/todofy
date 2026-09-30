"""Unit tests for pytest_shards.py: python3 -m unittest discover -s .github/scripts"""

import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import pytest_shards

DURATIONS = Path(__file__).with_name("todofy-runtime-durations.json")
SERIAL_LIST = Path(__file__).with_name("todofy-runtime-serial.txt")
REPO = Path(__file__).resolve().parents[2]


def ids(files, per_file=2):
    return [f"{path}::test_{n}" for path in files for n in range(per_file)]


FILES = [f"tests/runtime/test_{name}.py" for name in "abcdefghijklmnopqrstuvwxyz"]
WEIGHTS = {path: float((index * 7) % 13 + 1) for index, path in enumerate(FILES)}


class Plan(unittest.TestCase):
    def test_every_file_lands_in_exactly_one_shard_for_every_size(self):
        for total in range(1, 11):
            for workers in (1, 2, 4):
                with self.subTest(total=total, workers=workers):
                    shards = pytest_shards.plan(FILES, WEIGHTS, total, workers)
                    self.assertEqual(len(shards), total)
                    planned = [path for shard in shards for path in shard]
                    self.assertEqual(sorted(planned), FILES)
                    self.assertEqual(len(planned), len(set(planned)))

    def test_each_shard_runs_its_heaviest_files_first(self):
        for shard in pytest_shards.plan(FILES, WEIGHTS, 3, 4):
            self.assertEqual(shard, sorted(shard, key=lambda path: (-WEIGHTS[path], path)))

    def test_the_plan_is_deterministic_and_ignores_input_order(self):
        first = pytest_shards.plan(FILES, WEIGHTS, 3, 4)
        self.assertEqual(pytest_shards.plan(list(reversed(FILES)), dict(reversed(WEIGHTS.items())), 3, 4), first)

    def test_heaviest_files_are_spread_first(self):
        weights = {"a.py": 10, "b.py": 9, "c.py": 1, "d.py": 1}
        self.assertEqual(pytest_shards.plan(sorted(weights), weights, 2), [["a.py", "d.py"], ["b.py", "c.py"]])

    def test_lanes_are_balanced_per_process(self):
        """A file much heavier than the rest gets a process of its own, and the other processes of its
        shard still take their share of the rest (balancing whole shards would leave them idle)."""
        weights = {"big.py": 100.0} | {f"f{n:02}.py": 10.0 for n in range(22)}
        shards = pytest_shards.plan(sorted(weights), weights, 2, 4)
        # Lanes 0, 2, 4, 6 are shard 0: big.py alone in lane 0, three files in each other lane.
        self.assertEqual(shards[0][0], "big.py")
        self.assertEqual([len(shard) for shard in shards], [10, 13])

    def test_a_file_without_a_recorded_duration_is_still_planned(self):
        files = [*FILES, "tests/runtime/test_new.py"]
        shards = pytest_shards.plan(files, WEIGHTS, 4)
        self.assertEqual(sum(shard.count("tests/runtime/test_new.py") for shard in shards), 1)

    def test_durations_of_files_that_are_gone_are_ignored(self):
        shards = pytest_shards.plan(FILES[:3], {"tests/runtime/test_gone.py": 999.0} | WEIGHTS, 3)
        self.assertEqual(sorted(path for shard in shards for path in shard), FILES[:3])

    def test_an_empty_shard_is_refused(self):
        with self.assertRaises(ValueError):
            pytest_shards.plan(FILES[:2], WEIGHTS, 3)
        with self.assertRaises(ValueError):
            pytest_shards.plan(FILES, WEIGHTS, 0)
        with self.assertRaises(ValueError):
            pytest_shards.plan(FILES, WEIGHTS, 2, 0)
        with self.assertRaises(ValueError):  # 2 files: 8 lanes, but a shard with no file at all
            pytest_shards.plan(FILES[:2], WEIGHTS, 3, 4)

    def test_files_come_from_test_ids_only(self):
        output = [*ids(FILES[:2]), "", "4 tests collected in 0.1s", "tests/runtime/conftest.py"]
        self.assertEqual(pytest_shards.collected_files(output), FILES[:2])


class SerialFiles(unittest.TestCase):
    """Files of todofy-runtime-serial.txt run alone after a shard's xdist run, never in a lane."""

    SERIAL = (FILES[0], FILES[5])

    def test_every_file_lands_once_in_the_lanes_or_alone(self):
        for total in range(1, 6):
            with self.subTest(total=total):
                shards, placed = pytest_shards.plan_with_serial(FILES, WEIGHTS, total, 4, self.SERIAL)
                lanes = [path for shard in shards for path in shard]
                alone = [path for group in placed for path in group]
                self.assertEqual(sorted(alone), sorted(self.SERIAL))
                self.assertFalse(set(lanes) & set(self.SERIAL))
                self.assertEqual(sorted(lanes + alone), FILES)
                self.assertEqual(len(lanes + alone), len(set(lanes + alone)))

    def test_serial_files_go_to_the_least_loaded_shards(self):
        weights = {"a.py": 40.0, "b.py": 20.0, "s1.py": 5.0, "s2.py": 3.0}
        shards, placed = pytest_shards.plan_with_serial(sorted(weights), weights, 2, 1, ["s1.py", "s2.py"])
        self.assertEqual(shards, [["a.py"], ["b.py"]])
        self.assertEqual(placed, [[], ["s1.py", "s2.py"]])

    def test_a_listed_file_that_was_not_collected_is_refused(self):
        with self.assertRaises(ValueError):
            pytest_shards.plan_with_serial(FILES, WEIGHTS, 3, 4, ["tests/runtime/test_renamed.py"])

    def test_the_list_file_allows_comments(self):
        self.assertEqual(pytest_shards.listed_files("# why\n\n tests/runtime/test_a.py  # timing\n"), [FILES[0]])

    def test_the_repository_list_names_runtime_files_that_exist(self):
        listed = pytest_shards.listed_files(SERIAL_LIST.read_text())
        self.assertTrue(listed)
        for path in listed:
            with self.subTest(path=path):
                self.assertRegex(path, r"^tests/runtime/test_\w+\.py$")
                self.assertTrue((REPO / "todofy" / path).is_file())


class Main(unittest.TestCase):
    def run_main(self, *args, collected=None):
        with tempfile.TemporaryDirectory() as tmp:
            ids_file = Path(tmp) / "ids.txt"
            ids_file.write_text("\n".join(collected if collected is not None else ids(FILES)) + "\n")
            weights_file = Path(tmp) / "durations.json"
            weights_file.write_text(json.dumps(WEIGHTS))
            out, err = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                code = pytest_shards.main(["--collected", str(ids_file), "--durations", str(weights_file), *args])
            return code, out.getvalue().split(), err.getvalue()

    def test_the_union_of_every_index_is_the_collection(self):
        for total, workers in ((6, 1), (3, 4)):
            seen = []
            for index in range(total):
                code, files, _ = self.run_main("--index", str(index), "--total", str(total), "--workers", str(workers))
                self.assertEqual(code, 0)
                self.assertTrue(files)
                self.assertEqual(files, sorted(files, key=lambda path: (-WEIGHTS[path], path)))
                seen += files
            self.assertEqual(sorted(seen), FILES)
            self.assertEqual(len(seen), len(set(seen)))

    def test_an_index_out_of_range_is_refused(self):
        for index in ("-1", "6"):
            with self.subTest(index=index):
                code, files, err = self.run_main("--index", index, "--total", "6")
                self.assertEqual((code, files), (1, []))
                self.assertIn("index", err)
        code, files, _ = self.run_main("--total", "6")
        self.assertEqual((code, files), (1, []))

    def test_serial_out_gets_the_shards_serial_files_and_stdout_the_rest(self):
        with tempfile.TemporaryDirectory() as tmp:
            serial_list = Path(tmp) / "serial.txt"
            serial_list.write_text(f"# alone\n{FILES[0]}\n")
            seen, alone = [], []
            for index in range(3):
                out = Path(tmp) / f"serial-{index}.txt"
                code, files, _ = self.run_main(
                    "--index",
                    str(index),
                    "--total",
                    "3",
                    "--workers",
                    "4",
                    "--serial",
                    str(serial_list),
                    "--serial-out",
                    str(out),
                )
                self.assertEqual(code, 0)
                seen += files
                alone += out.read_text().split()
        self.assertEqual(alone, [FILES[0]])
        self.assertNotIn(FILES[0], seen)
        self.assertEqual(sorted(seen + alone), FILES)

    def test_serial_without_serial_out_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            serial_list = Path(tmp) / "serial.txt"
            serial_list.write_text(f"{FILES[0]}\n")
            code, files, err = self.run_main("--index", "0", "--total", "3", "--serial", str(serial_list))
        self.assertEqual((code, files), (1, []))
        self.assertIn("--serial-out", err)

    def test_no_collected_ids_is_refused(self):
        code, files, err = self.run_main("--index", "0", "--total", "1", collected=["no tests ran"])
        self.assertEqual((code, files), (1, []))
        self.assertIn("no test ids", err)


class RecordedDurations(unittest.TestCase):
    def test_the_recorded_weights_are_positive_seconds_of_runtime_files(self):
        durations = json.loads(DURATIONS.read_text())
        self.assertTrue(durations)
        for path, seconds in durations.items():
            with self.subTest(path=path):
                self.assertRegex(path, r"^tests/runtime/test_\w+\.py$")
                self.assertIsInstance(seconds, (int, float))
                self.assertGreaterEqual(seconds, 0)


if __name__ == "__main__":
    unittest.main()

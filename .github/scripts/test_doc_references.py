"""References to D1 migration files anywhere in the repository name files that exist:
python3 -m unittest discover -s .github/scripts

A migration renumbered at a merge (Todofy's task intents went from 0004 to 0005 after GTD's 0004_gtd.sql) leaves
stale names in docs and comments that no test would otherwise notice. A path with its folder
(`todofy/migrations/0005_task_intents.sql`) must exist as written; a bare file name (`0003_ops.sql`) must be
some app's migration. A line may keep an old name only when it says it was renumbered (a dated record of what
was run then). Test files are skipped: they build synthetic migrations of their own. Standard library only.
"""

import re
import subprocess
import unittest
from collections.abc import Callable
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
REFERENCE = re.compile(r"(?<![\w.-])((?:[\w.-]+/)*migrations/)?(\d{4}_[A-Za-z0-9_]+\.sql)\b")
# A line that records an old name on purpose.
RENUMBERED = re.compile(r"renumbered", re.I)
TEXT_SUFFIXES = {".md", ".py", ".ts", ".tsx", ".mjs", ".js", ".toml", ".yml", ".yaml", ".sql", ".json", ".txt"}


def tracked_files() -> list[str]:
    output = subprocess.run(
        ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
        cwd=REPO,
        capture_output=True,
        check=True,
        text=True,
    ).stdout
    return [path for path in output.split("\0") if path and (REPO / path).is_file()]


def is_test(path: str) -> bool:
    parts = path.split("/")
    name = parts[-1]
    return (
        name.startswith("test_")
        or ".test." in name
        or name.endswith("_test.py")
        or any(part in {"test", "tests", "fixtures"} for part in parts[:-1])
    )


def read_file(path: str) -> str:
    return (REPO / path).read_text(errors="replace")


def stale_references(files: list[str], read: Callable[[str], str] = read_file) -> list[str]:
    migrations = [path for path in files if re.fullmatch(r"(?:[\w.-]+/)*migrations/\d{4}_[A-Za-z0-9_]+\.sql", path)]
    names = {path.rsplit("/", 1)[1] for path in migrations}
    found = []
    for path in files:
        if Path(path).suffix not in TEXT_SUFFIXES or is_test(path) or "node_modules/" in path:
            continue
        for number, line in enumerate(read(path).splitlines(), 1):
            if RENUMBERED.search(line):
                continue
            for folder, name in REFERENCE.findall(line):
                if folder and "/" in folder[: -len("migrations/")]:
                    ok = f"{folder}{name}" in migrations
                else:
                    ok = name in names
                if not ok:
                    found.append(f"{path}:{number}: {folder}{name}")
    return found


class MigrationReferences(unittest.TestCase):
    def test_every_named_migration_exists(self):
        self.assertEqual(stale_references(tracked_files()), [])

    def test_the_check_sees_a_stale_path_a_stale_name_and_allows_a_renumbered_record(self):
        probe = "todofy/docs/probe.md"
        texts = {
            probe: "migration `todofy/migrations/0004_task_intents.sql`\n"
            "bare `0004_task_intents.sql`\n"
            "then `0004_task_intents.sql` (renumbered 0005 at merge)\n"
            "fine `todofy/migrations/0005_task_intents.sql`, `migrations/0001_init.sql` and `0003_ops.sql`\n"
            "wrong app `links/migrations/0003_ops.sql`\n",
            "todofy/tests/unit/test_probe.py": "LATER = '9999_later.sql'\n",
        }
        files = [
            "todofy/migrations/0001_init.sql",
            "todofy/migrations/0003_ops.sql",
            "todofy/migrations/0005_task_intents.sql",
            "links/migrations/0001_init.sql",
            *texts,
        ]
        self.assertEqual(
            stale_references(files, lambda path: texts.get(path, "")),
            [
                f"{probe}:1: todofy/migrations/0004_task_intents.sql",
                f"{probe}:2: 0004_task_intents.sql",
                f"{probe}:5: links/migrations/0003_ops.sql",
            ],
        )


if __name__ == "__main__":
    unittest.main()

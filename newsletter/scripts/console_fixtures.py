"""Write or check newsletter.ui.v1's golden answers over a synthetic database.

The files in contracts/newsletter-ui-v1/fixtures/ are what Newsletter's
console listener sends for the synthetic world of
tests/support/console_world.py: its reader's answers written by the same
encoder the listener uses, byte for byte, with no trailing newline. The
console Worker's tests read each back with the TypeScript codec and write it
again, which proves the Worker may pass Newsletter's bytes through unparsed.

Run from newsletter/: ``uv run --locked python scripts/console_fixtures.py``
checks them; ``--update`` rewrites them after a deliberate change.
"""

from __future__ import annotations

import argparse
import pathlib
import sys
import tempfile

import ziyixi_proto.newsletter.ui.v1.newsletter_ui_service_pb as service_pb

import newsletter.console_api as console_api
import newsletter.console_read as console_read

ROOT = pathlib.Path(__file__).resolve().parents[1]
FIXTURES = ROOT.parent / "contracts" / "newsletter-ui-v1" / "fixtures"
sys.path.insert(0, str(ROOT))
import tests.support.console_world as console_world  # noqa: E402


def answers(reader: console_read.ConsoleReader) -> dict[str, bytes]:
    """Each fixture's name and the exact bytes the listener sends for it."""
    world = console_world
    messages = {
        "overview": reader.overview(healthy=True),
        "runs": reader.list_runs(service_pb.ListRunsRequest()),
        "run-blocked-selection-timeout": reader.get_run(
            service_pb.GetRunRequest(name="runs/" + world.RUN_28)
        ),
        "run-ready": reader.get_run(
            service_pb.GetRunRequest(name="runs/" + world.RUN_27)
        ),
        "model-calls": reader.list_model_calls(
            service_pb.ListModelCallsRequest(parent="runs/" + world.RUN_27)
        ),
        "model-usage-30d": reader.summarize_model_usage(
            service_pb.SummarizeModelUsageRequest(day_count=30)
        ),
        "editions": reader.list_editions(service_pb.ListEditionsRequest()),
        "edition": reader.get_edition(
            service_pb.GetEditionRequest(name="editions/" + world.EDITION_27)
        ),
        "edition-rendering": reader.get_edition_rendering(
            service_pb.GetEditionRenderingRequest(
                name="editions/" + world.EDITION_27 + "/rendering"
            )
        ),
        "source-catalog": reader.get_source_catalog(
            service_pb.GetSourceCatalogRequest(name="sourceCatalog")
        ),
        "backup-status": reader.get_backup_status(
            service_pb.GetBackupStatusRequest(name="backupStatus")
        ),
    }
    return {name: console_api.encode(m) for name, m in messages.items()}


def generate() -> dict[str, bytes]:
    """Build the world in a temporary directory and read every answer."""
    with tempfile.TemporaryDirectory(prefix="newsletter-console-") as name:
        world = console_world.build(pathlib.Path(name))
        try:
            return answers(world.reader)
        finally:
            world.close()


def stale(expected: dict[str, bytes], folder: pathlib.Path) -> list[str]:
    """The fixture files that differ from ``expected`` (or are extra)."""
    present = {path.stem for path in folder.glob("*.json")}
    names = sorted(present | set(expected))
    return [
        name
        for name in names
        if name not in expected
        or not (folder / f"{name}.json").is_file()
        or (folder / f"{name}.json").read_bytes() != expected[name]
    ]


def main() -> int:
    """Check the fixtures, or rewrite them with --update."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--update", action="store_true")
    args = parser.parse_args()
    expected = generate()
    if args.update:
        FIXTURES.mkdir(parents=True, exist_ok=True)
        for path in FIXTURES.glob("*.json"):
            if path.stem not in expected:
                path.unlink()
        for name, body in expected.items():
            (FIXTURES / f"{name}.json").write_bytes(body)
        print(f"Wrote {len(expected)} fixtures.")
        return 0
    differing = stale(expected, FIXTURES)
    for name in differing:
        print(f"{name}.json differs; run with --update after review")
    return int(bool(differing))


if __name__ == "__main__":
    raise SystemExit(main())

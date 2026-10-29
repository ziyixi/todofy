"""The console reads without writing, locking or registering anything."""

import concurrent.futures
import hashlib
import sqlite3

import pytest
import ziyixi_proto.newsletter.ui.v1.newsletter_ui_service_pb as service_pb
import ziyixi_proto.newsletter.ui.v1.run_pb as run_pb

import tests.support.console_world as console_world


@pytest.fixture
def world(tmp_path):
    built = console_world.build(tmp_path)
    # Settle the WAL so the file's bytes are the whole database.
    built.store.db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    yield built
    built.close()


def _every_answer(reader):
    run = "runs/" + console_world.RUN_27
    edition = "editions/" + console_world.EDITION_27
    return [
        reader.overview(healthy=True),
        reader.list_runs(service_pb.ListRunsRequest()),
        reader.get_run(service_pb.GetRunRequest(name=run)),
        reader.list_model_calls(service_pb.ListModelCallsRequest(parent=run)),
        reader.summarize_model_usage(
            service_pb.SummarizeModelUsageRequest(day_count=90)
        ),
        reader.list_editions(service_pb.ListEditionsRequest()),
        reader.get_edition(service_pb.GetEditionRequest(name=edition)),
        reader.get_edition_rendering(
            service_pb.GetEditionRenderingRequest(name=edition + "/rendering")
        ),
        reader.get_source_catalog(
            service_pb.GetSourceCatalogRequest(name="sourceCatalog")
        ),
        reader.get_backup_status(
            service_pb.GetBackupStatusRequest(name="backupStatus")
        ),
    ]


def _state(world):
    path = world.settings.data_dir / "newsletter.sqlite3"
    files = sorted(world.settings.data_dir.iterdir())
    return (
        hashlib.sha256(path.read_bytes()).hexdigest(),
        [p.name for p in files],
        world.store.db.execute("PRAGMA data_version").fetchone()[0],
        world.store.db.execute(
            "SELECT COUNT(*) FROM deployment_activities"
        ).fetchone()[0],
        world.store.db.execute(
            "SELECT name FROM sqlite_master ORDER BY name"
        ).fetchall(),
    )


def test_reading_every_answer_changes_nothing(world):
    before = _state(world)
    _every_answer(world.reader)
    assert _state(world) == before


def test_the_connection_refuses_every_write(world):
    with world.reader.snapshot() as snap:
        for statement in (
            "INSERT INTO metadata VALUES ('x','y')",
            "UPDATE editions SET state='failed'",
            "DELETE FROM collection_runs",
            "CREATE TABLE monitoring_unknowns (x)",
            "PRAGMA journal_mode=DELETE",
            "ATTACH DATABASE ':memory:' AS other",
        ):
            with pytest.raises(sqlite3.DatabaseError):
                snap.db.execute(statement)
    assert (
        world.store.db.execute(
            "SELECT COUNT(*) FROM metadata WHERE key='x'"
        ).fetchone()[0]
        == 0
    )


def test_reads_continue_beside_an_open_write_and_the_engines_lock(world):
    world.store.db.execute("BEGIN IMMEDIATE")
    world.store.db.execute(
        "UPDATE collection_runs SET state='failed' WHERE id=?",
        (console_world.RUN_29,),
    )
    with (
        world.store.lock,
        concurrent.futures.ThreadPoolExecutor(1) as pool,
    ):
        # Another thread, so holding the store's RLock here would block a
        # reader that took it.
        answers = pool.submit(_every_answer, world.reader).result(timeout=20)
    world.store.db.execute("ROLLBACK")
    # The uncommitted change is invisible: one consistent snapshot.
    assert answers[0].latest_run.state == run_pb.Run_State.READY


def test_one_answer_reads_one_snapshot(world):
    query = "SELECT COUNT(*) FROM metadata WHERE key='later'"
    with world.reader.snapshot() as snap:
        assert snap.one(query)[0] == 0
        world.store.db.execute("INSERT INTO metadata VALUES ('later','x')")
        # Committed after the snapshot began: not part of this answer.
        assert snap.one(query)[0] == 0
    with world.reader.snapshot() as snap:
        assert snap.one(query)[0] == 1

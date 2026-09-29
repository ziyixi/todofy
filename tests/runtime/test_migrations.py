import pytest

from tests.runtime.harness import AUTH, ROOT, Worker, event_body


def test_all_migrations_are_applied(worker: Worker) -> None:
    files = sorted(path.name for path in (ROOT / "migrations").glob("*.sql"))
    if not files:
        pytest.skip("no D1 migrations in the tree yet")
    assert [row["name"] for row in worker.d1("SELECT name FROM d1_migrations ORDER BY id")] == files


def test_worker_writes_land_in_the_persisted_d1_that_wrangler_reads(worker: Worker) -> None:
    event_id, body = event_body()
    assert worker.hooks.post("/hooks/mail", content=body, headers=AUTH).status_code == 204
    rows = worker.d1(f"SELECT body_bytes FROM spike_events WHERE event_id = '{event_id}'")
    assert rows == [{"body_bytes": len(body)}]

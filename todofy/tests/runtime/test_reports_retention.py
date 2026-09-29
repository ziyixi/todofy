"""retention.tick in real workerd: bounded deletes of expired rows, imported and
recent rows kept, and mail_events never touched."""

from tests.runtime.reports_support import NOW, Probe, clean_fixture, probe_fixture  # noqa: F401

DAY = 86_400
HASH = "0" * 64


def count(probe: Probe, table: str) -> int:
    return probe.sql(f"SELECT count(*) AS n FROM {table}")[0]["n"]


def seed_report(probe: Probe, day: str) -> None:
    probe.insert(
        "daily_reports",
        kind="summary",
        top_n=0,
        day=day,
        status="ok",
        payload_json="{}",
        task_count=1,
        window_start=0,
        window_end=0,
        computed_at=0,
    )


def test_expired_rows_go_and_everything_else_stays(probe):
    old = NOW - 400 * DAY
    probe.insert(
        "mail_events",
        source_id="mail-hero-personal",
        event_id="ancient",
        payload_hash=HASH,
        state="complete",
        created_at=old,
        updated_at=old,
    )
    probe.insert("summaries", event_id="old", created_at=NOW - 91 * DAY, subject="s", summary="x", model="m")
    probe.insert("summaries", event_id="recent", created_at=NOW - 89 * DAY, subject="s", summary="x", model="m")
    probe.insert("summaries", event_id="imported", created_at=old, subject="s", summary="x", model="m", imported=1)
    seed_report(probe, "2026-06-01")
    seed_report(probe, "2026-09-01")
    for created, request in ((NOW - 181 * DAY, "old"), (NOW - 179 * DAY, "recent")):
        probe.insert(
            "owner_actions",
            owner="owner@example.com",
            action_request_id=request,
            kind="dismiss",
            request_hash="h",
            created_at=created,
        )
    probe.insert("auth_failures", hour="2026-08-01T00", count=3)
    probe.insert("auth_failures", hour="2026-09-27T23", count=3)
    probe.insert("legacy_mail_text", event_id="legacy:gone", created_at=old, text="t", expires_at=NOW)
    probe.insert("legacy_mail_text", event_id="legacy:later", created_at=old, text="t", expires_at=NOW + 1)
    probe.insert("legacy_mail_text", event_id="legacy:forever", created_at=old, text="t")

    assert probe.call("/retention/tick", now=NOW)["more"] is False

    assert [row["event_id"] for row in probe.sql("SELECT event_id FROM summaries ORDER BY event_id")] == [
        "imported",
        "recent",
    ]
    assert [row["day"] for row in probe.sql("SELECT day FROM daily_reports")] == ["2026-09-01"]
    assert [row["action_request_id"] for row in probe.sql("SELECT action_request_id FROM owner_actions")] == ["recent"]
    assert [row["hour"] for row in probe.sql("SELECT hour FROM auth_failures")] == ["2026-09-27T23"]
    assert [row["event_id"] for row in probe.sql("SELECT event_id FROM legacy_mail_text ORDER BY event_id")] == [
        "legacy:forever",
        "legacy:later",
    ]
    assert count(probe, "mail_events") == 1


def test_a_large_backlog_is_deleted_in_bounded_batches(probe):
    statements = [
        ["INSERT INTO auth_failures (hour, count) VALUES (?, 1)", [f"2026-01-{day:02d}T{hour:02d}"]]
        for day in range(1, 6)
        for hour in range(24)
    ]
    probe.call("/d1", statements=statements)
    assert count(probe, "auth_failures") == 120
    assert probe.call("/retention/tick", now=NOW)["more"] is True
    assert count(probe, "auth_failures") == 20
    assert probe.call("/retention/tick", now=NOW)["more"] is False
    assert count(probe, "auth_failures") == 0


def test_legacy_text_retention_days_deletes_old_imported_text(probe):
    probe.insert("legacy_mail_text", event_id="legacy:old", created_at=NOW - 31 * DAY, text="t")
    probe.insert("legacy_mail_text", event_id="legacy:young", created_at=NOW - 29 * DAY, text="t")

    assert probe.call("/retention/tick", now=NOW, vars={"LEGACY_TEXT_RETENTION_DAYS": "0"})["more"] is False
    assert count(probe, "legacy_mail_text") == 2

    assert probe.call("/retention/tick", now=NOW, vars={"LEGACY_TEXT_RETENTION_DAYS": "30"})["more"] is False
    assert [row["event_id"] for row in probe.sql("SELECT event_id FROM legacy_mail_text")] == ["legacy:young"]

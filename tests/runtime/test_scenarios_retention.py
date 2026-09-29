"""Daily retention (v2 plan §5.3): expired rows go, boundary rows, imported summaries and the ledger stay."""

import time
import uuid

from tests.runtime.harness import Worker, wait_until

DAY = 86400


def _day(timestamp: int) -> str:
    return time.strftime("%Y-%m-%d", time.gmtime(timestamp))


def _hour(timestamp: int) -> str:
    return time.strftime("%Y-%m-%dT%H", time.gmtime(timestamp))


def test_first_sweep_removes_only_expired_rows(worker: Worker) -> None:
    now = int(time.time())
    ids = {name: str(uuid.uuid4()) for name in ("old", "recent", "imported", "ledger", "gone", "forever", "later")}
    worker.d1(
        "INSERT INTO summaries (event_id, created_at, subject, summary, model, imported) VALUES"
        f" ('{ids['old']}', {now - 91 * DAY}, 's', 'x', 'm', 0),"
        f" ('{ids['recent']}', {now - 89 * DAY}, 's', 'x', 'm', 0),"
        f" ('{ids['imported']}', {now - 400 * DAY}, 's', 'x', 'm', 1);"
        "INSERT INTO daily_reports (kind, top_n, day, status, payload_json, task_count, window_start, window_end,"
        f" computed_at) VALUES ('summary', 0, '{_day(now - 91 * DAY)}', 'ok', '{{}}', 1, 0, 0, 0),"
        f" ('summary', 0, '{_day(now - 89 * DAY)}', 'ok', '{{}}', 1, 0, 0, 0);"
        "INSERT INTO owner_actions (owner, action_request_id, kind, request_hash, created_at) VALUES"
        f" ('owner@example.com', 'old', 'reconcile', 'h', {now - 181 * DAY}),"
        f" ('owner@example.com', 'recent', 'reconcile', 'h', {now - 179 * DAY});"
        "INSERT INTO auth_failures (hour, count) VALUES"
        f" ('{_hour(now - 31 * DAY)}', 3), ('{_hour(now - 29 * DAY)}', 3);"
        "INSERT INTO legacy_mail_text (event_id, created_at, text, expires_at) VALUES"
        f" ('{ids['gone']}', {now - 100 * DAY}, 't', {now - 60}),"
        f" ('{ids['forever']}', {now - 100 * DAY}, 't', NULL),"
        f" ('{ids['later']}', {now - 100 * DAY}, 't', {now + DAY});"
        "INSERT INTO mail_events (source_id, event_id, payload_hash, state, imported, created_at, updated_at)"
        f" VALUES ('mail-hero-personal', '{ids['ledger']}', '{'0' * 64}', 'complete', 1, {now - 800 * DAY},"
        f" {now - 800 * DAY})"
    )

    assert worker.trigger_cron().status_code == 200

    def swept() -> list[dict] | None:
        rows = worker.d1(
            "SELECT (SELECT group_concat(event_id) FROM (SELECT event_id FROM summaries ORDER BY event_id)) AS s,"
            f" (SELECT count(*) FROM daily_reports WHERE day < '{_day(now - 30 * DAY)}') AS r,"
            " (SELECT group_concat(action_request_id) FROM owner_actions) AS o,"
            " (SELECT count(*) FROM auth_failures) AS a,"
            " (SELECT group_concat(event_id) FROM (SELECT event_id FROM legacy_mail_text ORDER BY event_id)) AS t,"
            f" (SELECT count(*) FROM mail_events WHERE event_id = '{ids['ledger']}') AS e"
        )
        return rows if rows[0]["a"] == 1 else None

    [row] = wait_until(swept, 30, "retention sweep")
    assert set(row["s"].split(",")) == {ids["recent"], ids["imported"]}
    assert (row["r"], row["o"], row["a"], row["e"]) == (1, "recent", 1, 1)
    assert set(row["t"].split(",")) == {ids["forever"], ids["later"]}
    assert worker.owner.get(f"/api/v1/legacy_text/{ids['gone']}").status_code == 404
    kept = worker.owner.get(f"/api/v1/legacy_text/{ids['forever']}")
    assert (kept.status_code, kept.json()["expires_at"]) == (200, None)

"""Test corrected-issue sends without erasing normal delivery receipts."""

import concurrent.futures as concurrent_futures
import functools
import pathlib
import sqlite3
import threading

import fastapi.testclient as testclient
import httpx
import pytest

import newsletter.app as app
import newsletter.contracts as contracts
import newsletter.delivery as delivery
import newsletter.editor as editor
import newsletter.settings as newsletter_settings
import newsletter.store as newsletter_store


def auth(role="send"):
    return {
        "Authorization": "Bearer "
        + {"send": "s", "editor": "e", "ingest": "i"}[role] * 32
    }


@pytest.fixture
def client(tmp_path):
    settings = newsletter_settings.Settings(
        data_dir=tmp_path / "data",
        editor_token="e" * 32,
        send_token="s" * 32,
    )
    with testclient.TestClient(
        app.create_app(settings, editor=editor.MockEditor(), start_worker=False)
    ) as value:
        yield value


def issue(client, key, *, issue_date="2026-09-06"):
    packet = client.app.state.store.put_packet(
        {
            "request_key": "packet",
            "workflow_id": "verification-offline-test",
            "content": {
                "title": "Fixture",
                "body": "Synthetic offline source.",
                "sources": [
                    {
                        "id": "source",
                        "title": "Fixture source",
                        "url": "https://example.org/fixture",
                        "excerpt": "Fixture.",
                        "access_scope": "full_text",
                    }
                ],
            },
        }
    )
    queued = client.app.state.store.prepare(
        {
            "request_key": key,
            "issue_date": issue_date,
            "packet_ids": [packet["id"]],
        }
    )
    client.portal.call(client.app.state.worker.step)
    result = client.app.state.store.get(queued["id"])
    assert result["state"] == "ready"
    return result


def send(
    client,
    edition,
    *,
    verification=False,
    key="normal",
    role="send",
    digest=None,
    after=None,
):
    """Exercise the shared operation, not a verification HTTP route."""
    request = {
        "id": edition["id"],
        "request_key": key,
        "expected_render_hash": digest or edition["rendered"]["render_hash"],
    }
    if not verification:
        headers = auth(role)
        if after is not None:
            headers["X-Newsletter-Verification-After"] = after
        return client.post(
            f"/v1/editions/{edition['id']}/send",
            headers=headers,
            json=request,
        )
    try:
        value = client.portal.call(
            functools.partial(
                delivery.send_edition,
                client.app.state.store,
                client.app.state.mail,
                request,
                real_delivery=False,
                verification=True,
                predecessor=after,
            )
        )
        return httpx.Response(200, json=value)
    except (newsletter_store.StoreError, contracts.ContractError) as error:
        status = 409 if error.code == "conflict" else 400
        return httpx.Response(status, json={"error": {"code": error.code}})


def test_verification_is_separate_idempotent_and_preserves_daily_guard(client):
    original = issue(client, "original")
    assert send(client, original).json()["delivery_state"] == "simulated"
    old_receipt = tuple(
        client.app.state.store.db.execute("SELECT * FROM sends").fetchone()
    )
    corrected = issue(client, "corrected")
    assert send(client, corrected, key="normal-again").status_code == 409
    assert (
        send(client, corrected, verification=True, digest="0" * 64).status_code
        == 409
    )
    first = send(
        client, corrected, verification=True, key="explicit-correction"
    )
    assert (
        first.status_code == 200
        and first.json()["delivery_state"] == "simulated"
    )
    assert (
        send(
            client, corrected, verification=True, key="explicit-correction"
        ).json()
        == first.json()
    )
    assert (
        send(client, corrected, verification=True, key="another-key").json()
        == first.json()
    )
    third = issue(client, "third")
    assert (
        send(client, third, verification=True, key="third-key").status_code
        == 409
    )
    assert send(client, third, key="normal-third").status_code == 409
    assert (
        tuple(
            client.app.state.store.db.execute("SELECT * FROM sends").fetchone()
        )
        == old_receipt
    )
    assert (
        client.app.state.store.db.execute(
            "SELECT COUNT(*) FROM verification_sends"
        ).fetchone()[0]
        == 1
    )
    assert len(list(client.app.state.mail.directory.glob("*.eml"))) == 2


@pytest.mark.parametrize(
    "state", ["not_requested", "submitting", "rejected", "unknown"]
)
def test_verification_cannot_bypass_unconfirmed_original(client, state):
    original = issue(client, "original")
    if state != "not_requested":
        assert send(client, original).status_code == 200
        client.app.state.store.finish(original["id"], delivery_state=state)
    corrected = issue(client, "corrected")
    assert send(client, corrected, verification=True).status_code == 409
    assert (
        client.app.state.store.db.execute(
            "SELECT COUNT(*) FROM verification_sends"
        ).fetchone()[0]
        == 0
    )


def test_verification_never_resends_original_edition(client):
    original = issue(client, "original")
    assert send(client, original).status_code == 200
    assert send(client, original, verification=True).status_code == 409


def test_ambiguous_verification_stays_unknown_after_recovery(client):
    original = issue(client, "original")
    assert send(client, original).status_code == 200
    corrected = issue(client, "corrected")

    class UncertainMail:
        calls = 0

        async def send(self, edition, idempotency_key):
            self.calls += 1
            raise TimeoutError("Private provider diagnostic must not appear")

    adapter = UncertainMail()
    client.app.state.mail = adapter
    first = send(client, corrected, verification=True, key="verify")
    assert first.json()["delivery_state"] == "unknown"
    client.app.state.store.recover()
    assert (
        send(client, corrected, verification=True, key="different").json()[
            "delivery_state"
        ]
        == "unknown"
    )
    assert adapter.calls == 1
    assert "Private provider" not in first.text


def test_verification_checks_path_and_key_binding(client):
    original = issue(client, "original")
    assert send(client, original).status_code == 200
    corrected = issue(client, "corrected")
    assert (
        send(
            client, corrected, verification=True, key="verification"
        ).status_code
        == 200
    )
    third = issue(client, "third")
    assert (
        send(client, third, verification=True, key="verification").status_code
        == 409
    )
    assert (
        client.post(
            f"/v1/editions/{third['id']}/send-verification",
            headers=auth(),
            json={
                "id": corrected["id"],
                "request_key": "verification",
                "expected_render_hash": corrected["rendered"]["render_hash"],
            },
        ).status_code
        == 404
    )


@pytest.mark.parametrize("same_edition", [True, False])
@pytest.mark.parametrize("extension", [True, False])
def test_simultaneous_verification_reservations_use_one_durable_receipt(
    client, same_edition, extension
):
    original = issue(client, "original")
    assert send(client, original).status_code == 200
    predecessor = None
    if extension:
        prior = issue(client, "first-verification")
        assert (
            send(
                client, prior, verification=True, key="first-verification"
            ).status_code
            == 200
        )
        predecessor = prior["id"]
    corrected = issue(client, "corrected")
    rival = corrected if same_edition else issue(client, "competing-correction")
    store = client.app.state.store
    original_receipt = tuple(store.db.execute("SELECT * FROM sends").fetchone())
    database = pathlib.Path(
        store.db.execute("PRAGMA database_list").fetchone()[2]
    )
    barrier = threading.Barrier(2, timeout=5)

    def reserve(edition, key):
        # Separate connections exercise SQLite's transaction boundary, not just
        # one app instance's Python lock. No mail provider is called in this
        # test.
        connection = newsletter_store.Store(database, "mock")
        try:
            barrier.wait()
            try:
                value, first = connection.reserve_verification_send(
                    {
                        "id": edition["id"],
                        "request_key": key,
                        "expected_render_hash": edition["rendered"][
                            "render_hash"
                        ],
                    },
                    previous_verification_id=predecessor,
                )
                return value, first
            except newsletter_store.StoreError as exc:
                return None, exc.code
        finally:
            connection.close()

    with concurrent_futures.ThreadPoolExecutor(max_workers=2) as executor:
        futures = [
            executor.submit(reserve, corrected, "verification-a"),
            executor.submit(reserve, rival, "verification-b"),
        ]
        outcomes = [future.result(timeout=10) for future in futures]
    flags = [first for _, first in outcomes]
    assert flags.count(True) == 1
    assert flags.count(False if same_edition else "conflict") == 1
    accepted = next(edition for edition, first in outcomes if first is True)
    assert accepted["delivery_state"] == "submitting"
    assert store.db.execute(
        "SELECT COUNT(*) FROM verification_sends"
    ).fetchone()[0] == (2 if extension else 1)
    assert (
        tuple(store.db.execute("SELECT * FROM sends").fetchone())
        == original_receipt
    )

    # A crash after reservation has an unknown outcome, even with a fresh
    # connection and a different key. It cannot authorize another provider call.
    reopened = newsletter_store.Store(database, "mock")
    try:
        reopened.recover()
        recovered, first = reopened.reserve_verification_send(
            {
                "id": accepted["id"],
                "request_key": "after-restart",
                "expected_render_hash": accepted["rendered"]["render_hash"],
            },
            previous_verification_id=predecessor,
        )
        assert not first and recovered["delivery_state"] == "unknown"
        assert recovered["rendered"] == accepted["rendered"]
        assert (
            tuple(reopened.db.execute("SELECT * FROM sends").fetchone())
            == original_receipt
        )
    finally:
        reopened.close()


def test_explicit_successor_keeps_receipts_and_default_cap_and_provider_keys(
    client,
):
    original = issue(client, "original")
    assert send(client, original).status_code == 200
    prior = issue(client, "first-verification")
    first = send(
        client, prior, verification=True, key="first-verification"
    ).json()
    store = client.app.state.store
    daily_receipt = tuple(store.db.execute("SELECT * FROM sends").fetchone())
    prior_receipt = tuple(
        store.db.execute("SELECT * FROM verification_sends").fetchone()
    )
    new = issue(client, "fresh-test")
    real_adapter = client.app.state.mail
    keys = []

    class RecordingMail:
        async def send(self, edition, idempotency_key):
            keys.append(idempotency_key)
            return await real_adapter.send(edition, idempotency_key)

    client.app.state.mail = RecordingMail()
    assert send(client, new, key="ordinary-new").status_code == 409
    assert (
        send(client, new, verification=True, key="new-test").status_code == 409
    )
    assert (
        send(
            client,
            new,
            verification=True,
            key="first-verification",
            after=prior["id"],
        ).status_code
        == 409
    )
    assert (
        send(
            client,
            new,
            verification=True,
            key="new-test",
            after=prior["id"],
            digest="0" * 64,
        ).status_code
        == 409
    )
    result = send(
        client, new, verification=True, key="new-test", after=prior["id"]
    )
    assert (
        result.status_code == 200
        and result.json()["delivery_state"] == "simulated"
    )
    assert keys == ["newsletter-verification-" + new["id"]]
    assert result.json()["rendered"] == new["rendered"]
    assert (
        tuple(store.db.execute("SELECT * FROM sends").fetchone())
        == daily_receipt
    )
    assert (
        tuple(
            store.db.execute(
                "SELECT * FROM verification_sends WHERE edition_id=?",
                (prior["id"],),
            ).fetchone()
        )
        == prior_receipt
    )
    new_receipt = store.db.execute(
        "SELECT * FROM verification_sends WHERE edition_id=?", (new["id"],)
    ).fetchone()
    assert new_receipt["request_key"] == "new-test"
    assert new_receipt["previous_edition_id"] == prior["id"]
    # Prior receipts remain idempotent after a successor, with or without the
    # original header. Neither a different key nor recovery resubmits them.
    store.recover()
    assert (
        send(client, prior, verification=True, key="first-verification").json()
        == first
    )
    assert (
        send(
            client, new, verification=True, key="new-test", after=prior["id"]
        ).json()
        == result.json()
    )
    assert (
        send(client, new, verification=True, key="different-key").json()
        == result.json()
    )
    assert (
        send(
            client, new, verification=True, key="new-test", after=new["id"]
        ).status_code
        == 409
    )
    another = issue(client, "not-authorized")
    assert (
        send(client, another, verification=True, key="another").status_code
        == 409
    )
    assert (
        send(
            client, another, verification=True, key="another", after=prior["id"]
        ).status_code
        == 409
    )
    assert send(client, another, key="ordinary-another").status_code == 409
    assert len(keys) == 1


@pytest.mark.parametrize(
    "state", ["not_requested", "submitting", "rejected", "unknown"]
)
def test_explicit_successor_cannot_bypass_unconfirmed_verification(
    client, state
):
    original = issue(client, "original")
    assert send(client, original).status_code == 200
    prior = issue(client, "first-verification")
    assert (
        send(client, prior, verification=True, key="prior").status_code == 200
    )
    client.app.state.store.finish(prior["id"], delivery_state=state)
    new = issue(client, "fresh-test")
    assert (
        send(
            client, new, verification=True, key="fresh", after=prior["id"]
        ).status_code
        == 409
    )
    assert (
        client.app.state.store.db.execute(
            "SELECT COUNT(*) FROM verification_sends"
        ).fetchone()[0]
        == 1
    )


def test_successor_unknown_is_durable_and_blocks_next_even_after_restart(
    client,
):
    original = issue(client, "original")
    assert send(client, original).status_code == 200
    prior = issue(client, "first-verification")
    assert (
        send(client, prior, verification=True, key="prior").status_code == 200
    )
    new = issue(client, "fresh-test")

    class UncertainMail:
        calls = 0

        async def send(self, edition, idempotency_key):
            self.calls += 1
            raise TimeoutError("Private provider detail")

    mail = UncertainMail()
    client.app.state.mail = mail
    assert (
        send(
            client, new, verification=True, key="fresh", after=prior["id"]
        ).json()["delivery_state"]
        == "unknown"
    )
    client.app.state.store.recover()
    assert (
        send(
            client, new, verification=True, key="changed", after=prior["id"]
        ).json()["delivery_state"]
        == "unknown"
    )
    later = issue(client, "later-test")
    for predecessor in (prior["id"], new["id"]):
        assert (
            send(
                client, later, verification=True, key="later", after=predecessor
            ).status_code
            == 409
        )
    assert mail.calls == 1


def test_accepted_tip_cannot_hide_unknown_ancestor(client):
    original = issue(client, "original")
    assert send(client, original).status_code == 200
    ancestor = issue(client, "ancestor")
    assert (
        send(client, ancestor, verification=True, key="ancestor").status_code
        == 200
    )
    tip = issue(client, "tip")
    assert (
        send(
            client, tip, verification=True, key="tip", after=ancestor["id"]
        ).status_code
        == 200
    )
    # An explicit reconciliation can revise an older outcome. A confirmed tip
    # does not permit ignoring that now-unconfirmed ancestor.
    client.app.state.store.finish(ancestor["id"], delivery_state="unknown")
    new = issue(client, "fresh")
    assert (
        send(
            client, new, verification=True, key="fresh", after=tip["id"]
        ).status_code
        == 409
    )
    assert (
        client.app.state.store.get(new["id"])["delivery_state"]
        == "not_requested"
    )
    assert (
        client.app.state.store.db.execute(
            "SELECT COUNT(*) FROM verification_sends"
        ).fetchone()[0]
        == 2
    )


@pytest.mark.parametrize(
    "after",
    ["", "not-a-uuid", "0" * 32, "{00000000-0000-0000-0000-000000000000}"],
)
def test_verification_predecessor_header_requires_canonical_uuid(client, after):
    edition = issue(client, "ready")
    response = send(client, edition, verification=True, after=after)
    assert response.status_code == 400
    assert (
        client.app.state.store.db.execute(
            "SELECT COUNT(*) FROM verification_sends"
        ).fetchone()[0]
        == 0
    )


def test_duplicate_predecessor_header_and_header_on_daily_send_are_rejected(
    client,
):
    edition = issue(client, "ready")
    headers = [
        *auth().items(),
        ("X-Newsletter-Verification-After", edition["id"]),
        ("X-Newsletter-Verification-After", edition["id"]),
    ]
    assert (
        client.post(
            f"/v1/editions/{edition['id']}/send-verification",
            headers=headers,
            json={
                "id": edition["id"],
                "request_key": "invalid",
                "expected_render_hash": edition["rendered"]["render_hash"],
            },
        ).status_code
        == 404
    )
    assert send(client, edition, after=edition["id"]).status_code == 400
    assert (
        client.app.state.store.db.execute(
            "SELECT COUNT(*) FROM sends"
        ).fetchone()[0]
        == 0
    )


def test_successor_must_name_last_verification_from_same_date(client):
    original = issue(client, "original")
    assert send(client, original).status_code == 200
    new = issue(client, "fresh")
    assert (
        send(
            client, new, verification=True, key="fresh", after=original["id"]
        ).status_code
        == 409
    )
    prior = issue(client, "prior")
    assert (
        send(client, prior, verification=True, key="prior").status_code == 200
    )
    other_original = issue(client, "other-original", issue_date="2026-09-05")
    assert send(client, other_original, key="other-original").status_code == 200
    other_verification = issue(
        client, "other-verification", issue_date="2026-09-05"
    )
    assert (
        send(
            client,
            other_verification,
            verification=True,
            key="other-verification",
        ).status_code
        == 200
    )
    assert (
        send(
            client,
            new,
            verification=True,
            key="fresh",
            after=other_verification["id"],
        ).status_code
        == 409
    )


def test_successor_still_requires_frozen_research_evidence(client, monkeypatch):
    original = issue(client, "original")
    assert send(client, original).status_code == 200
    prior = issue(client, "prior")
    assert (
        send(client, prior, verification=True, key="prior").status_code == 200
    )
    new = issue(client, "fresh")
    checked = []

    def reject(edition_id):
        checked.append(edition_id)
        raise newsletter_store.StoreError(
            "conflict", "Research receipt is missing"
        )

    monkeypatch.setattr(
        client.app.state.store, "assert_workflow_research", reject
    )
    assert (
        send(
            client, new, verification=True, key="fresh", after=prior["id"]
        ).status_code
        == 409
    )
    assert checked == [new["id"]]
    assert (
        client.app.state.store.get(new["id"])["delivery_state"]
        == "not_requested"
    )
    assert (
        client.app.state.store.db.execute(
            "SELECT COUNT(*) FROM verification_sends"
        ).fetchone()[0]
        == 1
    )


def legacy_receipts(path, *, duplicate_predecessor=False):
    database = sqlite3.connect(path)
    database.execute(
        "CREATE TABLE verification_sends (issue_date TEXT PRIMARY "
        "KEY, edition_id TEXT UNIQUE NOT NULL, request_key TEXT "
        "UNIQUE NOT NULL, render_hash TEXT NOT NULL, "
        "previous_edition_id TEXT NOT NULL, created_at TEXT NOT "
        "NULL)"
    )
    rows = [
        (
            "2026-09-05",
            "verification-a",
            "key-a",
            "a" * 64,
            "original-a",
            "time-a",
        ),
        (
            "2026-09-06",
            "verification-b",
            "key-b",
            "b" * 64,
            "original-a" if duplicate_predecessor else "original-b",
            "time-b",
        ),
    ]
    database.executemany(
        "INSERT INTO verification_sends VALUES(?,?,?,?,?,?)", rows
    )
    database.commit()
    database.close()
    return rows


def test_legacy_ledger_migration_preserves_every_receipt_and_is_idempotent(
    tmp_path,
):
    path = tmp_path / "state.sqlite"
    rows = legacy_receipts(path)
    for _ in range(2):
        store = newsletter_store.Store(path, "mock")
        try:
            assert [
                tuple(row)
                for row in store.db.execute(
                    "SELECT * FROM verification_sends ORDER BY issue_date"
                )
            ] == rows
            columns = {
                row["name"]: row["pk"]
                for row in store.db.execute(
                    "PRAGMA table_info(verification_sends)"
                )
            }
            assert columns["edition_id"] == 1 and columns["issue_date"] == 0
            with pytest.raises(sqlite3.IntegrityError):
                store.db.execute(
                    "INSERT INTO verification_sends VALUES(?,?,?,?,?,?)",
                    (
                        "2026-09-06",
                        "rival",
                        "rival-key",
                        "c" * 64,
                        "original-b",
                        "now",
                    ),
                )
        finally:
            store.close()


def test_inconsistent_legacy_ledger_fails_migration_atomically(tmp_path):
    path = tmp_path / "state.sqlite"
    rows = legacy_receipts(path, duplicate_predecessor=True)
    with pytest.raises(sqlite3.IntegrityError):
        newsletter_store.Store(path, "mock")
    database = sqlite3.connect(path)
    try:
        assert (
            database.execute(
                "SELECT * FROM verification_sends ORDER BY issue_date"
            ).fetchall()
            == rows
        )
        assert (
            database.execute(
                "SELECT name FROM sqlite_master WHERE "
                "name='verification_sends_migrated'"
            ).fetchone()
            is None
        )
        assert {
            row[1]: row[5]
            for row in database.execute("PRAGMA table_info(verification_sends)")
        }["issue_date"] == 1
    finally:
        database.close()

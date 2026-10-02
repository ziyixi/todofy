"""Regression coverage for import isolation and safe failure diagnostics."""

import asyncio
import hashlib
import json
import logging

import pytest

import newsletter.contracts as contracts
import newsletter.diagnostics as diagnostics
import newsletter.editor as editor
import newsletter.files as files
import newsletter.notion_intake as notion_intake
import newsletter.notion_journal as notion_journal
import newsletter.store as store
import newsletter.worker as worker
import tests.support.notion_content as notion_content


@pytest.mark.parametrize("body", ["null", "[]", "42", '"private marker"', "{"])
def test_bad_edition_shape_does_not_block_later_import(tmp_path, body, caplog):
    database = store.Store(tmp_path / "newsletter.sqlite3", "live")
    try:
        journal = notion_journal.NotionJournal(database, {"target": "offline"})
        intake = notion_intake.NotionIntake(journal, include_personal=False)
        valid = notion_content.edition(
            created_at="2026-09-07T13:00:00+00:00",
            updated_at="2026-09-07T13:00:00+00:00",
        )
        for identifier, encoded in (
            ("broken-edition", body),
            (valid["id"], contracts.canonical_json(valid)),
        ):
            journal.execute(
                "INSERT INTO editions VALUES(?,?,?,?,?,?)",
                (
                    identifier,
                    identifier,
                    "unused",
                    "ready",
                    encoded,
                    contracts.canonical_json([notion_content.packet()]),
                ),
            )
        before = journal.rows("SELECT * FROM editions ORDER BY id")
        assert intake.scan() == 2
        assert journal.rows("SELECT * FROM editions ORDER BY id") == before
        assert journal.entity("edition:" + valid["id"])["kind"] == "edition"
        errors = journal.rows(
            "SELECT * FROM notion_imports WHERE source_id='broken-edition'"
        )
        assert errors[0]["error"] == "notion_edition_import_failed"
        assert errors[0]["digest"] == "invalid"
        assert intake.scan() == 0
        assert "private marker" not in caplog.text
        assert "phase=notion_edition_import" in caplog.text
    finally:
        database.close()


@pytest.mark.parametrize(
    "failure", [asyncio.CancelledError, KeyboardInterrupt, SystemExit]
)
async def test_projection_termination_is_durable_and_propagates(
    tmp_path, failure
):
    class InterruptedNotion:
        calls = 0

        async def project(self, packet):
            self.calls += 1
            raise failure("private provider message")

    path = tmp_path / "newsletter.sqlite3"
    database = store.Store(path, "live")
    notion = InterruptedNotion()
    try:
        packet = notion_content.packet()
        database.db.execute(
            "INSERT INTO packets(id,principal,request_key,digest,body) "
            "VALUES(?,'test','test','test',?)",
            (packet["id"], contracts.canonical_json(packet)),
        )
        consumer = worker.Worker(
            database, editor.MockEditor(), notion, tmp_path / "jobs", 30
        )
        with pytest.raises(failure):
            await consumer.step()
        assert (
            database.db.execute("SELECT projection FROM packets").fetchone()[0]
            == "unknown"
        )
    finally:
        database.close()
    reopened = store.Store(path, "live")
    try:
        reopened.recover()
        consumer = worker.Worker(
            reopened, editor.MockEditor(), notion, tmp_path / "jobs", 30
        )
        assert not await consumer.step()
        assert notion.calls == 1
    finally:
        reopened.close()


def test_diagnostics_only_include_phase_type_and_hashed_reference(caplog):
    reference = "private record identifier\nInjected log entry"
    diagnostics.record_failure(
        logging.getLogger(__name__),
        phase="editor_validation",
        error=TypeError("private body /home/private token"),
        reference=reference,
    )
    assert "phase=editor_validation type=TypeError" in caplog.text
    assert hashlib.sha256(reference.encode()).hexdigest()[:12] in caplog.text
    assert "private" not in caplog.text
    assert "Traceback" not in caplog.text


@pytest.mark.parametrize("payload", [b'{"a":1,"a":2}', b'{"a":{"b":1,"b":2}}'])
def test_shared_json_decoder_rejects_duplicate_fields(payload):
    with pytest.raises(ValueError, match="Duplicate JSON key"):
        files.decode_json(payload)


def test_shared_atomic_write_keeps_previous_file_before_replace(
    tmp_path, monkeypatch
):
    destination = tmp_path / "bundle.json"
    destination.write_text('{"previous":true}')

    def fail_replace(source, target):
        raise OSError("synthetic write interruption")

    monkeypatch.setattr(files.os, "replace", fail_replace)
    with pytest.raises(OSError, match="synthetic write interruption"):
        files.atomic_write_text(destination, '{"new":true}')
    assert json.loads(destination.read_text()) == {"previous": True}
    assert list(tmp_path.iterdir()) == [destination]


@pytest.mark.parametrize("encoded", ["null", "[]", "42", '"private marker"'])
def test_corrupt_frozen_inputs_never_select_packaged_template(
    tmp_path, encoded
):
    database = store.Store(tmp_path / "newsletter.sqlite3", "live")
    try:
        consumer = worker.Worker(
            database, editor.MockEditor(), object(), tmp_path / "jobs", 30
        )
        binding = {"run_id": "run-frozen"}
        assert consumer.frozen_template(binding) is None
        database.db.execute(
            "CREATE TABLE workflow_runs(id TEXT PRIMARY KEY, inputs TEXT)"
        )
        assert consumer.frozen_template(binding) is None
        database.db.execute(
            "INSERT INTO workflow_runs VALUES(?,?)", ("run-frozen", encoded)
        )
        with pytest.raises((ValueError, RuntimeError)):
            consumer.frozen_template(binding)
    finally:
        database.close()

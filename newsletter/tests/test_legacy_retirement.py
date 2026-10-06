"""Unfinished work of the removed legacy paths is closed, never resumed."""

import dataclasses
import importlib.resources as resources
import json
import os

import pytest

import newsletter.adapters as adapters
import newsletter.collection.repository as repository
import newsletter.editor as editor
import newsletter.settings as newsletter_settings
import newsletter.store as newsletter_store
import newsletter.worker as newsletter_worker
import newsletter.workflow.pipeline as newsletter_workflow_pipeline


@pytest.fixture
def store(tmp_path):
    database = newsletter_store.Store(tmp_path / "state.sqlite3", "live")
    try:
        yield database
    finally:
        database.close()


def dag(store, tmp_path):
    return newsletter_workflow_pipeline.DagPipeline(
        repository.RunRepository(store),
        tmp_path / "jobs",
        editor=editor.CodexEditor(tmp_path / "unused-auth"),
    )


def legacy_run(store, state):
    """A run of the removed collection backend: no frozen workflow graph."""
    runs = repository.RunRepository(store)
    run = runs.start(
        {"request_key": "legacy-" + state, "issue_date": "2026-09-06"}, []
    )
    return runs.update(run["id"], state=state)


@pytest.mark.parametrize("state", ["queued", "collecting"])
async def test_collection_backend_run_is_retired_without_collecting(
    store, tmp_path, state
):
    run = legacy_run(store, state)
    assert await dag(store, tmp_path).collect_next()
    stored = repository.RunRepository(store).get(run["id"])
    assert (stored["state"], stored["error_code"]) == (
        "blocked",
        newsletter_workflow_pipeline.RETIRED_WORKFLOW,
    )
    assert stored["directions"] == run["directions"]


@pytest.mark.parametrize("state", ["projecting", "editing"])
def test_collection_backend_run_waiting_on_projection_is_retired(
    store, tmp_path, state
):
    run = legacy_run(store, state)
    assert dag(store, tmp_path).advance()
    stored = repository.RunRepository(store).get(run["id"])
    assert (stored["state"], stored["error_code"]) == (
        "blocked",
        newsletter_workflow_pipeline.RETIRED_WORKFLOW,
    )
    assert dag(store, tmp_path).advance() is False


async def test_live_worker_fails_unbound_edition_without_an_editor(
    store, tmp_path
):
    request = json.loads(
        resources.files("newsletter")
        .joinpath("fixtures/packets.json")
        .read_text()
    )[0]
    packet = store.put_packet(request)
    edition = store.prepare(
        {
            "request_key": "unbound",
            "issue_date": "2026-09-06",
            "packet_ids": [packet["id"]],
        }
    )
    worker = newsletter_worker.Worker(
        store, None, adapters.DisabledNotion(), tmp_path / "editor", 10
    )
    assert await worker.step()
    stored = store.get(edition["id"])
    assert (stored["state"], stored["error_code"]) == (
        "failed",
        "legacy_editor_retired",
    )
    assert stored["delivery_state"] == "not_requested"


def test_programmatic_settings_defaults_equal_environment_defaults(
    monkeypatch,
):
    for name in list(os.environ):
        if name.startswith(
            ("NEWSLETTER_", "NOTION_", "TODO_API_", "RESEND_", "RECIPIENT_")
        ):
            monkeypatch.delenv(name)
    defaults = newsletter_settings.Settings()
    assert defaults == newsletter_settings.Settings.from_env()
    assert defaults.workflow_backend == "dag"
    with pytest.raises(ValueError, match="legacy backend was removed"):
        dataclasses.replace(defaults, workflow_backend="legacy").validate()

"""Test collection contracts and durable triggers without real providers."""

import dataclasses
import json

import fastapi.testclient as testclient
import pytest

import newsletter.adapters as adapters
import newsletter.app as app
import newsletter.collection.collector as newsletter_collection_collector
import newsletter.collection.instructions as newsletter_collection_instructions
import newsletter.errors as newsletter_errors
import newsletter.model_schema as model_schema
import newsletter.preflight as preflight
import newsletter.settings as newsletter_settings

AUTH = {"Authorization": "Bearer " + "e" * 32}
REQUEST = {"request_key": "external-job-01", "issue_date": "2026-09-05"}


@pytest.fixture
def settings(tmp_path):
    instructions = tmp_path / "instructions"
    instructions.mkdir()
    (instructions / "ai-ml.md").write_text("Collect credible ML evidence.")
    (instructions / "science.md").write_text(
        "Collect a different science paper."
    )
    return newsletter_settings.Settings(
        data_dir=tmp_path / "data",
        instructions_dir=instructions,
        editor_token="e" * 32,
        send_token="s" * 32,
        notion_backend="fake",
    )


class CountingCollector(newsletter_collection_collector.MockCollector):
    def __init__(self):
        self.seen = []

    async def collect(self, instruction, issue_date, workspace):
        self.seen.append(instruction)
        return await super().collect(instruction, issue_date, workspace)


def drain(client):
    for _ in range(40):
        if not client.portal.call(client.app.state.worker.step):
            return
    pytest.fail("queue did not drain")


def test_trigger_runs_snapshot_collection_notion_editor_preview_without_send(
    settings,
):
    collector = CountingCollector()
    with testclient.TestClient(
        app.create_app(settings, collector=collector, start_worker=False)
    ) as client:
        assert client.post("/v1/runs", json=REQUEST).status_code == 401
        assert (
            client.post(
                "/v1/runs",
                json=REQUEST,
                headers={"Authorization": "Bearer " + "i" * 32},
            ).status_code
            == 401
        )
        first = client.post("/v1/runs", json=REQUEST, headers=AUTH)
        assert first.status_code == 202
        run = first.json()
        assert run["state"] == "queued" and len(run["directions"]) == 2
        assert not collector.seen
        (settings.instructions_dir / "ai-ml.md").write_text(
            "CHANGED after accepting trigger"
        )
        assert client.post("/v1/runs", json=REQUEST, headers=AUTH).json() == run
        drain(client)
        result = client.get("/v1/runs/" + run["id"], headers=AUTH).json()
        assert result["state"] == "ready"
        assert collector.seen[0].text == "Collect credible ML evidence."
        assert len(collector.seen) == 2
        assert all(d["state"] == "collected" for d in result["directions"])
        edition = client.get(
            "/v1/editions/" + result["edition_id"], headers=AUTH
        ).json()
        assert (
            edition["state"] == "ready"
            and edition["delivery_state"] == "not_requested"
        )
        assert len(list((settings.data_dir / "notion").glob("*.json"))) == 2
        assert not list(settings.data_dir.rglob("*.eml"))
        assert (
            client.post(
                "/v1/runs",
                json={**REQUEST, "issue_date": "2026-09-06"},
                headers=AUTH,
            ).status_code
            == 409
        )
    with testclient.TestClient(
        app.create_app(settings, collector=collector, start_worker=False)
    ) as client:
        assert (
            client.get("/v1/runs/" + run["id"], headers=AUTH).json() == result
        )
        assert (
            client.post("/v1/runs", json=REQUEST, headers=AUTH).json() == result
        )
        drain(client)
        assert len(collector.seen) == 2


def test_new_trigger_rescans_but_retries_do_not_require_current_files(settings):
    with testclient.TestClient(
        app.create_app(settings, start_worker=False)
    ) as client:
        first = client.post("/v1/runs", json=REQUEST, headers=AUTH).json()
        (settings.instructions_dir / "science.md").unlink()
        second = client.post(
            "/v1/runs", json={**REQUEST, "request_key": "new"}, headers=AUTH
        ).json()
        assert len(first["directions"]) == 2 and len(second["directions"]) == 1
        assert first["instructions_hash"] != second["instructions_hash"]
        (settings.instructions_dir / "ai-ml.md").unlink()
        assert (
            client.post("/v1/runs", json=REQUEST, headers=AUTH).json() == first
        )
        assert (
            client.post(
                "/v1/runs",
                json={**REQUEST, "request_key": "empty"},
                headers=AUTH,
            ).status_code
            == 503
        )


@pytest.mark.parametrize(
    "bad",
    [
        {},
        {**REQUEST, "instructions_dir": "/etc"},
        {**REQUEST, "issue_date": "2026-02-30"},
        {**REQUEST, "send": True},
    ],
)
def test_trigger_rejects_invalid_or_extra_fields(settings, bad):
    with testclient.TestClient(
        app.create_app(settings, start_worker=False)
    ) as client:
        assert (
            client.post("/v1/runs", json=bad, headers=AUTH).status_code == 400
        )


def test_failed_notion_does_not_start_editor_or_retry(settings):
    class FailingNotion:
        calls = 0

        async def project(self, packet):
            self.calls += 1
            raise adapters.AdapterError("notion_unavailable", ambiguous=True)

    class NeverEditor:
        async def prepare(self, *args):
            pytest.fail("editor ran before confirmed projection")

    notion = FailingNotion()
    with testclient.TestClient(
        app.create_app(
            settings, notion=notion, editor=NeverEditor(), start_worker=False
        )
    ) as client:
        run = client.post("/v1/runs", json=REQUEST, headers=AUTH).json()
        drain(client)
        result = client.get("/v1/runs/" + run["id"], headers=AUTH).json()
        assert (
            result["state"] == "blocked"
            and result["error_code"] == "notion_projection_unconfirmed"
        )
        calls = notion.calls
        drain(client)
        assert notion.calls == calls


def test_honest_no_findings_is_not_a_fake_edition(settings):
    class EmptyCollector:
        async def collect(self, *args):
            return newsletter_collection_collector.ResearchResult(
                [], "No sufficient source evidence found."
            )

    with testclient.TestClient(
        app.create_app(settings, collector=EmptyCollector(), start_worker=False)
    ) as client:
        run = client.post("/v1/runs", json=REQUEST, headers=AUTH).json()
        drain(client)
        result = client.get("/v1/runs/" + run["id"], headers=AUTH).json()
        assert result["state"] == "blocked" and result["edition_id"] == ""
        assert all(d["state"] == "no_findings" for d in result["directions"])


def test_collecting_run_is_not_replayed_after_crash(settings):
    collector = CountingCollector()
    with testclient.TestClient(
        app.create_app(settings, collector=collector, start_worker=False)
    ) as client:
        run = client.post("/v1/runs", json=REQUEST, headers=AUTH).json()
        client.app.state.runs.claim()
    with testclient.TestClient(
        app.create_app(settings, collector=collector, start_worker=False)
    ) as client:
        recovered = client.get("/v1/runs/" + run["id"], headers=AUTH).json()
        assert (
            recovered["state"] == "failed"
            and recovered["error_code"] == "collection_interrupted"
        )
        drain(client)
        assert not collector.seen


def test_startup_fails_before_any_worker_or_health_is_served(
    settings, monkeypatch
):
    async def unavailable(*args, **kwargs):
        raise preflight.PreflightError("CODEX_CHATGPT_AUTH_REQUIRED")

    monkeypatch.setattr(preflight, "preflight", unavailable)
    with (
        pytest.raises(
            preflight.PreflightError, match="CODEX_CHATGPT_AUTH_REQUIRED"
        ),
        testclient.TestClient(app.create_app(settings)),
    ):
        pytest.fail("startup incorrectly succeeded")


def test_bad_instructions_fail_startup(settings):
    (settings.instructions_dir / "ai-ml.md").write_text("")
    with (
        pytest.raises(newsletter_collection_instructions.InstructionError),
        testclient.TestClient(app.create_app(settings)),
    ):
        pytest.fail("startup incorrectly succeeded")


@pytest.mark.parametrize(
    "kind",
    ["empty", "oversize", "invalid_utf8", "symlink", "directory", "bad_name"],
)
def test_instruction_loader_rejects_unsafe_files(tmp_path, kind):
    folder = tmp_path / "directions"
    folder.mkdir()
    path = folder / "direction.md"
    if kind == "empty":
        path.write_text(" ")
    elif kind == "oversize":
        path.write_text("x" * 24001)
    elif kind == "invalid_utf8":
        path.write_bytes(b"\xff")
    elif kind == "symlink":
        target = tmp_path / "outside.md"
        target.write_text("valid")
        path.symlink_to(target)
    elif kind == "directory":
        path.mkdir()
    else:
        (folder / "Invalid Name.md").write_text("valid")
    with pytest.raises(newsletter_collection_instructions.InstructionError):
        newsletter_collection_instructions.load_instructions(folder)


def test_instruction_readme_is_not_executed_and_limit_is_bounded(tmp_path):
    (tmp_path / "README.md").write_text("not a direction")
    (tmp_path / "_notes.md").write_text("not a direction")
    for number in range(8):
        (tmp_path / f"{number}.md").write_text("evidence")
    assert (
        len(newsletter_collection_instructions.load_instructions(tmp_path)) == 8
    )
    (tmp_path / "9.md").write_text("too many")
    with pytest.raises(newsletter_collection_instructions.InstructionError):
        newsletter_collection_instructions.load_instructions(tmp_path)


def research_payload():
    return {
        "state": "collected",
        "note": "Source opened.",
        "packets": [
            {
                "title": "Synthetic research",
                "body": "Synthetic unit test evidence.",
                "tags": ["fixture"],
                "sources": [
                    {
                        "id": "s1",
                        "title": "Synthetic source",
                        "url": "https://example.com/original",
                        "excerpt": "Synthetic test only.",
                        "access_scope": "full_text",
                    }
                ],
            }
        ],
    }


def test_research_requires_exact_opened_source_and_search():
    text = json.dumps(research_payload())
    assert (
        len(
            newsletter_collection_collector.parse_research(
                text, {"https://example.com/original"}, True
            ).packets
        )
        == 1
    )
    for urls, searched in [
        ({"https://example.com/canonical"}, True),
        (set(), True),
        ({"https://example.com/original"}, False),
    ]:
        with pytest.raises(newsletter_errors.EditorError):
            newsletter_collection_collector.parse_research(text, urls, searched)
    empty = json.dumps(
        {
            "state": "no_findings",
            "note": "Search yielded insufficient evidence.",
            "packets": [],
        }
    )
    assert (
        newsletter_collection_collector.parse_research(
            empty, set(), True
        ).packets
        == []
    )
    with pytest.raises(newsletter_errors.EditorError):
        newsletter_collection_collector.parse_research(empty, set(), False)


def test_research_schema_uses_public_packet_and_source_enum():
    schema = model_schema.research_schema()
    packet = schema["properties"]["packets"]["items"]
    assert set(packet["properties"]) == {"title", "body", "sources", "tags"}
    assert packet["properties"]["sources"]["items"]["properties"][
        "access_scope"
    ]["enum"] == [
        "metadata",
        "abstract",
        "full_text",
        "dataset",
    ]


def test_queue_capacity_and_no_implicit_job_on_startup(settings):
    with testclient.TestClient(
        app.create_app(
            dataclasses.replace(settings, max_pending_jobs=1),
            start_worker=False,
        )
    ) as client:
        assert client.app.state.runs.claim() is None
        assert (
            client.post("/v1/runs", json=REQUEST, headers=AUTH).status_code
            == 202
        )
        assert (
            client.post(
                "/v1/runs",
                json={**REQUEST, "request_key": "extra"},
                headers=AUTH,
            ).status_code
            == 429
        )

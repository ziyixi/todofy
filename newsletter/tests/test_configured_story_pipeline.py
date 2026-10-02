"""Test config, workflow, storage and rendering behind a synthetic provider.

No real API, research, Notion write or email is permitted. Unlike a node-only
test, this exercises the installed bundle and the normal serialized worker.
"""

import copy
import json
import sqlite3

import fastapi.testclient as testclient
import pytest
import yaml

import newsletter.app as newsletter_app
import newsletter.collection.collector as collector
import newsletter.collection.repository as repository
import newsletter.content_config as content_config
import newsletter.editor as editor
import newsletter.preflight as preflight
import newsletter.settings as newsletter_settings
import newsletter.store as newsletter_store
import newsletter.worker as newsletter_worker
import newsletter.workflow.pipeline as newsletter_workflow_pipeline
import newsletter.workflow.sources as sources
import newsletter.workflow.story_editor as story_editor
import tests.support.news_first_policy as news_first_policy
import tests.support.publication as publication
import tests.support.workflow_content as workflow_content


class ForbiddenNotion:
    async def project(self, packet):
        raise AssertionError(
            "Configuration integration must never write to Notion"
        )


@pytest.mark.parametrize("state", ["missing", "corrupt", "valid"])
def test_live_lifespan_checks_active_configuration_before_advertising_readiness(
    tmp_path, monkeypatch, state
):
    root = tmp_path / "config"
    if state != "missing":
        content_config.install_snapshot(
            root, content_config.packaged_snapshot()
        )
        if state == "corrupt":
            (root / "active.json").write_text("{}")
    settings = newsletter_settings.Settings(
        data_dir=tmp_path / "service",
        mode="live",
        editor_backend="codex",
        codex_home=tmp_path / "nonexistent-fixture-auth",
        workflow_backend="dag",
        content_config_dir=root,
        notion_backend="disabled",
        mail_backend="fake",
        editor_token="e" * 32,
        send_token="s" * 32,
    )
    opened = []

    async def offline_provider_preflight(settings, *, store):
        opened.append(store)
        return preflight.PreflightReport(("offline_test_boundary",), ())

    async def forbidden(*args, **kwargs):
        raise AssertionError(
            "Startup-only test cannot call a model or run a worker"
        )

    monkeypatch.setattr(preflight, "preflight", offline_provider_preflight)
    monkeypatch.setattr(editor.CodexEditor, "execute", forbidden)
    monkeypatch.setattr(newsletter_worker.Worker, "run", forbidden)
    app = newsletter_app.create_app(settings, start_worker=False)
    if state == "valid":
        with testclient.TestClient(app) as client:
            assert client.get("/healthz").status_code == 200
            assert isinstance(
                app.state.worker.pipeline,
                newsletter_workflow_pipeline.DagPipeline,
            )
            assert app.state.worker_task is None
            assert (
                app.state.store.db.execute(
                    "SELECT COUNT(*) FROM collection_runs"
                ).fetchone()[0]
                == 0
            )
    else:
        with (
            pytest.raises(content_config.ContentConfigError),
            testclient.TestClient(app),
        ):
            pytest.fail(
                "Missing or corrupt active configuration advertised readiness"
            )
        assert not hasattr(app.state, "worker")
    assert len(opened) == 1
    with pytest.raises(sqlite3.ProgrammingError, match="closed"):
        opened[0].db.execute("SELECT 1")


@pytest.mark.parametrize("excess_research", [False, True])
async def test_frozen_config_drives_pipeline_despite_midrun_switch(
    tmp_path, monkeypatch, excess_research
):
    config_root = tmp_path / "config"
    packaged = content_config.packaged_snapshot()
    first_files = dict(packaged["files"])
    first_files["prompts/discovery.md"] += "\nDISCOVERY CONFIG A"
    first_files["prompts/selection.md"] += "\nSELECTION CONFIG A"
    first_files["policy/editorial.md"] += "\nWRITING CONFIG A"
    first_files["templates/edition.html.j2"] = first_files[
        "templates/edition.html.j2"
    ].replace("THE DAILY BRIEF", "CONFIG A DAILY BRIEF")
    first = content_config.build_snapshot(first_files, "a" * 40)
    content_config.install_snapshot(config_root, first)

    second_files = dict(first_files)
    second_files["editorial.yaml"] = yaml.safe_dump(
        {
            "max_public_items": 1,
            "max_research_items": 0,
            "max_deep": 0,
            "max_research_candidates": 0,
        }
    )
    for name in (
        "prompts/discovery.md",
        "prompts/selection.md",
        "policy/editorial.md",
    ):
        second_files[name] = second_files[name].replace("CONFIG A", "CONFIG B")
    second_files["templates/edition.html.j2"] = second_files[
        "templates/edition.html.j2"
    ].replace("CONFIG A DAILY BRIEF", "CONFIG B DAILY BRIEF")
    second = content_config.build_snapshot(second_files, "b" * 40)

    store = newsletter_store.Store(tmp_path / "state.sqlite3", "mock")
    provider_calls, writing_calls = [], []
    switched = False

    async def forbidden(*args, **kwargs):
        raise AssertionError(
            "No legacy collector, whole-issue editor, external API or email"
        )

    async def empty_public_metadata(self, issue_date):
        return sources.MetadataResult(
            [], ["Synthetic offline metadata boundary"]
        )

    async def provider(self, prompt, schema, instructions, workspace):
        nonlocal switched
        value = json.loads(prompt)
        provider_calls.append((value, schema, instructions))
        if "candidates" in schema["properties"]:
            assert (
                "DISCOVERY CONFIG A" in instructions
                and "DISCOVERY CONFIG B" not in instructions
            )
            direction = value["direction"]
            if direction == "03-world":
                candidates = [
                    news_first_policy.news(number) for number in range(1, 6)
                ]
            elif direction == "08-llm-architectures":
                candidates = [
                    news_first_policy.paper(number) for number in range(1, 6)
                ]
            else:
                candidates = []
            output = json.loads(workflow_content.discovered(*candidates))
            for candidate in output["candidates"]:
                # A paper cannot masquerade as news even if both model stages
                # say news. The parser uses the candidate's publication
                # identity.
                candidate.update(
                    editorial_kind="news",
                    change_basis=(
                        "A concrete availability change was announced."
                    ),
                )
            if not switched:
                content_config.install_snapshot(config_root, second)
                switched = True
            return json.dumps(output), {c["url"] for c in candidates}, True
        assert "research_tasks" in schema["properties"]
        assert (
            "SELECTION CONFIG A" in instructions
            and "SELECTION CONFIG B" not in instructions
        )
        assert value["max_tasks"] == 6
        assert schema["properties"]["research_tasks"]["maxItems"] == 6
        assert value["editorial_budget"] == {
            "max_public_items": 6,
            "max_research_items": 1,
            "max_deep": 1,
        }
        candidates = value["candidates_untrusted"]
        assert len(candidates) == 10
        kinds = value["candidate_classifications"]
        papers = [c for c in candidates if kinds[c["id"]]["kind"] == "research"]
        events = [c for c in candidates if kinds[c["id"]]["kind"] == "news"]
        assert len(papers) == len(events) == 5
        chosen = (
            papers[:2] + events[:4] if excess_research else events + papers[:1]
        )
        tasks = [
            {
                "id": f"story-{number}",
                "candidate_ids": [c["id"]],
                "priority": number,
                "question": f"What changed in {c['title']}?",
                "why": "A specific change merits investigation.",
                "evidence_context": c["summary"],
                "source_urls": [c["url"]],
                "editorial_kind": "news",
            }
            for number, c in enumerate(chosen, 1)
        ]
        return (
            json.dumps(
                {"research_tasks": tasks, "note": "Synthetic selection fixture"}
            ),
            set(),
            False,
        )

    async def prepare_story(self, **kwargs):
        task, mode = kwargs["task"], kwargs["mode"]
        number = int(task["id"].rsplit("-", 1)[1])
        assert "WRITING CONFIG A" in kwargs["policy"]["editorial.md"]
        assert "WRITING CONFIG B" not in kwargs["policy"]["editorial.md"]
        assert (
            "公共选题最多6项，研究主体最多1项，深读最多1项"
            in kwargs["policy"]["editorial.md"]
        )
        if mode == "deep":
            assert len(
                [call for call in writing_calls if call[0] == "brief"]
            ) == (5 if excess_research else 6)
            assert kwargs["prior"]["mode"] == "brief"
        writing_calls.append((mode, task["id"]))
        candidate = kwargs["candidates"][0]
        content = publication.story(
            number,
            title=candidate["title"],
            kind="ai_ml" if "arxiv.org" in candidate["url"] else "world",
        )
        value = publication.result(number, mode, content=content)
        kwargs["on_checkpoint"](value)
        return value

    monkeypatch.setattr(
        sources.PublicMetadataFeed, "fetch", empty_public_metadata
    )
    monkeypatch.setattr(editor.CodexEditor, "execute", provider)
    monkeypatch.setattr(editor.CodexEditor, "prepare", forbidden)
    monkeypatch.setattr(editor.MockEditor, "prepare", forbidden)
    monkeypatch.setattr(collector.MockCollector, "collect", forbidden)
    monkeypatch.setattr(story_editor.StoryEditor, "prepare", prepare_story)
    try:
        runs = repository.RunRepository(store)
        pipeline = newsletter_workflow_pipeline.DagPipeline(
            runs,
            collector.MockCollector(),
            tmp_path / "collection",
            10,
            32,
            editor=editor.CodexEditor(tmp_path / "nonexistent-auth"),
        )
        settings = newsletter_settings.Settings(
            workflow_backend="dag", content_config_dir=config_root
        )
        instructions, snapshot = newsletter_workflow_pipeline.freeze_workflow(
            settings, pipeline.state, publication.DAY
        )
        frozen = copy.deepcopy(snapshot)
        run = runs.start(
            {
                "request_key": "installed-config-e2e",
                "issue_date": publication.DAY,
            },
            instructions,
            workflow_snapshot=snapshot,
        )
        worker = newsletter_worker.Worker(
            store,
            editor.MockEditor(),
            ForbiddenNotion(),
            tmp_path / "editor",
            10,
            pipeline=pipeline,
            skip_packet_projection=True,
        )
        for _ in range(80):
            if runs.get(run["id"])["state"] in {"ready", "blocked", "failed"}:
                break
            assert await worker.step()
        completed = runs.get(run["id"])
        assert completed["state"] == "ready", completed
        graph = pipeline.repository.get(run["id"])
        assert graph["state"] == "succeeded"
        selection = pipeline.repository.output(run["id"], "selection")
        plan = pipeline.repository.output(run["id"], "story_plan")
        expected_count = 5 if excess_research else 6
        assert len(selection["research_tasks"]) == expected_count
        assert (
            sum(
                kind == "research"
                for kind in selection["task_classifications"].values()
            )
            == 1
        )
        assert len(selection["omitted_tasks"]) == (1 if excess_research else 0)
        if excess_research:
            assert selection["omitted_tasks"][0]["reason"] == "research_quota"
        assert (
            len(plan["brief_tasks"]) == expected_count
            and len(plan["deep_tasks"]) == 1
        )
        assert len([call for call in writing_calls if call[0] == "deep"]) == 1
        edition = store.get(completed["edition_id"])
        assert (
            edition["state"] == "ready"
            and edition["delivery_state"] == "not_requested"
        )
        assert len(edition["draft"]["sections"]) == expected_count
        assert (
            sum(
                s["disposition"] == "deep"
                for s in edition["publication"]["stories"]
            )
            == 1
        )
        assert "CONFIG A DAILY BRIEF" in edition["rendered"]["html"]
        assert "CONFIG B DAILY BRIEF" not in edition["rendered"]["html"]
        assert (
            sum(
                section["kind"] == "ai_ml"
                for section in edition["draft"]["sections"]
            )
            == 1
        )
        assert (
            len(provider_calls) == 9
        )  # Eight bounded retrievals, one selection.
        assert content_config.load_active(config_root) == second
        assert runs.workflow_snapshot(run["id"]) == frozen
        assert (
            pipeline.repository.snapshot(run["id"])["inputs"]["content_config"]
            == first
        )
        _, next_snapshot = newsletter_workflow_pipeline.freeze_workflow(
            settings, pipeline.state, "2026-09-07"
        )
        assert next_snapshot["inputs"]["content_config"] == second
        assert store.db.execute("SELECT COUNT(*) FROM sends").fetchone()[0] == 0
        assert (
            store.db.execute(
                "SELECT COUNT(*) FROM verification_sends"
            ).fetchone()[0]
            == 0
        )
    finally:
        store.close()

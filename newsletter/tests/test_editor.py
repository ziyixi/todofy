"""Offline tests only: never start a real app-server or inspect auth files."""

import asyncio
import copy
import dataclasses
import json
import pathlib

import pytest

import newsletter.codex_runtime as codex_runtime
import newsletter.collection.instructions as instructions
import newsletter.contracts as contracts
import newsletter.editor as newsletter_editor
import newsletter.errors as newsletter_errors
import newsletter.workflow.content as newsletter_workflow_content
import newsletter.workflow.schema as newsletter_workflow_schema
import tests.support.editor as editor


async def test_provenance_correction_requires_real_open_and_preserves_search(
    tmp_path, fake_sdk, packet
):
    content = copy.deepcopy(packet["content"])
    content["sources"][0]["url"] = "https://example.com/evidence"
    research = {"state": "collected", "note": "fixture", "packets": [content]}
    # First turn searches but does not open this source; second really opens it.
    first = editor.FakeTurn(research)
    original = first.stream

    async def search_only():
        async for event in original():
            if (
                event.payload.get("item", {}).get("action", {}).get("type")
                != "openPage"
            ):
                yield event

    first.stream = search_only
    fake_sdk.turns = [first, editor.FakeTurn(research)]
    workspace = tmp_path / "job"
    workspace.mkdir()
    text, opened, searched = await editor.live_editor(tmp_path).execute(
        "{}", {}, "fixture", workspace
    )
    assert json.loads(text) == research and searched
    assert opened == {"https://example.com/evidence"}
    assert len(fake_sdk.prompts) == 2
    assert fake_sdk.prompts[1]["unverified_urls"] == [
        "https://example.com/evidence"
    ]
    assert fake_sdk.closed


async def test_provenance_correction_stops_after_one_unverified_attempt(
    tmp_path, fake_sdk, packet
):
    content = copy.deepcopy(packet["content"])
    content["sources"][0]["url"] = "https://example.com/unread-pdf"
    fake_sdk.turn = editor.FakeTurn(
        {"state": "collected", "note": "fixture", "packets": [content]}
    )
    workspace = tmp_path / "job"
    workspace.mkdir()
    with pytest.raises(newsletter_errors.EditorError) as error:
        await editor.live_editor(tmp_path).execute(
            "{}", {}, "fixture", workspace
        )
    assert error.value.code == "invalid_output"
    assert len(fake_sdk.prompts) == 2 and fake_sdk.closed


def test_provenance_inspection_includes_only_new_sources():
    assert (
        newsletter_editor._unopened_sources(
            '{"draft":{},"supplemental_packets":[]}', set()
        )
        == []
    )
    payload = {
        "packets": [{"sources": [{"url": "https://example.com/a#table"}]}]
    }
    assert (
        newsletter_editor._unopened_sources(
            json.dumps(payload), {"https://example.com/a"}
        )
        == []
    )
    for invalid in ("[]", '{"packets":null}', '{"packets":[{}]}'):
        with pytest.raises(newsletter_errors.EditorError):
            newsletter_editor._unopened_sources(invalid, set())


def discovery_output(*, url="https://example.com/evidence", scope="abstract"):
    return {
        "candidates": [
            {
                "title": "Synthetic public candidate",
                "url": url,
                "doi": "",
                "version": "",
                "event_key": "",
                "published_at": "",
                "summary": "Only a synthetic test claim.",
                "why_now": (
                    "An offline fixture tests evidence provenance, not "
                    "actual news."
                ),
                "access_scope": scope,
            }
        ],
        "note": "Synthetic discovery only",
    }


@pytest.mark.parametrize("scope", ["abstract", "full_text", "dataset"])
async def test_discovery_missing_open_gets_one_same_thread_correction(
    tmp_path, fake_sdk, scope
):
    output = discovery_output(scope=scope)
    # Search and the actual source open occur in separate turns. Neither action
    # may be inferred from the candidate's own fields or dropped on correction.
    fake_sdk.turns = [
        editor.discovery_turn(output, omit_action="openPage"),
        editor.discovery_turn(output, omit_action="search"),
    ]
    content = newsletter_workflow_content.ContentPreparation(
        editor.live_editor(tmp_path)
    )
    result = await content.discover(
        instructions.Instruction(
            "03-world", "Synthetic instruction", "fixture"
        ),
        "2026-09-06",
        tmp_path / "discovery",
    )
    assert result.candidates[0]["url"] == "https://example.com/evidence"
    assert result.candidates[0]["published_at"] == ""
    assert result.candidates[0]["provenance"] == "web_open"
    assert fake_sdk.thread_starts == 1 and len(fake_sdk.prompts) == 2
    assert fake_sdk.prompts[1]["unverified_urls"] == [
        "https://example.com/evidence"
    ]
    assert fake_sdk.schema == newsletter_workflow_schema.discovery_schema()
    assert fake_sdk.closed


async def test_unopened_discovery_after_correction_has_no_third_turn(
    tmp_path, fake_sdk
):
    # Opening /evidence never authenticates a different canonical/PDF URL.
    fake_sdk.turn = editor.FakeTurn(
        discovery_output(url="https://example.com/unread-pdf")
    )
    with pytest.raises(newsletter_errors.EditorError) as caught:
        await newsletter_workflow_content.ContentPreparation(
            editor.live_editor(tmp_path)
        ).discover(
            instructions.Instruction(
                "03-world", "Synthetic instruction", "fixture"
            ),
            "2026-09-06",
            tmp_path / "discovery",
        )
    assert caught.value.code == "invalid_output"
    assert fake_sdk.thread_starts == 1 and len(fake_sdk.prompts) == 2
    assert fake_sdk.closed


async def test_discovery_correction_keeps_original_execute_timeout(
    tmp_path, fake_sdk
):
    output = discovery_output(url="https://example.com/unread-pdf")
    hanging = editor.FakeTurn(output, hang=True)
    fake_sdk.turns = [editor.FakeTurn(output), hanging]
    with pytest.raises(newsletter_errors.EditorError) as caught:
        await newsletter_workflow_content.ContentPreparation(
            editor.live_editor(tmp_path, timeout_seconds=0.05)
        ).discover(
            instructions.Instruction(
                "03-world", "Synthetic instruction", "fixture"
            ),
            "2026-09-06",
            tmp_path / "discovery",
        )
    assert caught.value.code == "timeout" and hanging.interrupted
    assert fake_sdk.thread_starts == 1 and len(fake_sdk.prompts) == 2
    assert fake_sdk.closed


@pytest.mark.parametrize("trusted_seed", [False, True])
async def test_metadata_requires_seed_but_no_open_correction(
    tmp_path, fake_sdk, trusted_seed
):
    output = discovery_output(
        url="https://example.com/feed-only", scope="metadata"
    )
    seed = {
        **output["candidates"][0],
        "id": "fixture-seed",
        "direction": "03-world",
        "provenance": "crossref_metadata",
        "summary": "Original feed title record only.",
    }
    fake_sdk.turn = editor.FakeTurn(output)
    content = newsletter_workflow_content.ContentPreparation(
        editor.live_editor(tmp_path)
    )
    args = (
        instructions.Instruction(
            "03-world", "Synthetic instruction", "fixture"
        ),
        "2026-09-06",
        tmp_path / "discovery",
    )
    if trusted_seed:
        result = await content.discover(*args, seeds=[seed])
        assert result.candidates[0]["summary"] == seed["summary"]
        assert result.candidates[0]["provenance"] == "crossref_metadata"
    else:
        with pytest.raises(newsletter_errors.EditorError) as caught:
            await content.discover(*args)
        assert caught.value.code == "invalid_output"
    assert fake_sdk.thread_starts == 1 and len(fake_sdk.prompts) == 1
    assert fake_sdk.closed


def test_discovery_source_inspection_preserves_fragment_and_input_boundaries():
    value = discovery_output(url="https://example.com/evidence#section")
    assert (
        newsletter_editor._unopened_sources(
            json.dumps(value), {"https://example.com/evidence"}
        )
        == []
    )
    assert newsletter_editor._unopened_sources(json.dumps(value), set()) == [
        "https://example.com/evidence#section"
    ]
    # Planning input references/history are not newly claimed evidence.
    unrelated = {
        "research_tasks": [{"source_urls": ["https://example.com/persisted"]}],
        "history_untrusted": [{"url": "https://example.com/history"}],
    }
    assert (
        newsletter_editor._unopened_sources(json.dumps(unrelated), set()) == []
    )
    for invalid in (
        {"candidates": None},
        {"candidates": [None]},
        {"candidates": [{}]},
    ):
        with pytest.raises(newsletter_errors.EditorError):
            newsletter_editor._unopened_sources(json.dumps(invalid), set())


async def test_mock_deterministic_and_conspicuous(tmp_path, packet):
    first = await newsletter_editor.MockEditor().prepare(
        [packet], "2026-09-05", tmp_path / "first"
    )
    second = await newsletter_editor.MockEditor().prepare(
        [packet], "2026-09-05", tmp_path / "second"
    )
    assert first == second
    assert "MOCK" in first.draft["subject"]
    assert (
        packet["content"]["body"]
        in first.draft["sections"][0]["paragraphs"][0]["text"]
    )
    assert {f.name for f in dataclasses.fields(first)} == {"draft", "review"}
    contracts.validate_draft(first.draft, [packet])
    assert (
        json.loads((tmp_path / "first" / "draft.json").read_text())
        == first.draft
    )


async def test_mock_rejects_live_material(tmp_path, packet):
    packet["is_fixture"] = False
    with pytest.raises(
        newsletter_errors.EditorError, match="invalid input"
    ) as error:
        await newsletter_editor.MockEditor().prepare(
            [packet], "2026-09-05", tmp_path / "job"
        )
    assert error.value.code == "invalid_input"


async def run(adapter, workspace):
    """Drive one model request through the generic execute boundary."""
    workspace.mkdir(parents=True, exist_ok=True)
    return await adapter.execute(
        '{"task":"synthetic"}', {}, "Synthetic fixture policy.", workspace
    )


async def test_managed_auth_config_and_explicit_context(
    tmp_path, fake_sdk, monkeypatch
):
    monkeypatch.setenv("OPENAI_API_KEY", "must-not-leak")
    monkeypatch.setenv("RESEND_API_KEY", "mail-secret")
    monkeypatch.setenv("OPENAI_BASE_URL", "https://unsafe.example.com")
    text, opened, searched = await run(
        editor.live_editor(tmp_path), tmp_path / "job"
    )
    assert json.loads(text)["review"]["passed"] and opened and searched
    assert fake_sdk.closed
    assert fake_sdk.skills_checked
    assert (
        fake_sdk.config.codex_bin is None
    )  # Pinned package runtime, no invented CLI path.
    assert fake_sdk.config.env["OPENAI_API_KEY"] == ""
    assert fake_sdk.config.env["RESEND_API_KEY"] == ""
    assert fake_sdk.config.env["OPENAI_BASE_URL"] == ""
    assert fake_sdk.config.launch_args_override == codex_runtime.launch_args(
        fake_sdk.config.config_overrides
    )
    assert 'forced_login_method="chatgpt"' in fake_sdk.config.config_overrides
    assert 'web_search="live"' in fake_sdk.config.config_overrides
    assert "features.shell_tool=false" in fake_sdk.config.config_overrides
    for feature in (
        "browser_use",
        "computer_use",
        "plugins",
        "remote_plugin",
        "image_generation",
        "view_image",
        "skill_search",
        "workspace_dependencies",
    ):
        assert f"features.{feature}=false" in fake_sdk.config.config_overrides
    assert "features.code_mode_host=true" in fake_sdk.config.config_overrides
    assert (
        "features.code_mode_host=false" not in fake_sdk.config.config_overrides
    )
    assert fake_sdk.thread_options["ephemeral"] is True
    assert fake_sdk.thread_options["model_provider"] == "openai"
    assert (
        fake_sdk.thread_options["developer_instructions"]
        == "Synthetic fixture policy."
    )
    assert fake_sdk.prompt == {"task": "synthetic"}
    assert "must-not-leak" not in json.dumps(fake_sdk.prompt)


@pytest.mark.parametrize("account_type", ["apiKey", "amazonBedrock", None])
async def test_rejects_non_chatgpt_before_model(
    tmp_path, fake_sdk, account_type
):
    fake_sdk.account_type = account_type
    with pytest.raises(newsletter_errors.EditorError) as error:
        await run(editor.live_editor(tmp_path), tmp_path / "job")
    assert error.value.code == "authentication"
    assert fake_sdk.thread_options is None
    assert fake_sdk.closed


@pytest.mark.parametrize(
    "raw",
    [
        '{"draft":{},"draft":{},"review":{},"supplemental_packets":[]}',
        '{"draft":NaN,"review":{},"supplemental_packets":[]}',
        "```json\n{}\n```",
        "[]",
    ],
)
async def test_strict_json_rejection(tmp_path, fake_sdk, raw):
    fake_sdk.turn.bundle = raw
    with pytest.raises(newsletter_errors.EditorError) as error:
        await run(editor.live_editor(tmp_path), tmp_path / "job")
    assert error.value.code == "invalid_output"
    assert fake_sdk.closed


@pytest.mark.parametrize(
    ("failure", "code"),
    [
        (
            {
                "codexErrorInfo": "usageLimitExceeded",
                "message": "secret-sk-123",
            },
            "rate_limit",
        ),
        (
            {"codexErrorInfo": "unauthorized", "message": "secret-sk-123"},
            "authentication",
        ),
        (
            {"codexErrorInfo": "other", "message": "secret-sk-123"},
            "unavailable",
        ),
    ],
)
async def test_vendor_error_categories_are_sanitized(
    tmp_path, fake_sdk, failure, code
):
    fake_sdk.turn.failure = failure
    with pytest.raises(newsletter_errors.EditorError) as error:
        await run(editor.live_editor(tmp_path), tmp_path / "job")
    assert error.value.code == code
    assert "secret" not in str(error.value)


async def test_timeout_interrupts_and_closes(tmp_path, fake_sdk):
    fake_sdk.turn.hang = True
    with pytest.raises(newsletter_errors.EditorError) as error:
        await run(
            editor.live_editor(tmp_path, timeout_seconds=0.05),
            tmp_path / "job",
        )
    assert error.value.code == "timeout"
    assert fake_sdk.turn.interrupted and fake_sdk.closed


async def test_worker_cancellation_interrupts_and_closes(tmp_path, fake_sdk):
    fake_sdk.turn.hang = True
    task = asyncio.create_task(
        run(editor.live_editor(tmp_path), tmp_path / "job")
    )
    await fake_sdk.turn.started.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert fake_sdk.turn.interrupted and fake_sdk.closed


async def test_missing_sdk_is_not_mock_fallback(tmp_path, monkeypatch):
    def missing():
        raise newsletter_errors.EditorError("configuration")

    monkeypatch.setattr(codex_runtime, "load_sdk", missing)
    with pytest.raises(newsletter_errors.EditorError) as error:
        await run(editor.live_editor(tmp_path), tmp_path / "job")
    assert error.value.code == "configuration"


async def test_stale_artifact_not_overwritten(tmp_path, packet):
    workspace = tmp_path / "job"
    workspace.mkdir()
    output = workspace / "draft.json"
    output.write_text("existing-user-data")
    with pytest.raises(newsletter_errors.EditorError):
        await newsletter_editor.MockEditor().prepare(
            [packet], "2026-09-05", workspace
        )
    assert output.read_text() == "existing-user-data"


async def test_symlink_output_rejected(tmp_path, packet):
    workspace = tmp_path / "job"
    workspace.mkdir()
    target = tmp_path / "outside.json"
    target.write_text("untouched")
    (workspace / "draft.json").symlink_to(target)
    with pytest.raises(newsletter_errors.EditorError):
        await newsletter_editor.MockEditor().prepare(
            [packet], "2026-09-05", workspace
        )
    assert target.read_text() == "untouched"


async def test_home_config_rejected_without_reading_auth(tmp_path, fake_sdk):
    adapter = editor.live_editor(tmp_path)
    (adapter.codex_home / "config.toml").write_text('model_provider = "custom"')
    with pytest.raises(newsletter_errors.EditorError) as error:
        await run(adapter, tmp_path / "job")
    assert error.value.code == "configuration"
    assert not fake_sdk.started


async def test_runtime_created_system_skills_allow_repeated_start(
    tmp_path, fake_sdk
):
    adapter = editor.live_editor(tmp_path)
    system = adapter.codex_home / "skills" / ".system"
    system.mkdir(parents=True)
    (system / ".codex-system-skills.marker").write_text(
        "fixture runtime marker"
    )
    for name in codex_runtime.SYSTEM_SKILLS:
        (system / name).mkdir()
        (system / name / "SKILL.md").write_text(
            "disabled fixture content, never a prompt"
        )
    for number in range(2):
        text, _, _ = await run(adapter, tmp_path / f"job-{number}")
        assert json.loads(text)["review"]["passed"]
        assert fake_sdk.skills_checked
        assert "disabled fixture content" not in json.dumps(fake_sdk.prompt)
        entries = next(
            v
            for v in fake_sdk.config.config_overrides
            if v.startswith("skills.config=")
        )
        assert entries.count("enabled=false") == len(
            codex_runtime.SYSTEM_SKILLS
        )
        assert all(
            path in entries
            for path in codex_runtime.skill_paths(adapter.codex_home)
        )


@pytest.mark.parametrize("kind", ["custom", "unknown_system", "symlink"])
async def test_skill_cache_rejects_custom_unknown_or_symlink(
    tmp_path, fake_sdk, kind
):
    adapter = editor.live_editor(tmp_path)
    system = adapter.codex_home / "skills" / ".system"
    system.mkdir(parents=True)
    if kind == "custom":
        (system.parent / "custom").mkdir()
    elif kind == "unknown_system":
        (system / "unknown").mkdir()
    else:
        (system / "imagegen").symlink_to(tmp_path, target_is_directory=True)
    with pytest.raises(newsletter_errors.EditorError) as exc:
        await run(adapter, tmp_path / "job")
    assert exc.value.code == "configuration" and not fake_sdk.started


@pytest.mark.parametrize(
    "kind",
    ["enabled", "errors", "user", "unknown_path", "missing", "wrong_cwd"],
)
async def test_effective_skills_fail_closed_before_model(
    tmp_path, fake_sdk, kind
):
    adapter = editor.live_editor(tmp_path)
    workspace = tmp_path / "job"
    skills = [
        {
            "path": path,
            "scope": "system",
            "enabled": False,
            "name": pathlib.Path(path).parent.name,
            "description": "fixture",
        }
        for path in sorted(codex_runtime.skill_paths(adapter.codex_home))
    ]
    entry = {"cwd": str(workspace), "skills": skills, "errors": []}
    if kind == "enabled":
        skills[0]["enabled"] = True
    elif kind == "errors":
        entry["errors"] = [
            {"path": skills[0]["path"], "message": "fixture parse error"}
        ]
    elif kind == "user":
        skills[0]["scope"] = "user"
    elif kind == "unknown_path":
        skills[0]["path"] = str(tmp_path / "outside" / "SKILL.md")
    elif kind == "missing":
        skills.pop()
    else:
        entry["cwd"] = str(tmp_path)
    fake_sdk.skills_response = {"data": [entry]}
    with pytest.raises(newsletter_errors.EditorError) as exc:
        await run(adapter, workspace)
    assert exc.value.code == "configuration"
    assert fake_sdk.thread_options is None and fake_sdk.closed


async def test_mock_explicit_synthetic_chart(tmp_path, packet):
    packet["content"]["tags"].append("demo-chart")
    packet["content"]["body"] = "显眼的虚构测试数据：A=12, B=8, C=missing"
    packet["content"]["sources"][0].update(
        id="demo", access_scope="dataset", excerpt=packet["content"]["body"]
    )
    result = await newsletter_editor.MockEditor().prepare(
        [packet], "2026-09-05", tmp_path / "job"
    )
    assert "MOCK" in result.draft["chart"]["caption"]
    assert result.draft["chart"]["points"][0]["decimal_value"] == "12"
    assert "decimal_value" not in result.draft["chart"]["points"][2]
    contracts.validate_draft(result.draft, [packet])


async def test_mock_chart_tag_does_not_invent_numbers(tmp_path, packet):
    packet["content"]["tags"].append("demo-chart")
    packet["content"]["sources"][0].update(id="demo", access_scope="dataset")
    with pytest.raises(newsletter_errors.EditorError) as error:
        await newsletter_editor.MockEditor().prepare(
            [packet], "2026-09-05", tmp_path / "job"
        )
    assert error.value.code == "invalid_input"

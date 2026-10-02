"""Runner safety tests use injected fakes only, not model-quality evaluation."""

import asyncio
import copy
import importlib.util as util
import json
import pathlib
import stat
import types

import httpx
import pytest

import newsletter.contracts as contracts
import newsletter.errors as errors
import newsletter.usage as newsletter_usage
import newsletter.workflow.schema as newsletter_workflow_schema
import tests.support.publication as publication
import tests.support.usage as tests_support_usage

SCRIPT = (
    pathlib.Path(__file__).resolve().parents[1]
    / "scripts"
    / "evaluate_prompts.py"
)
SPEC = util.spec_from_file_location("prompt_evaluation_script", SCRIPT)
runner = util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)


def selection_case(identifier="selection-test", **changes):
    return {
        "id": identifier,
        "kind": "selection",
        "prompt": {
            "task": "Synthetic input, not an actual research or mail request."
        },
        "instructions": "Offline test instructions. Do not use tools.",
        "schema": newsletter_workflow_schema.planning_schema(
            ["candidate-1"], [publication.URL], 1
        ),
        "validation": {
            "candidate_ids": ["candidate-1"],
            "source_urls": [publication.URL],
            "max_tasks": 1,
        },
        "allow_web": False,
        **changes,
    }


def selection_reply():
    return contracts.canonical_json(
        {
            "research_tasks": [publication.task()],
            "note": "Synthetic test selection.",
        }
    )


def summary_case():
    return selection_case(
        "summary-test",
        kind="summary",
        # Transport shape is independent of application validation in this test.
        schema=newsletter_workflow_schema.object_schema(
            {key: {"type": "string"} for key in runner.BODY_FIELDS}
        ),
        validation={
            "story_id": "story-1",
            "packets": [publication.packet()],
            "paragraph_limit": 2,
        },
    )


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    async def forbidden(*args, **kwargs):
        pytest.fail(
            "A prompt-runner boundary test attempted real network access"
        )

    monkeypatch.setattr(
        httpx.AsyncHTTPTransport, "handle_async_request", forbidden
    )


@pytest.fixture
def harness(tmp_path):
    codex_home = tmp_path / "dedicated-auth"
    codex_home.mkdir(mode=0o700)
    state = types.SimpleNamespace(
        calls=[], constructors=[], replies=[], progress=[]
    )

    class FakeEditor:
        def __init__(self, home, model, *, timeout_seconds):
            state.constructors.append((home, model, timeout_seconds))
            self.model = model

        async def execute(self, prompt, schema, instructions, workspace):
            state.calls.append((prompt, schema, instructions, workspace))
            assert state.replies, "No hidden retries or unexpected model calls"
            print("private-diagnostic-sentinel")
            with newsletter_usage.codex_usage(self.model) as usage:
                usage.start_turn()
                usage.bind_turn("thread-test", "turn-test")
                usage.observe(
                    "thread/tokenUsage/updated",
                    tests_support_usage.notification(),
                )
                usage.observe(
                    "thread/tokenUsage/updated",
                    tests_support_usage.notification(150, 30, cached=90),
                )
                response = state.replies.pop(0)
                if isinstance(response, BaseException):
                    raise response
                if response == "wait":
                    await asyncio.sleep(30)
                    pytest.fail("Timeout did not cancel the model task")
                usage.observe("turn/completed", {"turn": {"id": "turn-test"}})
                return response

    async def run(cases=None, **overrides):
        kwargs = {
            "output": tmp_path / "results",
            "codex_home": codex_home,
            "allow_model_calls": True,
            "editor_factory": FakeEditor,
            "progress": state.progress.append,
            **overrides,
        }
        return await runner.evaluate(
            {"cases": cases or [selection_case()]}, **kwargs
        )

    state.run = run
    state.home = codex_home
    state.output = tmp_path / "results"
    return state


async def test_authorization_precedes_directories_and_editor(
    harness,
):
    with pytest.raises(
        runner.EvaluationError, match="model_calls_not_authorized"
    ):
        await harness.run(allow_model_calls=False)
    assert not harness.output.exists()
    assert not harness.calls and not harness.constructors


@pytest.mark.parametrize(
    "location", ["existing", "auth", "repo", "other-repo", "symlink"]
)
async def test_output_refuses_existing_repo_auth_and_symlink_locations(
    harness, tmp_path, location
):
    output = harness.output
    if location == "existing":
        output.mkdir()
        (output / "sentinel").write_text("do not overwrite")
    elif location == "auth":
        output = harness.home / "results"
    elif location == "repo":
        output = runner.REPOSITORY / "must-not-be-created-eval-results"
    elif location == "other-repo":
        checkout = tmp_path / "other-checkout"
        checkout.mkdir()
        (checkout / ".git").write_text("gitdir: /some/worktree")
        output = checkout / "results"
    else:
        link = tmp_path / "link"
        link.symlink_to(harness.home, target_is_directory=True)
        output = link / "results"
    with pytest.raises(runner.EvaluationError, match="unsafe_path"):
        await harness.run(output=output)
    assert not harness.calls
    if location == "existing":
        assert (output / "sentinel").read_text() == "do not overwrite"
    else:
        assert not output.exists()


@pytest.mark.parametrize(
    "folder", ["CloudStorage", "Mobile Documents", "codex-auth"]
)
async def test_output_refuses_known_cloud_sync_and_other_auth_homes(
    harness, tmp_path, monkeypatch, folder
):
    user_home = tmp_path / "user"
    parent = user_home / "Library" / folder
    parent.mkdir(parents=True)
    monkeypatch.setattr(
        pathlib.Path, "home", classmethod(lambda cls: user_home)
    )
    output = parent / "results"
    with pytest.raises(runner.EvaluationError, match="unsafe_path"):
        await harness.run(output=output)
    assert not output.exists() and not harness.calls


async def test_case_inputs_outputs_latest_usage_and_private_modes_are_durable(
    harness, capsys
):
    cases = [selection_case(), summary_case()]
    untouched = copy.deepcopy(cases)
    harness.replies = [
        (selection_reply(), set(), False),
        (contracts.canonical_json(publication.story()), set(), False),
    ]
    result = await harness.run(cases)
    assert result["all_structurally_valid"] and cases == untouched
    assert len(harness.calls) == 2
    assert len({call[-1] for call in harness.calls}) == 2
    assert all(
        home == harness.home and model == "gpt-6-sol" and timeout == 300
        for home, model, timeout in harness.constructors
    )
    # Cumulative 120 -> 180 snapshots replace one another, never sum to 300.
    assert result["usage"]["usage"]["total_tokens"] == 360
    assert result["usage"]["usage"]["cached_input_tokens"] == 180
    assert not result["usage"]["partial"]
    assert not result["cases"][0]["correction_observed"]
    for index, (case, call) in enumerate(
        zip(cases, harness.calls, strict=True), 1
    ):
        directory = harness.output / f"case-{index:03d}"
        saved = json.loads((directory / "input.json").read_text())
        assert saved["input_hash"] == contracts.content_hash(case)
        assert (
            saved["actual_prompt"]
            == call[0]
            == contracts.canonical_json(case["prompt"])
        )
        assert saved["schema"] == call[1] == case["schema"]
        assert saved["instructions"] == call[2] == case["instructions"]
        assert (directory / "raw-output.txt").is_file()
        assert (
            "private-diagnostic-sentinel"
            in (directory / "diagnostics.log").read_text()
        )
        events = [
            json.loads(line)
            for line in (directory / "usage-events.jsonl")
            .read_text()
            .splitlines()
        ]
        assert events[-1] == result["cases"][index - 1]["usage_records"][0]
    for path in [harness.output, *harness.output.rglob("*")]:
        assert stat.S_IMODE(path.stat().st_mode) == (
            0o700 if path.is_dir() else 0o600
        )
    manifest = json.loads((harness.output / "manifest.json").read_text())
    assert manifest["input_hash"] == contracts.content_hash({"cases": cases})
    assert manifest["versions"]["code_sha256"]["scripts/evaluate_prompts.py"]
    assert json.loads((harness.output / "summary.json").read_text()) == result
    assert "private-diagnostic-sentinel" not in capsys.readouterr().out
    assert all(
        "Synthetic" not in item and "http" not in item
        for item in harness.progress
    )


@pytest.mark.parametrize(
    "error", ["authentication", "configuration", "rate_limit"]
)
async def test_account_failure_persists_partial_usage_and_skips_all_later_cases(
    harness, error
):
    harness.replies = [errors.EditorError(error)]
    result = await harness.run([selection_case(), selection_case("next-case")])
    assert result["stopped_reason"] == error and len(harness.calls) == 1
    assert [case["status"] for case in result["cases"]] == ["failed", "skipped"]
    assert result["usage"]["usage"]["total_tokens"] == 180
    assert result["usage"]["partial"]
    assert not result["cases"][0]["raw_output_available"]
    assert result["cases"][0]["web_observation"]["searched"] is None
    assert (harness.output / "case-002" / "input.json").is_file()
    assert not (harness.output / "case-002" / "raw-output.txt").exists()


@pytest.mark.parametrize(
    "opened,searched", [({publication.URL}, False), (set(), True)]
)
async def test_frozen_input_web_actions_fail_observation_without_retry(
    harness, opened, searched
):
    harness.replies = [
        (selection_reply(), opened, searched),
        (selection_reply(), set(), False),
    ]
    result = await harness.run([selection_case(), selection_case("next-case")])
    assert [case["status"] for case in result["cases"]] == [
        "observation_failure",
        "valid",
    ]
    assert result["cases"][0]["error_code"] == "unexpected_web"
    assert len(harness.calls) == 2
    assert not (harness.output / "case-001" / "validated.json").exists()
    assert (
        harness.output / "case-001" / "raw-output.txt"
    ).read_text() == selection_reply()


async def test_live_discovery_uses_observed_open_and_production_parser(harness):
    case = selection_case(
        "discovery-test",
        kind="discovery",
        allow_web=True,
        schema=newsletter_workflow_schema.discovery_schema(),
        validation={
            "direction": "finance",
            "issue_date": publication.DAY,
            "seeds": [],
            "history": [],
        },
    )
    candidate = {
        "title": "Synthetic candidate",
        "url": publication.URL,
        "doi": "",
        "version": "",
        "event_key": "synthetic-event",
        "published_at": publication.DAY,
        "summary": "A synthetic finding.",
        "why_now": "Synthetic new evidence.",
        "access_scope": "abstract",
    }
    harness.replies = [
        (
            contracts.canonical_json(
                {"candidates": [candidate], "note": "Synthetic scan."}
            ),
            {publication.URL},
            True,
        )
    ]
    result = await harness.run([case])
    assert result["all_structurally_valid"]
    validated = json.loads(
        (harness.output / "case-001" / "validated.json").read_text()
    )
    assert validated["candidates"][0]["direction"] == "finance"
    assert validated["candidates"][0]["provenance"] == "web_open"


@pytest.mark.parametrize("kind", ["selection", "summary"])
async def test_malformed_answers_are_saved_but_never_repaired_by_runner(
    harness, kind
):
    case = selection_case() if kind == "selection" else summary_case()
    if kind == "selection":
        response = contracts.canonical_json(
            {
                "research_tasks": [
                    publication.task(candidate_ids=["foreign-id"])
                ],
                "note": "bad",
            }
        )
    else:
        response = contracts.canonical_json(
            {**publication.story(), "chart": {}}
        )  # body-only means no optional components.
    harness.replies = [(response, set(), False)]
    result = await harness.run([case])
    assert result["cases"][0]["status"] == "failed"
    assert result["cases"][0]["error_code"] == "invalid_output"
    assert len(harness.calls) == 1 and not result["all_structurally_valid"]
    assert (
        harness.output / "case-001" / "raw-output.txt"
    ).read_text() == response


async def test_timeout_records_attempt_and_never_retries_it(harness):
    harness.replies = ["wait"]
    result = await harness.run(timeout=0.01)
    assert result["cases"][0]["error_code"] == "timeout"
    assert result["usage"]["partial"] and len(harness.calls) == 1


async def test_cancellation_stops_future_cases_but_preserves_its_usage(harness):
    harness.replies = [asyncio.CancelledError()]
    result = await harness.run([selection_case(), selection_case("later")])
    assert result["stopped_reason"] == "cancelled"
    assert result["cases"][1]["status"] == "skipped"
    assert result["usage"]["usage"]["total_tokens"] == 180


async def test_unknown_exception_is_sanitized_not_echoed(harness, capsys):
    harness.replies = [RuntimeError("vendor-response-secret-sentinel")]
    result = await harness.run()
    assert result["cases"][0]["error_code"] == "unavailable"
    assert "vendor-response-secret-sentinel" not in contracts.canonical_json(
        result
    )
    assert "vendor-response-secret-sentinel" not in capsys.readouterr().out


async def test_existing_production_correction_recorded_not_hidden_as_one_turn(
    harness,
):
    class CorrectionEditor:
        def __init__(self, *args, **kwargs):
            pass

        async def execute(self, *args):
            with newsletter_usage.codex_usage("fixture-model") as usage:
                for index, (input_tokens, output_tokens) in enumerate(
                    [(100, 20), (250, 50)], 1
                ):
                    turn_id = f"turn-{index}"
                    usage.start_turn()
                    usage.bind_turn("thread-test", turn_id)
                    event = tests_support_usage.notification(
                        input_tokens, output_tokens
                    )
                    event["turnId"] = turn_id
                    usage.observe("thread/tokenUsage/updated", event)
                    usage.observe("turn/completed", {"turn": {"id": turn_id}})
            return selection_reply(), set(), False

    result = await harness.run(editor_factory=CorrectionEditor)
    assert result["cases"][0]["correction_observed"] is True
    assert result["usage"]["invocations"] == 1
    assert result["usage"]["usage"]["total_tokens"] == 300
    assert result["cases"][0]["usage_records"][0]["turns_started"] == 2


@pytest.mark.parametrize(
    "mutation",
    [
        lambda case: case.update(allow_web="false"),
        lambda case: case.update(id="../../escape"),
        lambda case: case["validation"].update(max_tasks=0),
        lambda case: case["schema"].update(uniqueItems=True),
    ],
)
async def test_entire_suite_is_validated_before_any_model_or_artifact(
    harness, mutation
):
    case = selection_case("invalid-second")
    mutation(case)
    with pytest.raises((runner.EvaluationError, errors.EditorError)):
        await harness.run([selection_case(), case])
    assert not harness.calls and not harness.output.exists()


def test_cli_does_not_read_suite_or_env_before_explicit_opt_in(
    tmp_path, capsys
):
    with pytest.raises(SystemExit) as error:
        runner.main(
            [
                "--suite",
                str(tmp_path / "missing.json"),
                "--output",
                str(tmp_path / "output"),
                "--codex-home",
                str(tmp_path / "auth"),
            ]
        )
    assert error.value.code == 2
    assert "--allow-model-calls is required" in capsys.readouterr().err
    assert not (tmp_path / "output").exists()


def test_cli_uses_only_explicit_configuration_not_environment_or_dotenv(
    tmp_path, monkeypatch
):
    suite = tmp_path / "suite.json"
    suite.write_text(contracts.canonical_json({"cases": [selection_case()]}))
    monkeypatch.setenv("NEWSLETTER_MODEL", "must-not-select-from-environment")
    monkeypatch.setenv("NEWSLETTER_CODEX_HOME", "/must-not-use-this-auth")
    monkeypatch.setenv("RESEND_API_KEY", "synthetic-secret-not-a-real-key")
    original_read = pathlib.Path.read_text

    def guarded_read(path, *args, **kwargs):
        assert path.name != ".env", (
            "The evaluator must never automatically load dotenv"
        )
        return original_read(path, *args, **kwargs)

    received = []

    async def capture(suite, **kwargs):
        received.append(kwargs)
        return {"all_structurally_valid": True}

    monkeypatch.setattr(pathlib.Path, "read_text", guarded_read)
    monkeypatch.setattr(runner, "evaluate", capture)
    assert (
        runner.main(
            [
                "--suite",
                str(suite),
                "--output",
                str(tmp_path / "output"),
                "--codex-home",
                str(tmp_path / "explicit-auth"),
                "--allow-model-calls",
            ]
        )
        == 0
    )
    assert received[0]["codex_home"] == tmp_path / "explicit-auth"
    assert received[0]["model"] == "gpt-6-sol" and received[0]["timeout"] == 300

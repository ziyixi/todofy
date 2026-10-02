"""Local diagnostic control-flow tests; these never make provider calls."""

import json
import unittest.mock as mock

import pytest

import newsletter.editor as newsletter_editor
import newsletter.errors as errors
import newsletter.schema_smoke as schema_smoke
import newsletter.settings as settings


@pytest.mark.asyncio
async def test_schema_smoke_checks_all_cases_without_creating_publication(
    tmp_path,
):
    editor = newsletter_editor.CodexEditor(tmp_path)
    cases = schema_smoke.smoke_cases()
    editor.execute = mock.AsyncMock(
        side_effect=[(json.dumps(c[2]), set(), False) for c in cases]
    )
    result = await schema_smoke.check_schemas(editor)
    assert result["accepted"] is True
    assert result["schemas"] == ["brief", "deep", "brief_repair", "review"]
    assert editor.execute.await_count == 4
    assert list(tmp_path.iterdir()) == []
    for call in editor.execute.await_args_list:
        assert not call.args[3].exists()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "reply",
    [("{}", set(), False), ("invalid", set(), False), ("{}", set(), True)],
)
async def test_schema_smoke_fails_on_first_bad_response(tmp_path, reply):
    editor = newsletter_editor.CodexEditor(tmp_path)
    editor.execute = mock.AsyncMock(return_value=reply)
    with pytest.raises(errors.EditorError, match="invalid or unverifiable"):
        await schema_smoke.check_schemas(editor)
    assert editor.execute.await_count == 1


def test_cli_does_not_read_credentials_without_explicit_opt_in(monkeypatch):
    monkeypatch.setattr("sys.argv", ["schema_smoke"])
    monkeypatch.setattr(
        settings.Settings,
        "from_env",
        lambda: pytest.fail("env read"),
    )
    with pytest.raises(SystemExit) as error:
        schema_smoke.main()
    assert error.value.code == 2

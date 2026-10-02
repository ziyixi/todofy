"""Offline launch-boundary tests: no runtime, credentials, model, or network."""

import os
import pathlib
import sys
import types

import pytest

import newsletter._codex_runtime as _codex_runtime
import newsletter.codex_runtime as codex_runtime
import newsletter.errors as errors


@pytest.fixture
def parent_environment():
    # Entirely synthetic: these tests never inspect the user's environment.
    return {
        "PATH": "/synthetic/bin:/usr/bin",
        "HOME": "/synthetic/home",
        "USER": "synthetic-user",
        "LOGNAME": "synthetic-login",
        "TMPDIR": "/synthetic/tmp",
        "LANG": "en_US.UTF-8",
        "LC_ALL": "C.UTF-8",
        "SYSTEMROOT": "C:\\Windows",
        "WINDIR": "C:\\Windows",
        "CODEX_HOME": "/synthetic/dedicated-codex",
        "CODEX_INTERNAL_ORIGINATOR_OVERRIDE": "synthetic-desktop-originator",
        "OPENAI_API_KEY": "synthetic-openai-secret",
        "OPENAI_BASE_URL": "https://synthetic.invalid",
        "ANTHROPIC_API_KEY": "synthetic-anthropic-secret",
        "GEMINI_API_KEY": "synthetic-gemini-secret",
        "RESEND_API_KEY": "synthetic-mail-secret",
        "NOTION_TOKEN": "synthetic-notion-secret",
        "NEWSLETTER_SEND_TOKEN": "synthetic-send-secret",
        "PYTHONPATH": "/synthetic/untrusted-python",
        "LD_PRELOAD": "/synthetic/untrusted-library",
        "DYLD_INSERT_LIBRARIES": "/synthetic/untrusted-library",
        "UNRECOGNIZED_EMPTY_KEY": "",
    }


def expected_environment(parent):
    # Explicit independently maintained boundary, not production's allowlist.
    keys = (
        "PATH",
        "HOME",
        "USER",
        "LOGNAME",
        "TMPDIR",
        "LANG",
        "LC_ALL",
        "SYSTEMROOT",
        "WINDIR",
        "CODEX_HOME",
    )
    return {key: parent[key] for key in keys if key in parent}


def test_runtime_environment_actually_omits_unapproved_keys(parent_environment):
    before = parent_environment.copy()
    result = _codex_runtime.runtime_environment(parent_environment)

    assert result == expected_environment(parent_environment)
    assert "CODEX_INTERNAL_ORIGINATOR_OVERRIDE" not in result
    assert "OPENAI_API_KEY" not in result
    assert "UNRECOGNIZED_EMPTY_KEY" not in result
    assert parent_environment == before
    assert result is not parent_environment


def test_runtime_environment_does_not_invent_missing_system_keys():
    assert (
        _codex_runtime.runtime_environment({"OPENAI_API_KEY": "synthetic"})
        == {}
    )


def test_sdk_overlay_then_final_environment_does_not_mutate_parent(
    monkeypatch, parent_environment
):
    before = parent_environment.copy()
    monkeypatch.setattr(os, "environ", parent_environment)
    dedicated_home = pathlib.Path("/synthetic/other-dedicated-codex")

    overlay = codex_runtime.runtime_env(dedicated_home)
    assert overlay["CODEX_HOME"] == str(dedicated_home)
    for key in (
        "CODEX_INTERNAL_ORIGINATOR_OVERRIDE",
        "OPENAI_API_KEY",
        "RESEND_API_KEY",
        "NOTION_TOKEN",
        "PYTHONPATH",
    ):
        assert overlay[key] == ""

    # Reproduce the SDK's overlay semantics without importing or starting it.
    final = _codex_runtime.runtime_environment(
        {**parent_environment, **overlay}
    )
    expected = expected_environment(parent_environment)
    expected["CODEX_HOME"] = str(dedicated_home)
    assert final == expected
    assert parent_environment == before
    assert os.environ is parent_environment


@pytest.mark.parametrize(
    "bundled_tools", [None, pathlib.Path("/synthetic/bundled tools")]
)
@pytest.mark.parametrize("has_path", [False, True])
def test_helper_execs_only_bundled_runtime_with_exact_environment_and_argv(
    monkeypatch, parent_environment, bundled_tools, has_path
):
    if not has_path:
        parent_environment.pop("PATH")
    before = parent_environment.copy()
    executable = pathlib.Path("/synthetic/bundled runtime/codex")
    fake_bin = types.ModuleType("codex_cli_bin")
    fake_bin.bundled_codex_path = lambda: executable
    fake_bin.bundled_path_dir = lambda: bundled_tools
    monkeypatch.setitem(sys.modules, "codex_cli_bin", fake_bin)
    monkeypatch.setattr(os, "environ", parent_environment)
    # Shell metacharacters must remain literal single argv entries.
    argv = [
        "/synthetic/_codex_runtime.py",
        "--config",
        'test_value="$(never-execute); literal text"',
        "--config",
        'forced_login_method="chatgpt"',
        "app-server",
        "--listen",
        "stdio://",
    ]
    monkeypatch.setattr(sys, "argv", argv.copy())
    calls = []

    class ExecInterceptedError(Exception):
        pass

    def capture_execve(path, args, env):
        calls.append((path, args, env))
        raise ExecInterceptedError

    monkeypatch.setattr(os, "execve", capture_execve)
    with pytest.raises(ExecInterceptedError):
        _codex_runtime.main()

    expected = expected_environment(parent_environment)
    if bundled_tools is not None:
        expected["PATH"] = (
            f"{bundled_tools}{os.pathsep}{before['PATH']}"
            if has_path
            else str(bundled_tools)
        )
    assert calls == [(str(executable), [str(executable), *argv[1:]], expected)]
    assert parent_environment == before
    assert os.environ is parent_environment
    assert sys.argv == argv


@pytest.mark.parametrize(
    "overrides",
    [
        (),
        codex_runtime.CONFIG_OVERRIDES,
        ('test_value="$(never-execute); literal text"',),
    ],
)
def test_launch_args_use_isolated_python_and_forward_each_override(overrides):
    expected_configs = tuple(
        part for item in overrides for part in ("--config", item)
    )
    helper = pathlib.Path(codex_runtime.__file__).with_name("_codex_runtime.py")

    assert codex_runtime.launch_args(overrides) == (
        sys.executable,
        "-I",
        str(helper),
        *expected_configs,
        "app-server",
        "--listen",
        "stdio://",
    )


@pytest.mark.parametrize("helper_kind", ["missing", "directory", "symlink"])
def test_launch_args_reject_missing_or_unsafe_helper(
    monkeypatch, tmp_path, helper_kind
):
    monkeypatch.setattr(
        codex_runtime, "__file__", str(tmp_path / "codex_runtime.py")
    )
    helper = tmp_path / "_codex_runtime.py"
    if helper_kind == "directory":
        helper.mkdir()
    elif helper_kind == "symlink":
        target = tmp_path / "synthetic-helper.py"
        target.write_text(
            "# synthetic fixture; never executed\n", encoding="utf-8"
        )
        helper.symlink_to(target)

    with pytest.raises(errors.EditorError) as error:
        codex_runtime.launch_args(codex_runtime.CONFIG_OVERRIDES)
    assert error.value.code == "configuration"

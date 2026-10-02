"""Prove the internal annotations reject unsafe state/result edits offline."""

import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]


def check_types(
    source: str, cache: pathlib.Path
) -> subprocess.CompletedProcess[str]:
    case = cache.with_suffix(".py")
    case.write_text(source, encoding="utf-8")
    return subprocess.run(
        [
            sys.executable,
            "-m",
            "mypy",
            "--config-file",
            str(ROOT / "pyproject.toml"),
            "--cache-dir",
            str(cache),
            "--no-incremental",
            str(ROOT / "src/newsletter"),
            str(case),
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )


def test_internal_state_and_result_types_accept_real_boundaries(tmp_path):
    result = check_types(
        (
            "\n"
            "from newsletter.adapters import MailAdapter\n"
            "from newsletter.store import Store\n"
            "from newsletter.types import DeliveryResult, "
            "EditionRecord, RenderResult, ReviewResult\n"
            "\n"
            "def update(store: Store, rendered: RenderResult, review: "
            "ReviewResult) -> EditionRecord:\n"
            '    store.projection_result("packet", "unknown")\n'
            '    return store.finish("edition", state="ready", '
            "rendered=rendered, review=review)\n"
            "\n"
            "async def dispatch(mail: MailAdapter, edition: "
            "EditionRecord) -> DeliveryResult:\n"
            '    return await mail.send(edition, "stable-key")\n'
        ),
        tmp_path / "valid-cache",
    )
    assert result.returncode == 0, result.stdout + result.stderr


def test_internal_types_reject_misspelled_states_and_unfrozen_results(tmp_path):
    result = check_types(
        (
            "\n"
            "from newsletter.store import Store\n"
            "from newsletter.types import DeliveryResult, "
            "RenderResult\n"
            "\n"
            "def invalid(store: Store) -> None:\n"
            '    store.finish("edition", state="sent")\n'
            '    store.finish("edition", delivery_state="delivered")\n'
            '    store.projection_result("packet", "retry")\n'
            "\n"
            'delivery: DeliveryResult = {"delivery_state": '
            '"delivered", "provider_message_id": "id"}\n'
            'rendered: RenderResult = {"html": "body", "text": "body", '
            '"chart_png": ""}\n'
        ),
        tmp_path / "invalid-cache",
    )
    assert result.returncode == 1, result.stdout + result.stderr
    assert result.stdout.count("[arg-type]") == 3, result.stdout
    assert result.stdout.count("[typeddict-item]") == 2, result.stdout
    assert "render_hash" in result.stdout

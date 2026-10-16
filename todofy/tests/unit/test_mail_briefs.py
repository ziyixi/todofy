"""The one-time brief backfill (runtime/mail_briefs.py) on host CPython: D1 and the object's SQLite are host SQLite
(plus_support.py), Todoist and Gemini fakes that journal every call. The job in workerd, from the alarm, is
tests/runtime/test_plus_mailbox.py. Synthetic mail only.
"""

import asyncio
import json
import types
import uuid
from collections.abc import Iterator
from datetime import UTC, datetime
from typing import Any

import pytest

from tests.unit.plus_support import D1, Storage, stubbed_pyodide
from todofy.core import plus, prompts
from todofy.core.classify import Failure, HttpOutcome, classify_gemini

NOW = int(datetime(2026, 10, 16, 18, 0, tzinfo=UTC).timestamp())
MIDNIGHT = int(datetime(2026, 10, 17, tzinfo=UTC).timestamp())
LABELS = ("office", "home", "committed", "focus", "candiate", "quarter", "quick")


class Core:
    """What the job uses of TodofyCore: env, its SQLite, the Todoist gate and a token budget."""

    def __init__(self, d1: D1, storage: Storage, budget: int) -> None:
        self.env = types.SimpleNamespace(DB=d1, TODOIST_DEFAULT_PROJECT_ID="mail")
        self.sql = storage.sql
        self.ctx = types.SimpleNamespace(storage=storage)
        self.plus_lock = asyncio.Lock()
        self.budget, self.spent, self.shares = budget, 0, []
        self.wait: int | None = None

    def todoist_wait(self, _now: int) -> int | None:
        return self.wait

    def reserve_tokens(self, tokens: int, _now: int, *, share: float = 1.0) -> bool:
        self.shares.append(share)
        if self.spent + tokens > self.budget * share:
            return False
        self.spent += tokens
        return True

    def settle_tokens(self, reserved: int, used: int, _now: int) -> None:
        self.spent += used - reserved


class Stack:
    def __init__(self, runtime: Any, monkeypatch: pytest.MonkeyPatch) -> None:
        self.runtime = runtime
        runtime.clock["ms"] = NOW * 1000
        self.d1 = D1()
        storage = Storage([])
        for statement in (*runtime.mail_briefs.DO_SCHEMA, *runtime.plus_receipts.DO_SCHEMA):
            storage.sql.exec(statement)
        storage.sql.exec("CREATE TABLE llm_inflight (event_id TEXT PRIMARY KEY, day TEXT NOT NULL, reserved INTEGER)")
        self.core = Core(self.d1, storage, 1_000_000)
        self.calls: list[str] = []
        self.tasks: list[dict[str, Any]] = []
        self.answers: list[Any] = []  # text, or None for a failed call
        self.inputs: list[tuple[str, str]] = []
        monkeypatch.setattr(runtime.todoist, "metadata", self.metadata)
        monkeypatch.setattr(runtime.todoist, "tasks", self.list_tasks)
        monkeypatch.setattr(runtime.plus_api, "account_day", lambda _tz: "2026-10-16")
        monkeypatch.setattr(runtime.gemini, "generate", self.generate)

    async def metadata(self, _core: Any, *, fresh: bool = False) -> dict[str, Any]:
        self.calls.append("metadata")
        return {"timezone": "UTC", "labels": [{"id": "id-" + name, "name": name} for name in LABELS], "filters": []}

    async def list_tasks(self, _core: Any, limit: int = 200, cursor: str = "", **filters: str):
        self.calls.append("tasks")
        return [task for task in self.tasks if task["project_id"] == filters["project_id"]], ""

    async def generate(self, _env: Any, *, system: str, user: str, deadline_ms: int, models: list[str]) -> Any:
        self.calls.append("gemini")
        self.inputs.append((system, user))
        answer = self.answers.pop(0)
        failure = HttpOutcome(failure=Failure.TIMEOUT) if answer is None else HttpOutcome(status=200)
        return types.SimpleNamespace(verdict=classify_gemini(failure, answer), text=answer or "", tokens=120)

    def enable(self) -> None:
        mapping = [{"role": name, "id": "id-" + name, "label": name} for name in LABELS if name != "quick"]
        self.d1.db.execute(
            "INSERT INTO plus_settings (id, mapping, timezone, week_start, enabled) VALUES (1, ?, 'UTC', ?, 1)",
            (json.dumps({"etag": plus.fingerprint([mapping, "UTC"]), "labels": mapping}), "2026-10-12"),
        )

    def mail(self, task_id: str, *, brief: str | None = None, project: str = "mail", **fields: Any) -> str:
        event_id = str(uuid.uuid4())
        self.d1.db.execute(
            "INSERT INTO summaries (event_id, created_at, subject, summary, model, task_id, brief)"
            " VALUES (?, 1, ?, ?, 'm', ?, ?)",
            (event_id, "Synthetic subject " + task_id, "旧格式的摘要。第二句。", task_id, brief),
        )
        self.tasks.append({"id": task_id, "content": "t", "project_id": project, "labels": [], **fields})
        return event_id

    def tick(self) -> None:
        asyncio.run(self.runtime.mail_briefs.tick(self.core, self.runtime.clock["ms"] // 1000))

    def wait(self, seconds: int) -> None:
        self.runtime.clock["ms"] += seconds * 1000

    def job(self) -> Any:
        return self.runtime.mail_briefs.job(self.core.sql)

    def briefs(self) -> dict[str, str | None]:
        return {row["task_id"]: row["brief"] for row in self.d1.db.execute("SELECT task_id, brief FROM summaries")}


@pytest.fixture
def stack(monkeypatch: pytest.MonkeyPatch) -> Iterator[Stack]:
    with stubbed_pyodide(monkeypatch) as stubs:
        from todofy.runtime import gemini, mail_briefs, plus_api, plus_receipts
        from todofy.runtime import plus_todoist as todoist

        runtime = types.SimpleNamespace(
            mail_briefs=mail_briefs,
            plus_api=plus_api,
            plus_receipts=plus_receipts,
            gemini=gemini,
            todoist=todoist,
            clock=stubs["clock"],
        )
        yield Stack(runtime, monkeypatch)


def test_it_waits_for_plus_then_asks_once_for_each_mail_in_the_mailbox_without_a_brief(stack):
    stack.mail("old")
    stack.mail("stored", brief="已有的简介。")
    stack.mail("clarified", labels=["quick"])
    stack.mail("moved", project="work")
    stack.tasks.append({"id": "own", "content": "t", "project_id": "mail", "labels": []})
    stack.tick()
    assert stack.calls == [] and stack.job() == ("collect", NOW + 3600)  # Plus is not set up yet
    stack.enable()
    stack.runtime.clock["ms"] += 3600_000
    stack.tick()
    assert stack.calls == ["metadata", "tasks"] and stack.job().state == "queued"
    stack.answers = ["**这是一封合成测试邮件，无需操作。**\n第二行不要"]
    stack.tick()
    assert stack.briefs() == {
        "old": "这是一封合成测试邮件，无需操作。",
        "stored": "已有的简介。",
        "clarified": None,
        "moved": None,
    }
    [(system, user)] = stack.inputs
    assert system == prompts.BRIEF_EMAIL and user == "Synthetic subject old\n\n旧格式的摘要。第二句。"
    assert stack.core.shares == [0.5] and stack.core.spent == 120
    stack.wait(stack.runtime.mail_briefs.PACE)
    stack.tick()
    assert stack.job().state == "done"
    calls = list(stack.calls)
    for _ in range(3):
        stack.runtime.clock["ms"] += 86_400_000
        stack.tick()
    assert stack.calls == calls  # done: it never runs again
    assert stack.runtime.mail_briefs.next_at(stack.core.sql) is None


def test_one_mail_per_step_and_a_brief_stored_meanwhile_wins(stack):
    stack.enable()
    queued = sorted([(stack.mail("a"), "a"), (stack.mail("b"), "b")])  # the queue goes by event ID
    stack.tick()
    # The first one gets a brief another way before its turn (a restore, an older release completing it).
    stack.d1.db.execute("UPDATE summaries SET brief = '别处写的。' WHERE task_id = ?", (queued[0][1],))
    stack.answers = ["模型的简介。"]
    stack.tick()
    assert stack.calls.count("gemini") == 0  # its turn only took it off the queue
    stack.tick()
    assert stack.calls.count("gemini") == 1
    assert stack.briefs() == {queued[0][1]: "别处写的。", queued[1][1]: "模型的简介。"}


def test_the_backfill_stops_for_the_day_at_its_share_of_the_budget(stack):
    stack.enable()
    stack.mail("a")
    stack.tick()
    stack.core.spent = 499_000
    stack.tick()
    assert "gemini" not in stack.calls and stack.job() == ("queued", MIDNIGHT)
    stack.tick()
    assert "gemini" not in stack.calls  # nothing before the next UTC day
    stack.runtime.clock["ms"] = MIDNIGHT * 1000
    stack.core.spent = 0
    stack.answers = ["次日补上的简介。"]
    stack.tick()
    assert stack.briefs() == {"a": "次日补上的简介。"}


def test_a_mail_whose_call_keeps_failing_is_left_to_its_first_sentence(stack):
    stack.enable()
    stack.mail("a")
    stack.tick()
    stack.answers = [None, None, None]
    for attempt in range(3):
        stack.tick()
        if attempt < 2:
            assert stack.job() == ("queued", stack.runtime.clock["ms"] // 1000 + 600)
            stack.wait(600)
    assert stack.calls.count("gemini") == 3 and stack.briefs() == {"a": None}
    stack.wait(stack.runtime.mail_briefs.PACE)
    stack.tick()
    assert stack.job().state == "done"


def test_a_mail_whose_step_keeps_throwing_is_given_up_after_max_attempts(stack):
    """Each attempt counts before its call: a transport that throws, or a D1 save that fails after the call, uses
    one of MAX_ATTEMPTS as a failed call does, so the job ends instead of retrying the same mail every RETRY."""
    briefs = stack.runtime.mail_briefs
    stack.enable()
    stack.mail("old")
    stack.mail("next")
    stack.tick()

    async def broken(*_args: Any, **_kwargs: Any) -> Any:
        stack.calls.append("gemini")
        raise RuntimeError("synthetic transport failure")

    stack.runtime.gemini.generate = broken
    for _ in range(briefs.MAX_ATTEMPTS):
        with pytest.raises(RuntimeError):
            stack.tick()
        briefs.postpone(stack.core.sql, stack.runtime.clock["ms"] // 1000)  # what TodofyCore._briefs_tick does
        stack.wait(briefs.RETRY)
    assert stack.calls.count("gemini") == briefs.MAX_ATTEMPTS
    stack.runtime.gemini.generate = stack.generate
    stack.answers = ["下一封的简介。"]
    stack.tick()  # the given-up mail leaves the queue without a call
    stack.tick()
    assert stack.calls.count("gemini") == briefs.MAX_ATTEMPTS + 1
    assert set(stack.briefs().values()) == {None, "下一封的简介。"}


def test_model_calls_are_paced(stack):
    """Two calls a minute at most: the backlog never runs into Gemini's per-minute limit that new mail shares."""
    briefs = stack.runtime.mail_briefs
    stack.enable()
    stack.mail("a")
    stack.mail("b")
    stack.tick()
    stack.answers = ["简介一。", "简介二。"]
    stack.tick()
    assert stack.calls.count("gemini") == 1
    assert briefs.next_at(stack.core.sql) == NOW + briefs.PACE
    stack.wait(briefs.PACE - 1)
    stack.tick()
    assert stack.calls.count("gemini") == 1
    stack.wait(1)
    stack.tick()
    assert stack.calls.count("gemini") == 2


def test_a_closed_todoist_postpones_the_collection(stack):
    stack.enable()
    stack.mail("a")
    stack.core.wait = NOW + 900
    stack.tick()
    assert stack.calls == [] and stack.job() == ("collect", NOW + 900)


def test_a_step_that_throws_is_tried_again_later_never_at_once(stack):
    stack.enable()
    stack.mail("old")
    stack.tick()
    assert stack.job().state == "queued"

    async def broken(*_args: Any, **_kwargs: Any) -> Any:
        raise RuntimeError("synthetic transport failure")

    stack.runtime.gemini.generate = broken
    with pytest.raises(RuntimeError):
        stack.tick()
    # The coordinator postpones the job when a step throws (TodofyCore._briefs_tick).
    stack.runtime.mail_briefs.postpone(stack.core.sql, NOW)
    assert stack.job() == ("queued", NOW + stack.runtime.mail_briefs.RETRY)
    assert stack.runtime.mail_briefs.next_at(stack.core.sql) == NOW + stack.runtime.mail_briefs.RETRY
    # The reservation was settled in full (the call's usage is unknown) and nothing is left in flight.
    assert stack.core.spent > 0
    assert stack.core.sql.exec("SELECT count(*) AS n FROM llm_inflight").toArray()[0].n == 0


def test_the_logs_carry_counts_only(stack, capsys):
    stack.enable()
    stack.mail("old")
    stack.tick()
    stack.answers = ["合成机密简介。"]
    stack.tick()
    stack.wait(stack.runtime.mail_briefs.PACE)
    stack.tick()
    logged = capsys.readouterr().out
    assert stack.job().state == "done" and logged
    for text in ("合成机密", "Synthetic subject", "旧格式"):
        assert text not in logged

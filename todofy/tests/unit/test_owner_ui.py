"""core/owner_ui.py: todofy.ui.v1's request rules, cursors and the mapping from the ledger's dicts to the generated
messages (proto/todofy/ui/v1), and the IDL's enums against core/vocab.py."""

import json
import re
from pathlib import Path

import pytest
from ziyixi_proto.todofy.ui.v1 import mail_event_pb, reports_pb, status_pb
from ziyixi_proto.wire_json import from_wire, wire_name

from todofy.core import owner_ui as ui
from todofy.core.owner_ui import Reason, UiError
from todofy.core.sql import ACTIVE_STATES
from todofy.core.vocab import (
    EVENT_ERROR_CODES,
    REMINDER_ERROR_CODES,
    EventState,
    Reconcile,
    ReminderState,
)

EVENT = "0b8f5a4e-3c1d-4c52-9f0e-2d7c8b6a5f41"
AT = "2026-09-28T08:00:00Z"


def names(cls) -> set[str]:
    return {name for member in cls if (name := wire_name(member)) is not None}


def refused(reason: Reason):
    return pytest.raises(UiError, match=f"^{reason}$")


class TestVocabulary:
    """The IDL's enums name exactly what the ledger writes, so every row maps to a value (never UNSPECIFIED)."""

    def test_event_states(self):
        assert names(mail_event_pb.MailEvent_State) == set(EventState)

    def test_event_error_codes(self):
        assert names(mail_event_pb.EventErrorCode) == set(EVENT_ERROR_CODES)

    def test_reconcile_actions(self):
        assert names(mail_event_pb.ReconcileAction) == set(Reconcile)

    def test_reminder_states_and_codes(self):
        assert names(status_pb.DailyReminder_State) == set(ReminderState)
        assert names(status_pb.ReminderErrorCode) == set(REMINDER_ERROR_CODES)

    def test_transition_actors_match_the_migration_check(self):
        migration = (Path(__file__).parents[2] / "migrations" / "0001_init.sql").read_text()
        actors = re.search(r"CHECK \(actor IN \(([^)]*)\)\)", migration).group(1)
        assert names(mail_event_pb.Transition_Actor) == set(re.findall(r"'([^']*)'", actors))

    def test_active_counts_name_every_active_state(self):
        fields = {name.removesuffix("_count") for name in status_pb.ActiveCounts.__dataclass_fields__}
        assert fields == set(ACTIVE_STATES)


class TestRequests:
    def test_page_size_follows_aip_158(self):
        assert ui.page_size(0, 50, 100) == 50
        assert ui.page_size(7, 50, 100) == 7
        assert ui.page_size(1000, 50, 100) == 100
        with refused(Reason.BAD_REQUEST):
            ui.page_size(-1, 50, 100)

    def test_event_names(self):
        assert ui.event_id(f"mailEvents/{EVENT}") == EVENT
        with refused(Reason.NOT_FOUND):
            ui.event_id("mailEvents/not-a-uuid")
        with refused(Reason.BAD_REQUEST):
            ui.event_id(f"events/{EVENT}")

    def test_legacy_text_names(self):
        assert ui.legacy_key(f"legacyTexts/{EVENT}") == EVENT
        # An imported cache row without an event stays in D1 only (AIP-122: no `:` in an ID).
        for name in ("legacyTexts/legacy:row-12", "legacyTexts/legacy:", "legacyTexts/legacy-abc"):
            with refused(Reason.NOT_FOUND):
                ui.legacy_key(name)

    def test_etag_is_a_version(self):
        assert ui.etag_version("5") == 5
        for stale in ("", "0", "05", "v5", "5.0", str(2**53)):
            with refused(Reason.ETAG_MISMATCH):
                ui.etag_version(stale)

    def test_event_filter_is_one_restriction(self):
        assert ui.event_filter("") == (None, False)
        assert ui.event_filter("  ") == (None, False)
        assert ui.event_filter("state = TODO_UNKNOWN") == ("todo_unknown", False)
        assert ui.event_filter("state=COMPLETE") == ("complete", False)
        assert ui.event_filter(" attention = true ") == (None, True)
        for bad in (
            "state = todo_unknown",
            "state = UNSPECIFIED",
            "state = SLEEPING",
            "attention = false",
            "attention = TRUE",
            "state = PENDING AND attention = true",
            "state = PENDING OR state = COMPLETE",
            "state != PENDING",
            "subject = x",
            "PENDING",
            "state = " + "A" * 64,
        ):
            with refused(Reason.BAD_REQUEST):
                ui.event_filter(bad)

    def test_every_listed_state_reads_as_a_filter(self):
        for member in mail_event_pb.MailEvent_State:
            if member:
                assert ui.event_filter(f"state = {member.name}") == (wire_name(member), False)

    def test_task_id_only_with_task_created(self):
        created, dismiss = mail_event_pb.ReconcileAction.TASK_CREATED, mail_event_pb.ReconcileAction.DISMISS
        assert ui.reconcile_task_id(created, "6X7rM8997g3RQmvh") == "6X7rM8997g3RQmvh"
        assert ui.reconcile_task_id(dismiss, "") is None
        for bad in ("", "a" * 65, "has space"):
            with refused(Reason.BAD_REQUEST):
                ui.reconcile_task_id(created, bad)
        with refused(Reason.BAD_REQUEST):
            ui.reconcile_task_id(dismiss, "6X7rM8997g3RQmvh")

    def test_read_request_is_strict(self):
        from ziyixi_proto.todofy.ui.v1 import todofy_ui_service_pb as pb

        read = ui.read_request(pb.ListMailEventsRequest, '{"page_size": 3, "filter": "state = PENDING"}')
        assert read.page_size == 3 and read.filter == "state = PENDING"
        for text in ('{"limit": 3}', '{"state": "pending"}', '{"filter": 7}', "not json", "[]"):
            with refused(Reason.BAD_REQUEST):
                ui.read_request(pb.ListMailEventsRequest, text)


class TestCursors:
    def test_event_cursor_round_trip(self):
        assert ui.event_cursor(None) is None
        assert ui.event_cursor(ui.cursor_text({"at": 1700000000, "id": EVENT})) == (1700000000, EVENT)

    @pytest.mark.parametrize(
        "text", ["[]", "{}", '{"at": -1, "id": "x"}', f'{{"at": true, "id": "{EVENT}"}}', '{"at": 1, "id": "x"}', "{"]
    )
    def test_event_cursor_refuses_anything_else(self, text):
        with refused(Reason.BAD_REQUEST):
            ui.event_cursor(text)

    def test_day_cursors(self):
        assert ui.day_cursor('{"day": "2026-09-28"}') == "2026-09-28"
        with refused(Reason.BAD_REQUEST):
            ui.day_cursor('{"day": "2026-9-28"}')
        assert ui.cursor_text(None) is None

    @pytest.mark.parametrize("value", ["2026-02-30", "2026-13-01", "2026-00-10", "0001-01-01", "1969-12-31"])
    def test_a_cursor_must_name_a_real_day(self, value):
        with refused(Reason.BAD_REQUEST):
            ui.day_cursor(json.dumps({"day": value}))


def summary_row(**overrides):
    return {
        "event_id": EVENT,
        "state": "todo_unknown",
        "error_code": "lookup_not_found",
        "attempt_count": 0,
        "task_id": None,
        "received_at": AT,
        "updated_at": "2026-09-28T08:02:10Z",
        "next_attempt_at": None,
        "attention": True,
        "imported": False,
    } | overrides


def detail_row(**overrides):
    return (
        summary_row()
        | {
            "version": 5,
            "crashes": 0,
            "subject": "Quarterly tax reminder",
            "from": "billing@example.com",
            "summary": "季度预缴税截止日期为 10 月 15 日。",
            "summary_model": "gemini-3.8-flash",
            "todo_body": "**FROM: billing@example.com**\n\nMail Hero event: " + EVENT,
            "todoist_request_id": "todofy-0123456789abcdef0123456789ab",
            "allowed_actions": ["task_created", "task_not_created", "dismiss"],
            "transitions": [
                {"at": AT, "from_state": None, "to_state": "pending", "error_code": None, "actor": "worker"},
                {
                    "at": AT,
                    "from_state": "summarized",
                    "to_state": "todo_unknown",
                    "error_code": "todo_result_unknown",
                    "actor": "worker",
                },
            ],
            "has_legacy_text": False,
        }
        | overrides
    )


BASIC_EVENT = {
    "name": f"mailEvents/{EVENT}",
    "state": "todo_unknown",
    "error_code": "lookup_not_found",
    "receive_time": AT,
    "update_time": "2026-09-28T08:02:10Z",
    "attention": True,
}


class TestMessages:
    def test_a_list_row_has_only_the_list_fields(self):
        assert json.loads(ui.answer(ui.mail_event(summary_row(), full=False))) == BASIC_EVENT

    def test_the_basic_view_of_a_detail_is_the_list_row(self):
        assert json.loads(ui.answer(ui.mail_event(detail_row(), full=False))) == BASIC_EVENT

    def test_views_follow_aip_157(self):
        view = mail_event_pb.MailEventView
        assert ui.full_view(view.UNSPECIFIED) and ui.full_view(view.FULL) and not ui.full_view(view.BASIC)
        ui.list_view(view.UNSPECIFIED)
        ui.list_view(view.BASIC)
        with refused(Reason.BAD_REQUEST):
            ui.list_view(view.FULL)

    def test_a_detail(self):
        wire = json.loads(ui.answer(ui.mail_event(detail_row())))
        assert wire["etag"] == "5" and wire["version"] == 5
        assert wire["sender"] == "billing@example.com"
        assert wire["allowed_actions"] == ["task_created", "task_not_created", "dismiss"]
        assert wire["transitions"][0] == {"transition_time": AT, "state": "pending", "actor": "worker"}
        assert wire["transitions"][1]["prior_state"] == "summarized"
        assert "legacy_text" not in wire and "canary" not in wire

    def test_a_detail_with_legacy_text_and_a_canary(self):
        wire = json.loads(ui.answer(ui.mail_event(detail_row(has_legacy_text=True, canary=True, allowed_actions=[]))))
        assert wire["legacy_text"] == f"legacyTexts/{EVENT}"
        assert wire["canary"] is True and "allowed_actions" not in wire

    def test_an_unknown_code_reads_as_unset(self):
        wire = json.loads(ui.answer(ui.mail_event(summary_row(error_code="something_new"), full=False)))
        assert "error_code" not in wire

    @pytest.mark.parametrize("email_models", [None, ["lite", "m1", "m2"]])
    def test_service_status(self, email_models):
        overview = {
            "build": "abc",
            "now": AT,
            # The legacy owner API's shape keeps the retired switches (false) and an empty latest reminder.
            "flags": {
                "maintenance_mode": False,
                "processing_paused": True,
                "force_pause_todoist": False,
                "reminder_enabled": False,
            },
            "counts": {state: index for index, state in enumerate(ACTIVE_STATES)},
            "attention_count": 1,
            "received_24h": 42,
            "latest_reminder": None,
            "next_alarm_at": AT,
            "oldest_due_at": None,
            "gemini": {
                "day": "2026-09-28",
                "token_budget": 2**40,
                "reserved_tokens": 4096,
                "used_tokens": 1,
                "calls": 3,
                "models": ["m1", "m2"],
            },
            "todoist": {"blocked_until": None, "window_seconds": 900, "window_calls": 3, "window_limit": 1000},
            "backup": {
                "status": "ok",
                "last_backup_at": AT,
                "last_backup_key": "backups/x/",
                "last_backup_bytes": 10,
                "last_backup_rows": 2,
                "last_failure_at": None,
                "last_error_code": None,
                "next_backup_at": AT,
            },
        }
        if email_models is not None:
            overview["gemini"]["email_models"] = email_models
        wire = json.loads(ui.answer(ui.service_status(overview)))
        assert wire["name"] == "serviceStatus" and wire["read_time"] == AT
        assert wire["switches"] == {"processing_paused": True}
        assert wire["active_counts"]["failed_summary_count"] == 6
        assert "latest_reminder" not in wire
        # A budget beyond int32 is written as the bound instead of failing the page.
        assert wire["gemini"]["token_budget"] == 2**31 - 1
        assert wire["gemini"]["models"] == ["m1", "m2"]
        if email_models is None:
            assert "email_models" not in wire["gemini"]
        else:
            assert wire["gemini"]["email_models"] == email_models
        decoded, unknown = from_wire(status_pb.ServiceStatus, wire)
        assert not unknown
        assert decoded.gemini.email_models == tuple(email_models or ())
        assert wire["backup"]["state"] == "ok" and "next_alarm_time" in wire

    def test_metric_days(self):
        day = {
            "day": "2026-09-27",
            "recorded": True,
            "mails_received": 64,
            "mails_completed": 61,
            "mails_failed": 1,
            "latency_p50_seconds": 18,
            "latency_p90_seconds": None,
            "gemini_calls": 66,
            "gemini_tokens": {"m1": 402113},
            "todoist_creates": 62,
            "todoist_lookups": 0,
        }
        wire = json.loads(ui.answer(ui.metric_day(day)))
        assert wire["name"] == "metricDays/2026-09-27" and wire["latency_p50_seconds"] == 18
        assert "latency_p90_seconds" not in wire and wire["gemini_tokens"] == {"m1": 402113}

    def test_reports_read_leniently(self):
        report = {
            "summary": "x",
            "task_count": 1,
            "time_window_hours": 24,
            "status": "ok",
            "model": "m",
            "computed_at": AT,
            "window_start": AT,
            "window_end": AT,
            "added_later": 1,
        }
        message = ui.summary_report(report)
        assert message is not None
        assert ui.summary_report({"summary": 1}) is None
        latest = reports_pb.LatestReports(name="latestReports", summary=message)
        assert json.loads(ui.answer(latest))["summary"]["status"] == "ok"

    def test_report_kind(self):
        assert ui.report_kind(reports_pb.ReportKind.SUMMARY) == "summary"
        with refused(Reason.BAD_REQUEST):
            ui.report_kind(reports_pb.ReportKind.UNSPECIFIED)

    def test_every_message_reads_back_strictly(self):
        message = ui.mail_event(detail_row())
        assert from_wire(mail_event_pb.MailEvent, json.loads(ui.answer(message)), strict=True).message == message

    def test_an_answer_is_the_compact_wire_profile(self):
        # The gateway passes these bytes to the browser unread (gateway/test/owner.test.ts checks them against
        # toWire), so the separators and the unescaped UTF-8 are part of the contract.
        text = ui.answer(ui.mail_event(detail_row()))
        assert text == json.dumps(json.loads(text), ensure_ascii=False, separators=(",", ":"))
        assert "季度预缴税" in text and "\\u" not in text


# ---- runtime/owner_ui.py & runtime/api.py (host SQLite + stubbed Pyodide) ------------------


OWNER = "owner@example.com"
GET_EVENT = f'{{"name": "mailEvents/{EVENT}"}}'


class Stubs:
    def __init__(self, owner_ui: object, api: object, js_exception: type[Exception]) -> None:
        self.owner_ui = owner_ui
        self.api = api
        self.JsException = js_exception


@pytest.fixture
def runtime(monkeypatch: pytest.MonkeyPatch):
    import sys

    from tests.unit.host_support import stubbed_pyodide

    with stubbed_pyodide(monkeypatch):
        from todofy.runtime import api, owner_ui

        js_exc = sys.modules["pyodide.ffi"].JsException
        yield Stubs(owner_ui=owner_ui, api=api, js_exception=js_exc)


class Coordinator:
    """TodofyCore's RPC hooks for owner_ui and api tests."""

    def __init__(self, error: Exception | None = None, detail: object = None, sql: object = None) -> None:
        self.error = error
        self.detail = detail
        self.sql = sql
        self.reconcile_refused = None
        self.recompute_result = (200, {})

    async def event_detail(self, _event_id: str) -> object:
        if self.error is not None:
            raise self.error
        return self.detail

    async def apply_reconcile(self, *_args: object) -> object:
        return self.reconcile_refused

    async def recompute_outcome(self, *_args: object) -> tuple[int, object]:
        if self.error is not None:
            raise self.error
        return self.recompute_result

    async def budgets(self) -> dict[str, object]:
        return {
            "next_alarm_at": AT,
            "gemini": {
                "day": "2026-09-28",
                "token_budget": 100_000,
                "reserved_tokens": 0,
                "used_tokens": 500,
                "calls": 2,
                "models": ["gemini-3.8-flash"],
            },
        }


def handle(
    runtime: Stubs,
    coordinator: Coordinator,
    method: str = "GetMailEvent",
    request: str = GET_EVENT,
    env: object = None,
    owner: str = OWNER,
    cursor: str | None = None,
) -> dict[str, object]:
    import asyncio
    import types

    env_obj = env or types.SimpleNamespace()
    return asyncio.run(runtime.owner_ui.handle(env_obj, coordinator, owner, method, request, cursor))


def refusal(reason: str, detail: str | None = None, retry_after: int | None = None) -> dict[str, object]:
    return {"error": reason, "detail": detail, "retry_after": retry_after}


def test_an_expected_refusal_is_its_reason(runtime: Stubs) -> None:
    assert handle(runtime, Coordinator(detail=None)) == refusal("NOT_FOUND")
    assert handle(runtime, Coordinator(), request='{"name": 7}') == refusal("BAD_REQUEST")
    assert handle(runtime, Coordinator(), method="DeleteEverything") == refusal("NOT_FOUND")
    assert handle(runtime, Coordinator(), owner="not-an-email") == refusal("UNAUTHORIZED")


def test_a_failed_d1_call_is_unavailable(runtime: Stubs) -> None:
    assert handle(runtime, Coordinator(error=runtime.JsException("D1_ERROR"))) == refusal("UNAVAILABLE")


def test_a_bug_is_internal_and_logs_only_the_exception_type(runtime: Stubs, capsys: pytest.CaptureFixture[str]) -> None:
    assert handle(runtime, Coordinator(error=KeyError("subject: synthetic secret"))) == refusal("INTERNAL")
    assert capsys.readouterr().out.strip() == '{"owner_ui": "internal", "rpc": "GetMailEvent", "error": "KeyError"}'


def test_an_answer_the_codec_refuses_to_write_is_internal(runtime: Stubs, monkeypatch: pytest.MonkeyPatch) -> None:
    def refuses(_message: object) -> str:
        raise ui.WireJsonError("a value the wire profile refuses")

    monkeypatch.setattr(runtime.owner_ui.ui, "answer", refuses)
    monkeypatch.setattr(runtime.owner_ui.ui, "mail_event", lambda _row, full=True: object())
    assert handle(runtime, Coordinator(detail={"event_id": EVENT})) == refusal("INTERNAL")


def test_an_unknown_rpc_name_is_never_logged(runtime: Stubs, monkeypatch: pytest.MonkeyPatch, capsys) -> None:
    def broken(*_args: object) -> object:
        raise RuntimeError("boom")

    monkeypatch.setattr(runtime.owner_ui, "_answer", broken)
    assert handle(runtime, Coordinator(), method="owner@example.com") == refusal("INTERNAL")
    assert '"rpc": null' in capsys.readouterr().out


def test_write_refusals_and_model_router_error_mapping(runtime: Stubs, monkeypatch: pytest.MonkeyPatch) -> None:
    import types

    from model_router_client import ModelRouterError

    from tests.unit.host_support import ObjectSql
    from todofy.runtime import backup

    recompute_req = json.dumps({"name": "latestReports", "kind": "SUMMARY", "request_id": EVENT})
    env_maint = types.SimpleNamespace(MAINTENANCE_MODE="true")
    assert handle(runtime, Coordinator(), method="RecomputeReport", request=recompute_req, env=env_maint) == refusal(
        "MAINTENANCE"
    )

    store = ObjectSql()
    for stmt in backup.DO_SCHEMA:
        store.exec(stmt)
    monkeypatch.setattr(runtime.owner_ui.backup, "holds_ledger", lambda *_a: True)
    assert handle(
        runtime, Coordinator(sql=store), method="RecomputeReport", request=recompute_req
    ) == refusal("UNAVAILABLE")

    monkeypatch.setattr(runtime.owner_ui.backup, "holds_ledger", lambda *_a: False)
    for code in ("UNAUTHENTICATED", "PERMISSION_DENIED", "FAILED_PRECONDITION"):
        assert handle(
            runtime,
            Coordinator(error=ModelRouterError(code)),
            method="RecomputeReport",
            request=recompute_req,
        ) == refusal("NOT_CONFIGURED")
    assert handle(
        runtime,
        Coordinator(error=ModelRouterError("RESOURCE_EXHAUSTED")),
        method="RecomputeReport",
        request=recompute_req,
    ) == refusal("UNAVAILABLE")


def test_get_latest_reports_degrades_on_unreadable_report(runtime: Stubs, capsys: pytest.CaptureFixture[str]) -> None:
    import types

    from tests.unit.host_support import D1

    db = D1()
    db.insert(
        "daily_reports",
        kind="summary",
        top_n=0,
        day="2026-09-28",
        status="ok",
        payload_json=json.dumps({"summary": 123}),
        task_count=1,
        window_start=0,
        window_end=0,
        computed_at=100,
    )
    env = types.SimpleNamespace(DB=db)
    ans = handle(runtime, Coordinator(), method="GetLatestReports", request='{"name": "latestReports"}', env=env)
    assert json.loads(ans["ok"]) == {"name": "latestReports"}
    assert '{"owner_ui": "report_unreadable"}' in capsys.readouterr().out


def test_runtime_api_and_owner_ui_readers(runtime: Stubs) -> None:
    import asyncio
    import types

    from tests.unit.host_support import D1, ObjectSql
    from todofy.runtime import backup

    db = D1()
    store = ObjectSql()
    for stmt in backup.DO_SCHEMA:
        store.exec(stmt)
    now = 1_759_071_600
    db.insert(
        "mail_events",
        source_id="mail-hero-personal",
        event_id=EVENT,
        payload_hash="0" * 64,
        payload="{}",
        state="pending",
        version=1,
        created_at=now - 7200,
        updated_at=now - 60,
        next_attempt_at=now - 30,
    )
    db.insert(
        "legacy_mail_text",
        event_id=EVENT,
        created_at=now - 3600,
        expires_at=now + 3600,
        text="legacy body",
    )
    db.insert(
        "legacy_mail_text",
        event_id="legacy:expired",
        created_at=now - 7200,
        expires_at=1,
        text="gone",
    )
    env = types.SimpleNamespace(DB=db, MODEL_ROUTER=object(), BUILD_SHA="sha-1")
    coord = Coordinator(detail=detail_row(), sql=store)

    assert runtime.api.setup(env) == {
        "mail_source_id": "mail-hero-personal",
        "configured": {"model_router": True},
    }

    overview = asyncio.run(runtime.api.overview_data(env, coord))
    assert overview["build"] == "sha-1" and overview["counts"]["pending"] == 1

    items, following = asyncio.run(
        runtime.api.event_page(env, attention=False, state="pending", after=None, limit=1)
    )
    assert len(items) == 1 and items[0]["event_id"] == EVENT and following is None

    att_items, _ = asyncio.run(runtime.api.event_page(env, attention=True, state=None, after=None, limit=10))
    assert len(att_items) == 1 and att_items[0]["attention"] is True

    text_data = asyncio.run(runtime.api.legacy_text_data(env, EVENT))
    assert text_data is not None and text_data["text"] == "legacy body"
    assert asyncio.run(runtime.api.legacy_text_data(env, "legacy:expired")) is None
    assert asyncio.run(runtime.api.legacy_text_data(env, "nonexistent")) is None

    # Exercise owner_ui handlers over the same D1 & coordinator
    status_res = handle(runtime, coord, method="GetServiceStatus", request='{"name": "serviceStatus"}', env=env)
    assert json.loads(status_res["ok"])["name"] == "serviceStatus"

    list_res = handle(runtime, coord, method="ListMailEvents", request='{"page_size": 10}', env=env)
    assert len(json.loads(list_res["ok"])["mail_events"]) == 1

    legacy_res = handle(
        runtime, coord, method="GetLegacyText", request=f'{{"name": "legacyTexts/{EVENT}"}}', env=env
    )
    assert json.loads(legacy_res["ok"])["text"] == "legacy body"

    metrics_res = handle(runtime, coord, method="ListMetricDays", request='{"page_size": 5}', env=env)
    assert "metric_days" in json.loads(metrics_res["ok"])

    # Exercise legacy /api/v1 routes in runtime/api.py
    req = runtime.api.OwnerRequest
    assert asyncio.run(runtime.api.handle(req("GET", "/api/v1/overview", "", None, None), env, coord, OWNER)).status == 200
    assert (
        asyncio.run(
            runtime.api.handle(req("GET", "/api/v1/events", "view=recent&limit=10", None, None), env, coord, OWNER)
        ).status
        == 200
    )
    assert (
        asyncio.run(
            runtime.api.handle(req("GET", "/api/v1/events", "view=attention&state=pending", None, None), env, coord, OWNER)
        ).status
        == 400
    )
    assert (
        asyncio.run(
            runtime.api.handle(req("GET", "/api/v1/metrics/daily", "days=7", None, None), env, coord, OWNER)
        ).status
        == 200
    )
    assert (
        asyncio.run(
            runtime.api.handle(req("GET", f"/api/v1/legacy_text/{EVENT}", "", None, None), env, coord, OWNER)
        ).status
        == 200
    )
    assert (
        asyncio.run(
            runtime.api.handle(req("GET", "/api/v1/legacy_text/not-a-key!", "", None, None), env, coord, OWNER)
        ).status
        == 404
    )


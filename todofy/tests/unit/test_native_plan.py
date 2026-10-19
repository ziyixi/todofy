from todofy.core import native_plan


def test_import_uses_exact_saved_binding_and_preserves_effective_stage_area_and_lead():
    mapping = [
        {"role": "committed", "id": "existing", "label": "My commitments"},
        {"role": "office", "id": "work", "label": "Work"},
        {"role": "home", "id": "home", "label": "Home"},
        {"role": "lead_1w", "id": "week", "label": "Start a week ahead"},
    ]
    state = native_plan.state_from_labels(
        ["My commitments", "Work", "Start a week ahead", "waiting", "some-content"], mapping
    )
    assert state == {
        "stage": "committed",
        "area": "work",
        "lead_days": 7,
        **{flag: flag == "waiting" for flag in native_plan.FLAG_NAMES},
    }
    assert set(native_plan.labels_from_state(state)) == {"committed", "office", "lead_1w", "waiting"}
    assert native_plan.state_from_labels(["Work", "Home"], mapping)["area"] == "unassigned"


def test_native_lead_accepts_exact_custom_days_without_legacy_label_roundtrip():
    import pytest

    from todofy.core import plus

    state = native_plan.apply_lead(native_plan.state_from_labels([]), "2026-11-01", 21)
    projected = plus.task_view(
        {
            "id": "synthetic",
            "content": "Synthetic custom start",
            "kind": "task",
            "labels": [],
            "deadline": {"date": "2026-11-01"},
            "_native_planning": True,
            "_native_plan_rev": 1,
            "_native_plan_state": state,
        },
        "2026-10-11",
    )
    assert projected["lead_days"] == 21 and projected["must_start"] and not projected["missing_lead"]
    assert not plus.task_view(
        {"id": "synthetic", "labels": ["lead_3d"], "deadline": {"date": "2026-11-01"}}, "2026-10-29"
    )["must_start"]  # The retired Todoist contract keeps its strict deadline-before semantics.
    for invalid in (-1, 366, True):
        with pytest.raises(ValueError, match="BAD_REQUEST"):
            native_plan.apply_lead(state, "2026-11-01", invalid)


def test_native_blocked_is_not_an_independent_planning_state():
    import pytest

    from todofy.core import plus

    state = native_plan.state_from_labels(["blocked"])
    projected = plus.task_view(
        {
            "id": "synthetic",
            "kind": "task",
            "labels": ["blocked"],
            "_native_planning": True,
            "_native_plan_rev": 1,
            "_native_plan_state": state,
        },
        "2026-10-17",
    )
    assert "blocked" not in projected["planning_flags"]
    with pytest.raises(ValueError, match="BAD_REQUEST"):
        native_plan.apply_plan(state, {"blocked": True})


def test_native_single_action_and_hold_use_the_proto_field_names():
    state = native_plan.apply_plan(native_plan.state_from_labels([]), {"single_action": True, "on_hold": True})
    assert state["task"] is True and state["onhold"] is True


def test_quick_is_standalone_for_existing_state_and_new_writes():
    existing = native_plan.state_from_labels(["quick"])
    assert existing["task"] is False
    assert set(native_plan.labels_from_state(existing)) == {"quick", "task"}
    updated = native_plan.apply_plan(existing, {"quick": True, "single_action": False})
    assert updated["quick"] is True and updated["task"] is True
    # Clearing Quick retains the independent action; it can be cleared explicitly afterwards.
    assert native_plan.apply_plan(existing, {"quick": False})["task"] is True
    assert native_plan.apply_plan(updated, {"quick": False, "single_action": False})["task"] is False


def test_custom_lead_migration_preserves_existing_planning_rows_and_revisions():
    import sqlite3
    from pathlib import Path

    migrations = Path(__file__).parents[2] / "migrations"
    database = sqlite3.connect(":memory:")
    database.executescript((migrations / "0009_native_plan.sql").read_text())
    database.execute(
        "INSERT INTO plan_task_state(task_id,stage,area,lead_days,waiting,active,task,rev,request_id,updated_at)"
        " VALUES (31,'committed','work',14,1,1,1,7,'synthetic-before-migration',12345)"
    )
    before = database.execute("SELECT * FROM plan_task_state").fetchall()
    database.executescript((migrations / "0011_native_lead_days.sql").read_text())
    assert database.execute("SELECT * FROM plan_task_state").fetchall() == before
    database.execute("UPDATE plan_task_state SET lead_days=21 WHERE task_id=31")
    assert database.execute("SELECT lead_days,rev FROM plan_task_state").fetchone() == (21, 7)

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

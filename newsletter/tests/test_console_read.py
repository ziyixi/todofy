"""The console reads one consistent story from Newsletter's own records."""

import datetime
import json
import sqlite3

import pytest
import ziyixi_proto.newsletter.ui.v1.backup_status_pb as backup_pb
import ziyixi_proto.newsletter.ui.v1.edition_pb as edition_pb
import ziyixi_proto.newsletter.ui.v1.model_call_pb as model_call_pb
import ziyixi_proto.newsletter.ui.v1.newsletter_ui_service_pb as service_pb
import ziyixi_proto.newsletter.ui.v1.overview_pb as overview_pb
import ziyixi_proto.newsletter.ui.v1.run_pb as run_pb
import ziyixi_proto.newsletter.ui.v1.source_catalog_pb as catalog_pb

import newsletter.console_read as console_read
import newsletter.console_views as views
import newsletter.monitoring_status as monitoring_status
import newsletter.notion_journal as notion_journal
import newsletter.settings as newsletter_settings
import newsletter.store as newsletter_store
import tests.support.console_world as console_world

KIND = run_pb.RunFailure_Kind
REPLICA = backup_pb.Replica_State


@pytest.fixture
def world(tmp_path):
    built = console_world.build(tmp_path)
    yield built
    built.close()


def _run(world, run_id):
    return world.reader.get_run(service_pb.GetRunRequest(name="runs/" + run_id))


def test_the_strip_shows_each_days_scheduled_run(world):
    overview = world.reader.overview(healthy=True)
    days = {day.issue_date: day for day in overview.days}
    assert len(overview.days) == 14
    assert overview.days[0].issue_date == "2026-10-29"
    assert days["2026-10-29"].run == "runs/" + console_world.RUN_29
    assert days["2026-10-28"].run_state == run_pb.Run_State.BLOCKED
    assert days["2026-10-28"].stop_reason == "no_publishable_content"
    assert days["2026-10-28"].failed_node == "selection"
    assert days["2026-10-28"].edition == ""
    assert (
        days["2026-10-27"].delivery_state
        == edition_pb.Delivery_State.PROVIDER_ACCEPTED
    )
    assert days["2026-10-20"] == overview_pb.DayStatus(issue_date="2026-10-20")
    # A later manual run does not take over the first page.
    assert overview.latest_run.name == "runs/" + console_world.RUN_29
    assert overview.latest_edition.kind == edition_pb.Edition_Kind.DAILY
    assert (
        overview.latest_edition.name == "editions/" + console_world.EDITION_29
    )


def test_10_28_reads_as_a_selection_budget_overrun(world):
    run = _run(world, console_world.RUN_28)
    assert run.state == run_pb.Run_State.BLOCKED
    assert run.trigger == run_pb.Run_Trigger.SCHEDULED
    assert run.stop_reason == "no_publishable_content"
    assert run.failure == run_pb.RunFailure(
        node_id="selection",
        error_code="timeout",
        kind=KIND.NODE_BUDGET,
        elapsed_seconds=161.25,
        # The budget the run froze, never today's configuration.
        budget_seconds=150,
        model_call=f"runs/{console_world.RUN_28}/modelCalls/"
        + console_world.uid(7803),
    )
    nodes = {node.node_id: node for node in run.nodes}
    assert nodes["selection"].state == run_pb.RunNode_State.FAILED
    assert nodes["selection"].budget_seconds == 150
    assert nodes["story_plan"].state == run_pb.RunNode_State.PENDING
    assert nodes["discovery"].item_count == 2
    assert run.feeds == run_pb.FeedSummary(
        source_count=3,
        ok_count=2,
        failed_count=1,
        failures=(
            run_pb.SourceOutcome(
                source_id="synthetic-arxiv",
                issue_date="2026-10-28",
                code="timeout",
            ),
        ),
    )
    calls = world.reader.list_model_calls(
        service_pb.ListModelCallsRequest(parent=run.name)
    ).model_calls
    cut = calls[-1]
    assert cut.name == run.failure.model_call
    assert cut.state == model_call_pb.ModelCall_State.FAILED
    assert (cut.turn_count, cut.completed_turn_count, cut.partial) == (
        1,
        0,
        True,
    )
    # Recorded before purposes, times and failures were: absent, not zero.
    assert cut.failure_code == cut.purpose == ""
    assert cut.start_time is None and cut.router_requests == ()
    today = _run(world, console_world.RUN_29)
    budgets = {node.node_id: node.budget_seconds for node in today.nodes}
    assert budgets["selection"] == 420


def test_a_delivered_run_and_its_calls(world):
    run = _run(world, console_world.RUN_27)
    assert run.state == run_pb.Run_State.READY
    assert run.edition == "editions/" + console_world.EDITION_27
    assert run.delivery_state == edition_pb.Delivery_State.PROVIDER_ACCEPTED
    assert run.failure is None
    assert run.feeds is not None and run.feeds.seed_count == 7
    assert [s.result for s in run.stories] == ["approved", ""]
    assert run.usage == views.usage_totals(
        [dict(c) for c in _records(world, console_world.RUN_27)]
    )
    calls = world.reader.list_model_calls(
        service_pb.ListModelCallsRequest(parent=run.name)
    ).model_calls
    assert [c.purpose for c in calls] == [
        "discovery",
        "discovery",
        "selection",
        "writer",
        "reviewer",
    ]
    writer = calls[3]
    assert writer.reported_models == (console_world.REPORTED,)
    assert writer.router_requests == ("requests/" + console_world.uid(9714),)
    assert writer.start_time == "2026-10-27T14:05:31Z"
    kinds = [d.kind for d in run.dependencies]
    assert kinds == sorted(kinds)
    assert len(kinds) == 5


def _records(world, run_id):
    rows = world.store.db.execute(
        "SELECT body FROM model_usage WHERE scope_id=? ORDER BY rowid",
        (run_id,),
    ).fetchall()
    return [json.loads(row[0]) for row in rows]


def test_every_backup_state_from_the_journal(world, tmp_path):
    editions = world.reader.list_editions(service_pb.ListEditionsRequest())
    states = {e.name.split("/")[1]: e.backup.state for e in editions.editions}
    assert states == {
        console_world.EDITION_29M: REPLICA.UNKNOWN,
        console_world.EDITION_29: REPLICA.SYNCING,
        console_world.CORRECTION_27: REPLICA.OUTDATED,
        console_world.EDITION_27: REPLICA.SYNCED,
        console_world.EDITION_26: REPLICA.CONFLICT,
        console_world.EDITION_25: REPLICA.RETRYING,
        console_world.EDITION_24: REPLICA.NOT_STARTED,
    }
    status = world.reader.get_backup_status(
        service_pb.GetBackupStatusRequest(name="backupStatus")
    )
    assert status.enabled and not status.includes_personal
    assert [t.target for t in status.targets] == [
        backup_pb.ReplicaCounts_Target.EDITIONS,
        backup_pb.ReplicaCounts_Target.MATERIALS,
    ]
    assert len(status.exceptions) == 5
    times = [e.issue_date for e in status.exceptions if e.issue_date]
    assert times == sorted(times)
    assert status.import_error_counts == {"notion_research_import_failed": 1}
    off = console_world.build(tmp_path / "off", notion=False)
    try:
        listed = off.reader.list_editions(service_pb.ListEditionsRequest())
        assert {e.backup.state for e in listed.editions} == {REPLICA.DISABLED}
        assert off.reader.overview(healthy=True).backup is None
    finally:
        off.close()


def test_edition_kinds_follow_the_backups_type_rules(world):
    journal = notion_journal.NotionJournal(
        world.store,
        {
            "materials": console_world.uid(9001),
            "editions": console_world.uid(9002),
            "include_personal": False,
        },
    )
    editions = world.reader.list_editions(
        service_pb.ListEditionsRequest()
    ).editions
    for edition in editions:
        identifier = edition.name.split("/")[1]
        fixture = world.store.get(identifier)["is_fixture"]
        run_id = edition.run.removeprefix("runs/")
        expected = edition_pb.Edition_Kind.DAILY
        if fixture:
            expected = edition_pb.Edition_Kind.TEST
        elif journal.is_verification(identifier):
            expected = edition_pb.Edition_Kind.CORRECTION
        elif not journal.is_daily_run(run_id, edition.issue_date):
            expected = edition_pb.Edition_Kind.TEST
        assert edition.kind == expected, identifier
    assert {e.kind for e in editions} == {
        edition_pb.Edition_Kind.DAILY,
        edition_pb.Edition_Kind.CORRECTION,
        edition_pb.Edition_Kind.TEST,
    }


def test_the_full_edition_numbers_references_as_the_email_does(world):
    edition = world.reader.get_edition(
        service_pb.GetEditionRequest(
            name="editions/" + console_world.EDITION_27
        )
    )
    first = edition.sections[0].paragraphs[0]
    assert first.reference_numbers == (1, 2)
    # Untrusted text is kept as text, never interpreted.
    assert "<img src=x onerror=alert(1)>" in first.text
    assert [r.number for r in edition.references] == [1, 2, 3, 4]
    assert all(r.url.startswith("https://") for r in edition.references)
    assert edition.chart is not None
    assert edition.chart.points[1].missing_reason == "未公布"
    assert edition.recommended_reading.reference_number == 3
    assert edition.personal_digest.title == "今天与你有关"
    assert not edition.personal_digest.backup_included
    assert edition.delivery.verification_count == 1
    assert edition.config_revision == console_world.OLD_REVISION
    correction = world.reader.get_edition(
        service_pb.GetEditionRequest(
            name="editions/" + console_world.CORRECTION_27
        )
    )
    assert correction.corrected_edition == edition.name
    rendering = world.reader.get_edition_rendering(
        service_pb.GetEditionRenderingRequest(name=edition.name + "/rendering")
    )
    assert "cid:" not in rendering.html
    assert "data:image/png;base64," in rendering.html
    assert rendering.render_hash == edition.render_hash


def test_unknown_counts_and_latest_delivery_agree_with_monitoring(
    world, tmp_path
):
    overview = world.reader.overview(healthy=True)
    # The monitoring snapshot records what it saw; take it on a copy.
    copy = tmp_path / "copy.sqlite3"
    target = sqlite3.connect(copy)
    world.store.db.backup(target)
    target.close()
    store = newsletter_store.Store(copy, "live")
    try:
        observed = monitoring_status.snapshot(store)
        drain = store.deployment.status()
    finally:
        store.close()
    assert (
        overview.service.unknown_category_counts
        == (observed["unknown_by_kind"])
    )
    assert overview.service.unknown_count == sum(drain["unknown"].values())
    latest = observed["latest_delivery"]
    assert latest is not None
    assert overview.latest_delivery.delivery.update_time == views.timestamp(
        latest["time"]
    )
    assert (
        overview.latest_delivery.delivery.state
        == views.DELIVERY_STATES[latest["state"]]
    )
    assert overview.service.drain_state == (
        overview_pb.ServiceState_DrainState.ACTIVE
    )


def test_a_frozen_engine_still_answers(world):
    world.store.deployment.begin("release-1")
    world.store.deployment.freeze("release-1")
    overview = world.reader.overview(healthy=False)
    assert overview.service.drain_state == (
        overview_pb.ServiceState_DrainState.FROZEN
    )
    assert not overview.service.worker_healthy
    world.store.deployment.resume("release-1")
    assert world.reader.overview(healthy=True).service.drain_state == (
        overview_pb.ServiceState_DrainState.ACTIVE
    )


def test_the_catalog_reads_the_active_bundle_and_recent_runs(world):
    catalog = world.reader.get_source_catalog(
        service_pb.GetSourceCatalogRequest(name="sourceCatalog")
    )
    assert catalog.config.state == catalog_pb.ConfigState_State.CURRENT
    assert catalog.config.revision_url.endswith(console_world.NEW_REVISION)
    assert [d.id for d in catalog.directions] == list(console_world.DIRECTIONS)
    assert catalog.directions[0].title == "AI / ML 候选发现"
    assert catalog.directions[0].latest_candidate_count == 3
    assert [s.id for s in catalog.sources][-1] == "synthetic-paused-feed"
    assert not catalog.sources[-1].enabled
    arxiv = catalog.sources[1]
    assert [o.issue_date for o in arxiv.recent] == [
        "2026-10-29",
        "2026-10-28",
        "2026-10-27",
        "2026-10-25",
        "2026-10-24",
    ]
    assert arxiv.recent[1].code == "timeout"
    assert arxiv.recent[1].entry_count is None
    selection = next(b for b in catalog.budgets if b.node_id == "selection")
    assert (selection.budget_seconds, selection.overrun_count) == (420, 1)
    assert selection.recent_max_seconds == 161.25
    assert [r.revision for r in catalog.config_history] == [
        console_world.NEW_REVISION,
        console_world.OLD_REVISION,
    ]
    assert catalog.editorial_limits["max_deep"] == 1
    assert catalog.history_candidate_count == 1


@pytest.mark.parametrize(
    "request_",
    [
        service_pb.ListRunsRequest(page_size=-1),
        service_pb.ListRunsRequest(page_token="next"),
        service_pb.ListRunsRequest(month="2026-13"),
        service_pb.ListRunsRequest(month="2026-1"),
        service_pb.ListEditionsRequest(month="october"),
        service_pb.SummarizeModelUsageRequest(day_count=5),
        service_pb.ListModelCallsRequest(
            parent="runs/" + console_world.RUN_27, page_token="x"
        ),
    ],
)
def test_requests_outside_the_bounds_are_refused(world, request_):
    readers = {
        service_pb.ListRunsRequest: world.reader.list_runs,
        service_pb.ListEditionsRequest: world.reader.list_editions,
        service_pb.SummarizeModelUsageRequest: (
            world.reader.summarize_model_usage
        ),
        service_pb.ListModelCallsRequest: world.reader.list_model_calls,
    }
    with pytest.raises(console_read.ConsoleError, match="BAD_REQUEST"):
        readers[type(request_)](request_)


def test_months_page_and_name_their_neighbours(world):
    october = world.reader.list_runs(service_pb.ListRunsRequest())
    assert october.month == "2026-10"
    assert (october.earlier_month, october.later_month) == ("", "")
    assert len(october.runs) == 7
    assert october.runs[0].issue_date == "2026-10-29"
    two = world.reader.list_runs(service_pb.ListRunsRequest(page_size=2))
    assert two.runs == october.runs[:2]
    empty = world.reader.list_runs(service_pb.ListRunsRequest(month="2026-09"))
    assert empty.runs == ()
    assert (empty.month, empty.later_month) == ("2026-09", "2026-10")
    calls = world.reader.list_model_calls(
        service_pb.ListModelCallsRequest(
            parent="runs/" + console_world.RUN_27, page_size=1
        )
    )
    assert len(calls.model_calls) == 1


@pytest.mark.parametrize(
    "name", ["runs/" + console_world.uid(1), "runs/../x", "runs/a b"]
)
def test_unknown_names_are_not_found(world, name):
    with pytest.raises(console_read.ConsoleError, match="NOT_FOUND"):
        world.reader.get_run(service_pb.GetRunRequest(name=name))
    with pytest.raises(console_read.ConsoleError, match="NOT_FOUND"):
        world.reader.get_edition(
            service_pb.GetEditionRequest(
                name=name.replace("runs/", "editions/")
            )
        )


def test_week_usage_is_the_seven_day_summary(world):
    overview = world.reader.overview(healthy=True)
    week = world.reader.summarize_model_usage(
        service_pb.SummarizeModelUsageRequest(day_count=7)
    )
    assert overview.week_usage == week.totals
    month = world.reader.summarize_model_usage(
        service_pb.SummarizeModelUsageRequest(day_count=30)
    )
    assert month.first_issue_date == "2026-09-30"
    assert month.last_issue_date == "2026-10-29"
    # Calls recorded before purposes and times were kept their own rows.
    legacy = [
        n for n in month.nodes if n.node_id == "selection" and not n.purpose
    ]
    assert legacy[0].timed_call_count == 0
    assert legacy[0].median_seconds is None


def test_a_missing_database_is_unavailable(tmp_path):
    settings = newsletter_settings.Settings(data_dir=tmp_path)
    reader = console_read.ConsoleReader(settings)
    with pytest.raises(console_read.ConsoleError, match="UNAVAILABLE"):
        reader.overview(healthy=True)


def test_a_database_without_optional_tables_reads_empty(tmp_path):
    data = tmp_path / "data"
    data.mkdir()
    store = newsletter_store.Store(data / "newsletter.sqlite3", "mock")
    try:
        settings = newsletter_settings.Settings(data_dir=data)
        reader = console_read.ConsoleReader(
            settings,
            clock=lambda: datetime.datetime(2026, 10, 29, tzinfo=datetime.UTC),
        )
        overview = reader.overview(healthy=True)
        assert overview.latest_run is None and overview.latest_edition is None
        assert overview.backup is None
        assert reader.get_backup_status(
            service_pb.GetBackupStatusRequest(name="backupStatus")
        ).targets[0] == backup_pb.ReplicaCounts(
            target=backup_pb.ReplicaCounts_Target.EDITIONS
        )
        assert reader.list_runs(service_pb.ListRunsRequest()).runs == ()
    finally:
        store.close()

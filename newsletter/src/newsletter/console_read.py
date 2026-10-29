"""Read Newsletter's records for the owner console, never writing anything.

Each answer is one short snapshot of the authoritative SQLite database on a
connection of its own: opened read-only (``mode=ro``) with ``query_only``, an
untrusted schema and an authorizer that refuses every action but reading,
inside one read transaction, then closed. It never takes the service's
``store.lock``, writes nothing (not even ``monitoring_unknowns``, which the
monitoring snapshot inserts) and registers no deployment activity, so reads
stay available while a release has frozen the engine's work. Queries are
bounded and keyed: a month of runs or editions, one run's rows, and JSON
scalars extracted in SQL rather than whole frozen inputs.

The Notion backup's state is read from the replication journal; nothing here
calls Notion. A missing database is UNAVAILABLE; a table a configuration never
created (Notion, the workflow tables of a mock service) reads as empty.
"""

from collections.abc import Callable, Iterator, Mapping, Sequence
import contextlib
import dataclasses
import datetime
import json
import re
import sqlite3
import statistics
from typing import Any
import zoneinfo

import ziyixi_proto.newsletter.ui.v1.backup_status_pb as backup_pb
import ziyixi_proto.newsletter.ui.v1.edition_pb as edition_pb
import ziyixi_proto.newsletter.ui.v1.newsletter_ui_service_pb as service_pb
import ziyixi_proto.newsletter.ui.v1.overview_pb as overview_pb
import ziyixi_proto.newsletter.ui.v1.run_pb as run_pb
import ziyixi_proto.newsletter.ui.v1.source_catalog_pb as catalog_pb

import newsletter.config_sync as config_sync
import newsletter.console_views as views
import newsletter.content_config as content_config
import newsletter.monitoring_api as monitoring_api
import newsletter.monitoring_status as monitoring_status
import newsletter.provenance as provenance
import newsletter.rendering as rendering
import newsletter.settings as newsletter_settings
import newsletter.workflow.researcher as researcher

MONTH = re.compile(r"[0-9]{4}-(?:0[1-9]|1[0-2])\Z")
_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}\Z")
MAX_RUNS = 64
MAX_CALLS = 200
DAY_COUNTS = frozenset({7, 30, 90})
STRIP_DAYS = 14
# Scheduled runs a source's and a node's recent outcomes cover.
RECENT_RUNS = 7
# Runs scanned for the configuration history (more than a quarter).
HISTORY_RUNS = 120
MAX_REVISIONS = 10
MAX_EXCEPTIONS = 50
# The deployment gate's queued and in-flight predicates (drain.py
# DeploymentDrain._status), whose sums monitoring reports to Fleet as 排队 and
# 进行中; test_console_read.py holds them to drain.status().
GATE_QUEUED = (
    ("editions", "state='queued'"),
    (
        "collection_runs",
        "state IN ('queued','collecting','projecting','editing')",
    ),
)
GATE_INFLIGHT = (
    ("deployment_activities", "state IN ('active','uncertain')"),
    ("editions", "state='running'"),
    ("packets", "projection='submitting'"),
    ("workflow_attempts", "state='running'"),
    ("notion_entities", "create_state='creating'"),
    ("notion_versions", "state='appending'"),
    ("editions", "json_extract(body,'$.delivery_state')='submitting'"),
)
_READS = frozenset(
    {
        sqlite3.SQLITE_READ,
        sqlite3.SQLITE_SELECT,
        sqlite3.SQLITE_FUNCTION,
        sqlite3.SQLITE_TRANSACTION,
        sqlite3.SQLITE_RECURSIVE,
    }
)
_EDITIONS = backup_pb.ReplicaCounts_Target.EDITIONS
_MATERIALS = backup_pb.ReplicaCounts_Target.MATERIALS
_ATTENTION = frozenset(
    {
        backup_pb.Replica_State.UNKNOWN,
        backup_pb.Replica_State.CONFLICT,
        backup_pb.Replica_State.RETRYING,
        backup_pb.Replica_State.OUTDATED,
    }
)
_RUN_COLUMNS = (
    "SELECT c.id, c.request_key, c.state, "
    "json_extract(c.body,'$.issue_date') AS issue_date, "
    "json_extract(c.body,'$.edition_id') AS edition_id, "
    "json_extract(c.body,'$.error_code') AS error_code, "
    "json_extract(c.body,'$.created_at') AS created_at, "
    "json_extract(c.body,'$.updated_at') AS updated_at, "
    "json_extract(s.body,'$.definition.nodes') AS definition, "
    "json_extract(s.body,'$.inputs.started_at') AS started_at, "
    "json_extract(s.body,'$.inputs.timeout_seconds') AS deadline, "
    "json_extract(s.body,'$.inputs.model') AS model, "
    "json_extract(s.body,'$.inputs.content_config.revision') AS revision, "
    "json_extract(s.body,'$.inputs.content_config.digest') AS digest "
    "FROM collection_runs c "
    "LEFT JOIN collection_workflow_snapshots s ON s.run_id=c.id "
)
_RUN_ORDER = " ORDER BY issue_date DESC, c.rowid DESC"
_SCHEDULED_FIRST = (
    " ORDER BY c.request_key='daily-'||issue_date DESC,"
    " issue_date DESC, c.rowid DESC"
)
# A direction the latest run did not discover.
_UNSEEN = (run_pb.RunNode_State.UNSPECIFIED, 0)
_EDITION_COLUMNS = (
    "SELECT e.id, e.request_key, e.state, w.run_id, "
    "json_extract(e.body,'$.issue_date') AS issue_date, "
    "json_extract(e.body,'$.created_at') AS created_at, "
    "json_extract(e.body,'$.updated_at') AS updated_at, "
    "json_extract(e.body,'$.is_fixture') AS is_fixture, "
    "json_extract(e.body,'$.delivery_state') AS delivery_state, "
    "json_extract(e.body,'$.error_code') AS error_code, "
    "json_extract(e.body,'$.draft.subject') AS subject, "
    "json_extract(e.body,'$.draft.title') AS title, "
    "json_extract(e.body,'$.draft.introduction') AS introduction, "
    "(SELECT json_group_array(json_extract(value,'$.heading')) "
    "FROM json_each(e.body,'$.draft.sections')) AS topics "
    "FROM editions e LEFT JOIN workflow_editions w ON w.edition_id=e.id "
)
_EDITION_ORDER = " ORDER BY issue_date DESC, e.rowid DESC"
# Sorts a call recorded without any time first.
_NEVER = datetime.datetime.min.replace(tzinfo=datetime.UTC)


class ConsoleError(Exception):
    """An expected refusal: a common.errors.v1 reason, never a detail."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def _authorize(action: int, *_: object) -> int:
    # Belt and braces with mode=ro and query_only: anything but reading is
    # refused before SQLite plans it.
    return sqlite3.SQLITE_OK if action in _READS else sqlite3.SQLITE_DENY


def _json(value: object) -> Any:
    if not isinstance(value, str):
        return None
    try:
        return json.loads(value)
    except ValueError:
        return None


class Snapshot:
    """One read transaction over the database, with its table names."""

    def __init__(self, db: sqlite3.Connection) -> None:
        self.db = db
        self.tables = {
            str(row[0])
            for row in db.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            )
        }

    def has(self, *tables: str) -> bool:
        """Whether every table exists (a configuration may never create one)."""
        return all(table in self.tables for table in tables)

    def rows(self, sql: str, args: Sequence[object] = ()) -> list[sqlite3.Row]:
        """Every row of a fixed, parameterized query."""
        return list(self.db.execute(sql, tuple(args)).fetchall())

    def one(self, sql: str, args: Sequence[object] = ()) -> sqlite3.Row | None:
        """The first row of a fixed, parameterized query, if any."""
        row: sqlite3.Row | None = self.db.execute(sql, tuple(args)).fetchone()
        return row

    def count(self, table: str, predicate: str) -> int:
        """Rows matching a fixed predicate; 0 for a table never created."""
        if not self.has(table):
            return 0
        found = self.one(f"SELECT COUNT(*) FROM {table} WHERE {predicate}")
        return int(found[0]) if found else 0


@dataclasses.dataclass
class _Run:
    """One run's rows, read once and shared by every view of it."""

    row: sqlite3.Row
    definition: list[dict[str, Any]]
    nodes: dict[str, Any]
    attempts: list[dict[str, Any]]
    calls: list[dict[str, Any]]
    workflow_started: str | None
    feeds_diagnostics: Any
    feeds_sources: Any
    candidate_count: int
    selected_count: int
    parent_run: str
    replay_run: str
    edition: dict[str, Any] | None

    @property
    def id(self) -> str:
        """The run's ID."""
        return str(self.row["id"])

    @property
    def issue_date(self) -> str:
        """The run's issue date."""
        return str(self.row["issue_date"] or "")


def _utc_now() -> datetime.datetime:
    return datetime.datetime.now(datetime.UTC)


class ConsoleReader:
    """Answer newsletter.ui.v1 from the database and the active config."""

    def __init__(
        self,
        settings: newsletter_settings.Settings,
        *,
        clock: Callable[[], datetime.datetime] = _utc_now,
    ) -> None:
        self.settings = settings
        self.path = settings.data_dir / "newsletter.sqlite3"
        self.clock = clock
        self.zone = zoneinfo.ZoneInfo(settings.time_zone)

    @property
    def notion_enabled(self) -> bool:
        """Whether Newsletter keeps a Notion backup at all."""
        return self.settings.notion_backend == "notion"

    @contextlib.contextmanager
    def snapshot(self) -> Iterator[Snapshot]:
        """One read-only connection and read transaction, then closed."""
        if not self.path.is_file():
            raise ConsoleError("UNAVAILABLE")
        db = sqlite3.connect(
            self.path.resolve().as_uri() + "?mode=ro",
            uri=True,
            isolation_level=None,
        )
        try:
            db.row_factory = sqlite3.Row
            db.execute("PRAGMA query_only=ON")
            db.execute("PRAGMA trusted_schema=OFF")
            db.execute("PRAGMA busy_timeout=2000")
            db.set_authorizer(_authorize)
            db.execute("BEGIN")
            try:
                yield Snapshot(db)
            finally:
                db.execute("COMMIT")
        finally:
            db.close()

    # Runs.

    def _run_rows(
        self,
        snap: Snapshot,
        where: str,
        args: Sequence[object],
        *,
        limit: int,
        order: str = _RUN_ORDER,
    ) -> list[sqlite3.Row]:
        if not snap.has("collection_runs", "collection_workflow_snapshots"):
            return []
        return snap.rows(
            _RUN_COLUMNS + where + order + " LIMIT ?", [*args, limit]
        )

    def _load_run(self, snap: Snapshot, row: sqlite3.Row) -> _Run:
        run_id = str(row["id"])
        definition = _json(row["definition"])
        definition = (
            [node for node in definition if isinstance(node, dict)]
            if isinstance(definition, list)
            else []
        )
        nodes: dict[str, Any] = {}
        started = None
        attempts: list[dict[str, Any]] = []
        if snap.has("workflow_runs"):
            found = snap.one(
                "SELECT json_extract(body,'$.created_at') FROM workflow_runs "
                "WHERE id=?",
                [run_id],
            )
            started = found[0] if found is not None else None
            # Each node's outcome only: its items carry frozen task values
            # that only GetRun's node list reads (_run_nodes).
            nodes = {
                str(row[0]): {
                    "state": row[1],
                    "error_code": row[2],
                    "degraded": bool(row[3]),
                }
                for row in snap.rows(
                    "SELECT n.key, json_extract(n.value,'$.state'), "
                    "json_extract(n.value,'$.error_code'), "
                    "json_extract(n.value,'$.degraded') "
                    "FROM workflow_runs r, json_each(r.body,'$.nodes') n "
                    "WHERE r.id=?",
                    [run_id],
                )
            }
        if snap.has("workflow_attempts"):
            attempts = [
                dict(item)
                for item in snap.rows(
                    "SELECT node_id,item_id,state,error_code,started_at,"
                    "finished_at FROM workflow_attempts WHERE run_id=? "
                    "ORDER BY rowid",
                    [run_id],
                )
            ]
        calls = self._calls(snap, run_id)
        diagnostics = sources = None
        candidates = selected = 0
        if snap.has("workflow_artifacts"):
            feeds = views.node_of(definition, "api_feed")
            found = self._artifact(
                snap,
                run_id,
                feeds,
                "json_extract(body,'$.diagnostics') AS a, "
                "json_extract(body,'$.sources') AS b",
            )
            if found is not None:
                diagnostics, sources = _json(found["a"]), _json(found["b"])
            pool = self._artifact(
                snap,
                run_id,
                views.node_of(definition, "deduplicate"),
                "json_array_length(body,'$.candidates') AS a",
            )
            candidates = views.int32(pool["a"]) if pool else 0
            chosen = self._artifact(
                snap,
                run_id,
                views.node_of(definition, "selection"),
                "json_array_length(body,'$.research_tasks') AS a",
            )
            selected = views.int32(chosen["a"]) if chosen else 0
        parent = replay = ""
        if snap.has("workflow_story_replays"):
            link = snap.one(
                "SELECT parent_run_id FROM workflow_story_replays "
                "WHERE child_run_id=?",
                [run_id],
            )
            parent = str(link[0]) if link else ""
            link = snap.one(
                "SELECT child_run_id FROM workflow_story_replays "
                "WHERE parent_run_id=?",
                [run_id],
            )
            replay = str(link[0]) if link else ""
        edition = None
        if row["edition_id"]:
            edition = self._edition_scalars(snap, str(row["edition_id"]))
        return _Run(
            row=row,
            definition=definition,
            nodes=nodes,
            attempts=attempts,
            calls=calls,
            workflow_started=started,
            feeds_diagnostics=diagnostics,
            feeds_sources=sources,
            candidate_count=candidates,
            selected_count=selected,
            parent_run=parent,
            replay_run=replay,
            edition=edition,
        )

    @staticmethod
    def _artifact(
        snap: Snapshot, run_id: str, node_id: str, columns: str
    ) -> sqlite3.Row | None:
        if not node_id:
            return None
        return snap.one(
            f"SELECT {columns} FROM workflow_artifacts "
            "WHERE run_id=? AND node_id=? AND item_id=''",
            [run_id, node_id],
        )

    @staticmethod
    def _calls(snap: Snapshot, run_id: str) -> list[dict[str, Any]]:
        if not snap.has("model_usage"):
            return []
        calls = []
        for row in snap.rows(
            "SELECT body,updated_at FROM model_usage WHERE scope_id=? "
            "ORDER BY rowid",
            [run_id],
        ):
            record = _json(row["body"])
            if isinstance(record, dict) and isinstance(record.get("id"), str):
                record["update_time"] = row["updated_at"]
                calls.append(record)
        return calls

    @staticmethod
    def _edition_scalars(snap: Snapshot, edition_id: str) -> dict[str, Any]:
        found = snap.one(
            "SELECT json_extract(body,'$.delivery_state') AS delivery_state,"
            " json_extract(body,'$.updated_at') AS updated_at,"
            " json_extract(body,'$.error_code') AS error_code,"
            " json_extract(body,'$.personal_digest') AS personal_digest"
            " FROM editions WHERE id=?",
            [edition_id],
        )
        if found is None:
            return {}
        value = dict(found)
        value["personal_digest"] = _json(value["personal_digest"])
        return value

    def _run_message(
        self, snap: Snapshot, run: _Run, *, detail: bool = False
    ) -> run_pb.Run:
        row = run.row
        state = str(row["state"])
        ended = state in {"ready", "blocked", "failed"}
        stop_reason = (
            str(row["error_code"] or "")
            if state in {"blocked", "failed"}
            else ""
        )
        deadline = views.int32(row["deadline"])
        outcomes = views.feed_outcomes(
            run.issue_date, run.feeds_diagnostics, run.feeds_sources
        )
        has_feeds = run.feeds_diagnostics is not None
        edition = run.edition or {}
        message = run_pb.Run(
            name="runs/" + run.id,
            issue_date=run.issue_date,
            trigger=views.run_trigger(
                request_key=str(row["request_key"]),
                issue_date=run.issue_date,
                parent_run=run.parent_run,
            ),
            state=views.run_state(state),
            stop_reason=stop_reason,
            create_time=views.timestamp(row["created_at"]),
            start_time=views.timestamp(run.workflow_started),
            end_time=views.timestamp(row["updated_at"]) if ended else None,
            deadline_seconds=deadline,
            requested_model=views.text(row["model"]),
            config_revision=views.text(row["revision"]),
            config_digest=views.text(row["digest"]),
            edition="editions/" + str(row["edition_id"])
            if row["edition_id"]
            else "",
            parent_run="runs/" + run.parent_run if run.parent_run else "",
            replay_run="runs/" + run.replay_run if run.replay_run else "",
            delivery_state=views.DELIVERY_STATES.get(
                str(edition.get("delivery_state")),
                edition_pb.Delivery_State.UNSPECIFIED,
            ),
            failure=views.run_failure(
                run_id=run.id,
                definition=run.definition,
                nodes=run.nodes,
                attempts=run.attempts,
                calls=run.calls,
                stop_reason=stop_reason,
                started_at=row["started_at"],
                deadline_seconds=deadline,
            ),
            usage=views.usage_totals(run.calls),
            feeds=views.feed_summary(outcomes) if has_feeds else None,
            candidate_count=run.candidate_count,
            selected_count=run.selected_count,
        )
        if not detail:
            return message
        return dataclasses.replace(
            message,
            nodes=tuple(self._run_nodes(snap, run)),
            stories=tuple(self._stories(snap, run.id)),
            dependencies=tuple(
                views.dependencies(
                    run=self._dependency_run(run),
                    feeds=outcomes,
                    feed_diagnostics=run.feeds_diagnostics,
                    calls=[(run.issue_date, call) for call in run.calls],
                    edition=run.edition,
                    todofy_enabled=self.settings.todofy_backend != "disabled",
                    backup=self._edition_backup(snap, row["edition_id"]),
                    backup_error="",
                )
            ),
        )

    @staticmethod
    def _dependency_run(run: _Run) -> dict[str, Any]:
        feeds = views.node_of(run.definition, "api_feed")
        finished = [
            a["finished_at"]
            for a in run.attempts
            if a["node_id"] == feeds and a.get("finished_at")
        ]
        return {
            "state": run.row["state"],
            "feeds_finished_at": max(finished) if finished else None,
        }

    def _run_nodes(self, snap: Snapshot, run: _Run) -> list[run_pb.RunNode]:
        # Items carry their frozen values (labels); only one run's body is
        # read, for GetRun alone.
        nodes = run.nodes
        if snap.has("workflow_runs"):
            found = snap.one(
                "SELECT json_extract(body,'$.nodes') FROM workflow_runs "
                "WHERE id=?",
                [run.id],
            )
            value = _json(found[0]) if found else None
            nodes = value if isinstance(value, dict) else nodes
        return views.run_nodes(run.definition, nodes, run.attempts)

    def _stories(
        self, snap: Snapshot, run_id: str
    ) -> list[edition_pb.StoryOutcome]:
        coverage = plan = None
        results: dict[str, str] = {}
        if snap.has("publication_snapshots"):
            found = snap.one(
                "SELECT json_extract(body,'$.coverage.stories') "
                "FROM publication_snapshots WHERE run_id=?",
                [run_id],
            )
            coverage = _json(found[0]) if found else None
        if snap.has("publication_plans"):
            found = snap.one(
                "SELECT tasks FROM publication_plans WHERE run_id=?", [run_id]
            )
            plan = _json(found[0]) if found else None
        if snap.has("publication_units"):
            for row in snap.rows(
                "SELECT story_id,json_extract(body,'$.reason') "
                "FROM publication_units WHERE run_id=? ORDER BY rowid",
                [run_id],
            ):
                results[str(row[0])] = views.text(row[1])
        return views.story_outcomes(coverage, plan, results)

    def _find_run(self, snap: Snapshot, name: str, prefix: str) -> _Run:
        run_id = name.removeprefix(prefix)
        if not _ID.fullmatch(run_id):
            raise ConsoleError("NOT_FOUND")
        rows = self._run_rows(snap, "WHERE c.id=?", [run_id], limit=1)
        if not rows:
            raise ConsoleError("NOT_FOUND")
        return self._load_run(snap, rows[0])

    @staticmethod
    def _page_size(value: int, maximum: int) -> int:
        if value < 0:
            raise ConsoleError("BAD_REQUEST")
        return maximum if value == 0 else min(value, maximum)

    @staticmethod
    def _months(
        snap: Snapshot, table: str, alias: str, requested: str
    ) -> tuple[str, str, str]:
        """The month answered and its nearest earlier and later neighbours."""
        if requested and not MONTH.fullmatch(requested):
            raise ConsoleError("BAD_REQUEST")
        if not snap.has(table):
            return requested, "", ""
        months = [
            str(row[0])
            for row in snap.rows(
                f"SELECT DISTINCT substr(json_extract({alias}.body,"
                f"'$.issue_date'),1,7) AS m FROM {table} {alias} "
                "WHERE m IS NOT NULL ORDER BY m"
            )
        ]
        month = requested or (months[-1] if months else "")
        earlier = [m for m in months if m < month]
        later = [m for m in months if m > month]
        return month, earlier[-1] if earlier else "", later[0] if later else ""

    def list_runs(
        self, request: service_pb.ListRunsRequest
    ) -> service_pb.ListRunsResponse:
        """One month of runs, the newest first."""
        size = self._page_size(request.page_size, MAX_RUNS)
        if request.page_token:
            raise ConsoleError("BAD_REQUEST")
        with self.snapshot() as snap:
            month, earlier, later = self._months(
                snap, "collection_runs", "c", request.month
            )
            rows = self._run_rows(
                snap,
                "WHERE substr(json_extract(c.body,'$.issue_date'),1,7)=?",
                [month],
                limit=size,
            )
            runs = [
                self._run_message(snap, self._load_run(snap, row))
                for row in rows
            ]
        return service_pb.ListRunsResponse(
            runs=tuple(runs),
            month=month,
            earlier_month=earlier,
            later_month=later,
        )

    def get_run(self, request: service_pb.GetRunRequest) -> run_pb.Run:
        """One run with its nodes, stories and external calls."""
        with self.snapshot() as snap:
            run = self._find_run(snap, request.name, "runs/")
            return self._run_message(snap, run, detail=True)

    def list_model_calls(
        self, request: service_pb.ListModelCallsRequest
    ) -> service_pb.ListModelCallsResponse:
        """A run's model calls in the order they started."""
        size = self._page_size(request.page_size, MAX_CALLS)
        if request.page_token:
            raise ConsoleError("BAD_REQUEST")
        with self.snapshot() as snap:
            run = self._find_run(snap, request.parent, "runs/")
        # Calls recorded before start times were kept sort by when they were
        # recorded; rowid breaks ties.
        ordered = sorted(
            enumerate(run.calls),
            key=lambda pair: (
                views.instant(pair[1].get("started_at"))
                or views.instant(pair[1].get("update_time"))
                or _NEVER,
                pair[0],
            ),
        )
        return service_pb.ListModelCallsResponse(
            model_calls=tuple(
                views.model_call(run.id, call, str(call["update_time"]))
                for _, call in ordered[:size]
            )
        )

    # Model usage.

    def _usage(
        self, snap: Snapshot, day_count: int
    ) -> service_pb.SummarizeModelUsageResponse:
        if not snap.has("collection_runs"):
            return service_pb.SummarizeModelUsageResponse(
                totals=views.usage_totals([])
            )
        newest = snap.one(
            "SELECT MAX(json_extract(body,'$.issue_date')) FROM collection_runs"
        )
        if newest is None or not newest[0]:
            return service_pb.SummarizeModelUsageResponse(
                totals=views.usage_totals([])
            )
        last = datetime.date.fromisoformat(str(newest[0]))
        first = (last - datetime.timedelta(days=day_count - 1)).isoformat()
        rows = self._run_rows(
            snap,
            "WHERE json_extract(c.body,'$.issue_date') BETWEEN ? AND ?",
            [first, last.isoformat()],
            limit=day_count * 8,
        )
        calls: list[tuple[str, dict[str, Any]]] = []
        definition: list[dict[str, Any]] = []
        for row in rows:
            if not definition:
                value = _json(row["definition"])
                definition = value if isinstance(value, list) else []
            issue_date = str(row["issue_date"])
            calls.extend(
                (issue_date, call) for call in self._calls(snap, str(row["id"]))
            )
        records = [call for _, call in calls]
        return service_pb.SummarizeModelUsageResponse(
            first_issue_date=first,
            last_issue_date=last.isoformat(),
            totals=views.usage_totals(records),
            days=tuple(views.usage_days(calls)),
            nodes=tuple(views.usage_nodes(calls, definition)),
            timed_call_count=sum(
                views.call_seconds(record) is not None for record in records
            ),
        )

    def summarize_model_usage(
        self, request: service_pb.SummarizeModelUsageRequest
    ) -> service_pb.SummarizeModelUsageResponse:
        """Usage over 7, 30 or 90 issue dates ending with the newest run's."""
        day_count = request.day_count or 7
        if day_count not in DAY_COUNTS:
            raise ConsoleError("BAD_REQUEST")
        with self.snapshot() as snap:
            return self._usage(snap, day_count)

    # Editions.

    def _edition_rows(
        self,
        snap: Snapshot,
        where: str,
        args: Sequence[object],
        *,
        limit: int,
    ) -> list[sqlite3.Row]:
        if not snap.has("editions", "workflow_editions"):
            return []
        return snap.rows(
            _EDITION_COLUMNS + where + _EDITION_ORDER + " LIMIT ?",
            [*args, limit],
        )

    def _journal(
        self, snap: Snapshot, key: str
    ) -> tuple[dict[str, Any] | None, list[str]]:
        if not snap.has("notion_entities", "notion_versions"):
            return None, []
        found = snap.one("SELECT * FROM notion_entities WHERE key=?", [key])
        states = [
            str(row[0])
            for row in snap.rows(
                "SELECT state FROM notion_versions WHERE entity_key=?", [key]
            )
        ]
        return (dict(found) if found else None), states

    def _edition_replica(
        self, snap: Snapshot, edition_id: str, updated_at: object
    ) -> backup_pb.Replica:
        entity, states = self._journal(snap, "edition:" + edition_id)
        outdated = False
        if entity is not None and snap.has("notion_imports"):
            imported = snap.one(
                "SELECT digest FROM notion_imports "
                "WHERE kind='edition' AND source_id=?",
                [edition_id],
            )
            # The journal re-imports an edition whose updated_at moved on.
            outdated = imported is not None and imported[0] != updated_at
        return views.replica(
            enabled=self.notion_enabled,
            entity=entity,
            version_states=states,
            outdated=outdated,
        )

    def _edition_backup(
        self, snap: Snapshot, edition_id: object
    ) -> backup_pb.ReplicaCounts | None:
        """The run's own edition as the backup's scope; None when it is off."""
        if not self.notion_enabled:
            return None
        if not edition_id:
            return views.merge_counts([])
        found = snap.one(
            "SELECT json_extract(body,'$.updated_at') FROM editions WHERE id=?",
            [edition_id],
        )
        updated_at = found[0] if found else None
        copy = self._edition_replica(snap, str(edition_id), updated_at)
        return views.replica_counts(_EDITIONS, [(copy, updated_at)])

    def _kind(
        self, snap: Snapshot, row: sqlite3.Row, run_key: str
    ) -> edition_pb.Edition_Kind:
        correction = snap.has("verification_sends") and (
            snap.one(
                "SELECT 1 FROM verification_sends WHERE edition_id=?",
                [row["id"]],
            )
            is not None
        )
        return views.edition_kind(
            is_fixture=bool(row["is_fixture"]),
            correction=correction,
            runs_recorded=snap.has("collection_runs"),
            request_key=run_key,
            issue_date=str(row["issue_date"] or ""),
        )

    def _edition_message(
        self, snap: Snapshot, row: sqlite3.Row
    ) -> edition_pb.Edition:
        run_id = str(row["run_id"] or "")
        run_key = ""
        if run_id and snap.has("collection_runs"):
            found = snap.one(
                "SELECT request_key FROM collection_runs WHERE id=?", [run_id]
            )
            run_key = str(found[0]) if found else ""
        corrections = 0
        if snap.has("verification_sends"):
            found = snap.one(
                "SELECT COUNT(*) FROM verification_sends WHERE issue_date=?",
                [row["issue_date"]],
            )
            corrections = int(found[0]) if found else 0
        topics = _json(row["topics"])
        headings = (
            [views.text(item) for item in topics]
            if isinstance(topics, list)
            else []
        )
        return edition_pb.Edition(
            name="editions/" + str(row["id"]),
            issue_date=str(row["issue_date"] or ""),
            kind=self._kind(snap, row, run_key),
            run="runs/" + run_id if run_id else "",
            create_time=views.timestamp(row["created_at"]),
            update_time=views.timestamp(row["updated_at"]),
            subject=views.text(row["subject"]),
            title=views.text(row["title"]),
            introduction=views.text(row["introduction"]),
            topics=tuple(headings),
            section_count=len(headings),
            delivery=views.delivery(
                state=row["delivery_state"],
                updated_at=row["updated_at"],
                error_code=row["error_code"],
                corrections=corrections,
            ),
            backup=self._edition_replica(
                snap, str(row["id"]), row["updated_at"]
            ),
        )

    def list_editions(
        self, request: service_pb.ListEditionsRequest
    ) -> service_pb.ListEditionsResponse:
        """One month of editions in the list view, the newest first."""
        size = self._page_size(request.page_size, MAX_RUNS)
        if request.page_token:
            raise ConsoleError("BAD_REQUEST")
        with self.snapshot() as snap:
            month, earlier, later = self._months(
                snap, "editions", "e", request.month
            )
            editions = [
                self._edition_message(snap, row)
                for row in self._edition_rows(
                    snap,
                    "WHERE substr(json_extract(e.body,'$.issue_date'),1,7)=?",
                    [month],
                    limit=size,
                )
            ]
        return service_pb.ListEditionsResponse(
            editions=tuple(editions),
            month=month,
            earlier_month=earlier,
            later_month=later,
        )

    def _find_edition(
        self, snap: Snapshot, edition_id: str
    ) -> tuple[sqlite3.Row, dict[str, Any], list[Any]]:
        if not _ID.fullmatch(edition_id):
            raise ConsoleError("NOT_FOUND")
        rows = self._edition_rows(snap, "WHERE e.id=?", [edition_id], limit=1)
        found = snap.one(
            "SELECT body,snapshot FROM editions WHERE id=?", [edition_id]
        )
        if not rows or found is None:
            raise ConsoleError("NOT_FOUND")
        body = _json(found["body"])
        packets = _json(found["snapshot"])
        return (
            rows[0],
            body if isinstance(body, dict) else {},
            packets if isinstance(packets, list) else [],
        )

    def get_edition(
        self, request: service_pb.GetEditionRequest
    ) -> edition_pb.Edition:
        """One edition with its full structured body."""
        edition_id = request.name.removeprefix("editions/")
        with self.snapshot() as snap:
            row, body, packets = self._find_edition(snap, edition_id)
            message = self._edition_message(snap, row)
            run_id = str(row["run_id"] or "")
            stories = self._stories(snap, run_id) if run_id else []
            revision = ""
            if run_id and snap.has("collection_workflow_snapshots"):
                found = snap.one(
                    "SELECT json_extract(body,"
                    "'$.inputs.content_config.revision') "
                    "FROM collection_workflow_snapshots WHERE run_id=?",
                    [run_id],
                )
                revision = views.text(found[0]) if found else ""
            corrected = ""
            if snap.has("verification_sends"):
                found = snap.one(
                    "SELECT previous_edition_id FROM verification_sends "
                    "WHERE edition_id=?",
                    [edition_id],
                )
                corrected = "editions/" + str(found[0]) if found else ""
        draft = body.get("draft")
        draft = draft if isinstance(draft, dict) else {}
        context = None
        if draft:
            try:
                context = rendering.edition_context(draft, packets)
            except (ValueError, KeyError, TypeError):
                # An edition the email could not number is still readable,
                # without reference numbers.
                context = None
        review = body.get("review")
        review = review if isinstance(review, dict) else {}
        rendered = body.get("rendered")
        rendered = rendered if isinstance(rendered, dict) else {}
        return dataclasses.replace(
            message,
            **views.edition_body(context, draft),
            chart_png_base64=views.text(rendered.get("chart_png")),
            limitations=views.text(draft.get("limitations")),
            personal_digest=views.personal_digest(
                body.get("personal_digest"),
                backup_included=self.notion_enabled
                and self.settings.notion_archive_private,
            ),
            review_passed=bool(review.get("passed")),
            review_findings=tuple(
                views.text(item) for item in review.get("findings") or []
            ),
            stories=tuple(stories),
            usage=views.frozen_usage(body.get("usage")),
            config_revision=revision,
            corrected_edition=corrected,
            render_hash=views.text(rendered.get("render_hash")),
        )

    def get_edition_rendering(
        self, request: service_pb.GetEditionRenderingRequest
    ) -> edition_pb.EditionRendering:
        """The frozen email: HTML with its chart inline, and its text."""
        edition_id = request.name.removeprefix("editions/").removesuffix(
            "/rendering"
        )
        with self.snapshot() as snap:
            _, body, _ = self._find_edition(snap, edition_id)
        rendered = body.get("rendered")
        if not isinstance(rendered, dict) or not rendered.get("html"):
            raise ConsoleError("NOT_FOUND")
        return edition_pb.EditionRendering(
            name=request.name,
            html=rendering.preview_html(
                {
                    "html": views.text(rendered.get("html")),
                    "text": views.text(rendered.get("text")),
                    "chart_png": views.text(rendered.get("chart_png")),
                    "render_hash": views.text(rendered.get("render_hash")),
                }
            ),
            text=views.text(rendered.get("text")),
            render_hash=views.text(rendered.get("render_hash")),
        )

    # The Notion backup.

    def _targets(
        self, snap: Snapshot
    ) -> tuple[list[backup_pb.ReplicaCounts], list[backup_pb.ReplicaException]]:
        editions: list[tuple[backup_pb.Replica, object]] = []
        exceptions: list[tuple[str, backup_pb.ReplicaException]] = []
        if snap.has("editions"):
            for row in snap.rows(
                "SELECT id,json_extract(body,'$.updated_at') AS updated_at,"
                "json_extract(body,'$.issue_date') AS issue_date,"
                "json_extract(body,'$.draft.title') AS title "
                "FROM editions WHERE state='ready' ORDER BY rowid"
            ):
                copy = self._edition_replica(
                    snap, str(row["id"]), row["updated_at"]
                )
                editions.append((copy, row["updated_at"]))
                if copy.state in _ATTENTION:
                    exceptions.append(
                        (
                            str(row["updated_at"] or ""),
                            backup_pb.ReplicaException(
                                target=_EDITIONS,
                                edition="editions/" + str(row["id"]),
                                issue_date=views.text(row["issue_date"]),
                                title=views.text(row["title"]),
                                replica=copy,
                            ),
                        )
                    )
        materials = self._materials(snap, exceptions)
        # The oldest first; a record without a known time last.
        ordered = sorted(
            exceptions,
            key=lambda pair: views.timestamp(pair[0]) or "￿",
        )
        return (
            [
                views.replica_counts(_EDITIONS, editions),
                views.replica_counts(_MATERIALS, materials),
            ],
            [exception for _, exception in ordered[:MAX_EXCEPTIONS]],
        )

    def _materials(
        self,
        snap: Snapshot,
        exceptions: list[tuple[str, backup_pb.ReplicaException]],
    ) -> list[tuple[backup_pb.Replica, object]]:
        if not snap.has("notion_entities", "notion_versions"):
            return []
        states: dict[str, list[str]] = {}
        for row in snap.rows(
            "SELECT entity_key,state FROM notion_versions "
            "WHERE entity_key LIKE 'material:%'"
        ):
            states.setdefault(str(row[0]), []).append(str(row[1]))
        first_seen: dict[str, str] = {}
        if snap.has("notion_candidates"):
            for row in snap.rows(
                "SELECT entity_key,MIN(first_seen) FROM notion_candidates "
                "GROUP BY entity_key"
            ):
                first_seen[str(row[0])] = str(row[1] or "")
        materials: list[tuple[backup_pb.Replica, object]] = []
        for row in snap.rows(
            "SELECT * FROM notion_entities WHERE kind='material' ORDER BY rowid"
        ):
            entity = dict(row)
            key = str(entity["key"])
            copy = views.replica(
                enabled=self.notion_enabled,
                entity=entity,
                version_states=states.get(key, []),
                outdated=False,
            )
            since = first_seen.get(key, "")
            materials.append((copy, since))
            if copy.state in _ATTENTION:
                exceptions.append(
                    (
                        since,
                        backup_pb.ReplicaException(
                            target=_MATERIALS,
                            title=_material_title(entity.get("properties")),
                            replica=copy,
                        ),
                    )
                )
        return materials

    def get_backup_status(
        self, request: service_pb.GetBackupStatusRequest
    ) -> backup_pb.BackupStatus:
        """The Notion backup per target and the records needing attention."""
        with self.snapshot() as snap:
            targets, exceptions = self._targets(snap)
            errors: dict[str, int] = {}
            if snap.has("notion_imports"):
                for row in snap.rows(
                    "SELECT error,COUNT(*) FROM notion_imports "
                    "WHERE error!='' GROUP BY error"
                ):
                    errors[str(row[0])] = views.int32(row[1])
        return backup_pb.BackupStatus(
            name=request.name,
            generate_time=views.timestamp(self.clock().isoformat()),
            enabled=self.notion_enabled,
            includes_personal=self.notion_enabled
            and self.settings.notion_archive_private,
            targets=tuple(targets),
            exceptions=tuple(exceptions),
            import_error_counts=errors,
        )

    # The overview.

    def _service(
        self, snap: Snapshot, healthy: bool
    ) -> overview_pb.ServiceState:
        drain = "active"
        if snap.has("deployment_gate", "deployment_drains"):
            found = snap.one(
                "SELECT d.state FROM deployment_gate g "
                "JOIN deployment_drains d ON d.request_key=g.request_key "
                "WHERE g.singleton=1"
            )
            drain = str(found[0]) if found else "active"
        # The monitoring snapshot's own predicates (COUNT only: it also
        # records identities, which a read must not).
        unknown = {
            category: snap.count(table, predicate)
            for category, (
                table,
                predicate,
            ) in monitoring_status.UNKNOWN_SOURCES.items()
        }
        queued = running = 0
        if snap.has("collection_runs"):
            for state, count in snap.rows(
                "SELECT state,COUNT(*) FROM collection_runs GROUP BY state"
            ):
                queued += count if state == "queued" else 0
                running += (
                    count
                    if state in {"collecting", "projecting", "editing"}
                    else 0
                )
        return overview_pb.ServiceState(
            worker_healthy=healthy,
            drain_state=views.drain_state(drain),
            queued_run_count=queued,
            running_run_count=running,
            unknown_count=sum(unknown.values()),
            unknown_category_counts=unknown,
            queued_count=sum(snap.count(*gate) for gate in GATE_QUEUED),
            inflight_count=sum(snap.count(*gate) for gate in GATE_INFLIGHT),
        )

    def config(self, now: datetime.datetime) -> catalog_pb.ConfigState:
        """The configuration in effect, as Fleet and Home read it."""
        root = self.settings.content_config_dir
        observed = monitoring_api.config_status(root)
        repository = ""
        if root is not None:
            try:
                value = config_sync.ConfigSync(
                    config_sync.SyncSettings(root)
                ).status()
            except (OSError, ValueError, TypeError, KeyError):
                value = {}
            name = value.get("repository")
            if isinstance(name, str) and config_sync.REPOSITORY.fullmatch(name):
                repository = name
        return views.config_state(observed, repository, now)

    def overview(self, *, healthy: bool) -> overview_pb.Overview:
        """The first page: latest issue and run, 14 days, state, interfaces."""
        now = self.clock()
        today = now.astimezone(self.zone).date()
        dates = [
            (today - datetime.timedelta(days=offset)).isoformat()
            for offset in range(STRIP_DAYS)
        ]
        with self.snapshot() as snap:
            # Each date's scheduled run, or else its newest run.
            chosen: dict[str, sqlite3.Row] = {}
            for row in self._run_rows(
                snap,
                "WHERE json_extract(c.body,'$.issue_date') BETWEEN ? AND ?",
                [dates[-1], dates[0]],
                limit=STRIP_DAYS * 8,
            ):
                date = str(row["issue_date"])
                if date not in chosen or (
                    row["request_key"] == "daily-" + date
                    and chosen[date]["request_key"] != "daily-" + date
                ):
                    chosen[date] = row
            days = [
                _day(
                    date,
                    self._run_message(snap, self._load_run(snap, chosen[date])),
                )
                if date in chosen
                else overview_pb.DayStatus(issue_date=date)
                for date in dates
            ]
            # The daily schedule's newest run, else the newest run: a later
            # manual or replayed run does not take over the first page.
            latest_rows = self._run_rows(
                snap, "", [], limit=1, order=_SCHEDULED_FIRST
            )
            latest = (
                self._load_run(snap, latest_rows[0]) if latest_rows else None
            )
            latest_edition = self._latest_edition(snap)
            delivered = (
                snap.one(monitoring_status.LATEST_DELIVERY_SQL)
                if snap.has("editions")
                else None
            )
            delivered_rows = (
                self._edition_rows(
                    snap, "WHERE e.id=?", [delivered["id"]], limit=1
                )
                if delivered
                else []
            )
            targets = self._targets(snap)[0] if self.notion_enabled else []
            backup = (
                views.merge_counts(targets) if self.notion_enabled else None
            )
            usage = self._usage(snap, 7)
            message = self._run_message(snap, latest) if latest else None
            outcomes = (
                views.feed_outcomes(
                    latest.issue_date,
                    latest.feeds_diagnostics,
                    latest.feeds_sources,
                )
                if latest
                else []
            )
            return overview_pb.Overview(
                name="overview",
                generate_time=views.timestamp(now.isoformat()),
                time_zone=self.settings.time_zone,
                engine_revision=provenance.build_sha() or "",
                latest_run=message,
                latest_edition=latest_edition,
                latest_delivery=self._edition_message(snap, delivered_rows[0])
                if delivered_rows
                else None,
                days=tuple(days),
                service=self._service(snap, healthy),
                config=self.config(now),
                backup=backup,
                week_usage=usage.totals,
                dependencies=tuple(
                    views.dependencies(
                        run=self._dependency_run(latest) if latest else None,
                        feeds=outcomes,
                        feed_diagnostics=latest.feeds_diagnostics
                        if latest
                        else None,
                        calls=[(latest.issue_date, c) for c in latest.calls]
                        if latest
                        else [],
                        edition=latest.edition if latest else None,
                        todofy_enabled=self.settings.todofy_backend
                        != "disabled",
                        backup=backup,
                        backup_error="",
                    )
                ),
            )

    # Sources.

    def _bundle(self) -> dict[str, Any] | None:
        root = self.settings.content_config_dir
        try:
            if root is None:
                return content_config.packaged_snapshot()
            return content_config.load_active(root)
        except (content_config.ContentConfigError, OSError, ValueError):
            return None

    def _scheduled(self, snap: Snapshot) -> list[_Run]:
        rows = self._run_rows(
            snap,
            "WHERE c.request_key='daily-'||json_extract(c.body,'$.issue_date')",
            [],
            limit=RECENT_RUNS,
        )
        return [self._load_run(snap, row) for row in rows]

    def get_source_catalog(
        self, request: service_pb.GetSourceCatalogRequest
    ) -> catalog_pb.SourceCatalog:
        """The inputs of the next run and how they fared recently."""
        now = self.clock()
        bundle = self._bundle()
        files = bundle["files"] if bundle else {}
        with self.snapshot() as snap:
            recent = self._scheduled(snap)
            history = self._history(snap)
            discovered = self._discovered(snap, recent[0] if recent else None)
            candidates = (
                snap.one("SELECT COUNT(*) FROM candidate_history")
                if snap.has("candidate_history")
                else None
            )
            fetch = self._latest_fetch(snap)
        directions = _directions(files)
        registry = _registry(files, [d[0] for d in directions])
        outcomes = {
            run.id: {
                o.source_id: o
                for o in views.feed_outcomes(
                    run.issue_date, run.feeds_diagnostics, run.feeds_sources
                )
            }
            for run in recent
        }
        sources = tuple(
            catalog_pb.FeedSource(
                id=source.id,
                display_name=source.name,
                direction_id=source.direction,
                kind=source.kind,
                url=views.http_url(source.url),
                enabled=source.enabled,
                max_seeds=source.max_seeds,
                max_age_days=source.max_age_days,
                recent=tuple(
                    outcomes[run.id][source.id]
                    for run in recent
                    if source.id in outcomes[run.id]
                ),
            )
            for source in registry
        )
        return catalog_pb.SourceCatalog(
            name=request.name,
            generate_time=views.timestamp(now.isoformat()),
            config=self.config(now),
            config_history=tuple(history),
            directions=tuple(
                catalog_pb.Direction(
                    id=identifier,
                    title=title,
                    instructions=instructions,
                    source_count=sum(
                        s.enabled and s.direction == identifier
                        for s in registry
                    ),
                    latest_state=discovered.get(identifier, _UNSEEN)[0],
                    latest_candidate_count=discovered.get(identifier, _UNSEEN)[
                        1
                    ],
                )
                for identifier, title, instructions in directions
            ),
            sources=sources,
            budgets=tuple(_budgets(bundle, recent)),
            editorial_limits={
                key: views.int32(value)
                for key, value in (bundle or {}).get("editorial", {}).items()
            },
            personal_input=catalog_pb.PersonalInput(
                enabled=self.settings.todofy_backend != "disabled",
                last_fetch_time=views.timestamp(fetch.get("fetched_at")),
                last_error_code=views.text(fetch.get("error_code")),
            ),
            history_candidate_count=views.int32(candidates[0])
            if candidates
            else 0,
        )

    def _history(self, snap: Snapshot) -> list[catalog_pb.ConfigRevision]:
        revisions: dict[str, list[str]] = {}
        for row in self._run_rows(snap, "", [], limit=HISTORY_RUNS):
            if row["revision"]:
                revisions.setdefault(str(row["revision"]), []).append(
                    str(row["issue_date"])
                )
        ordered = sorted(
            revisions.items(), key=lambda item: max(item[1]), reverse=True
        )
        return [
            catalog_pb.ConfigRevision(
                revision=revision,
                first_issue_date=min(dates),
                last_issue_date=max(dates),
                run_count=len(dates),
            )
            for revision, dates in ordered[:MAX_REVISIONS]
        ]

    def _discovered(
        self, snap: Snapshot, run: _Run | None
    ) -> dict[str, tuple[run_pb.RunNode_State, int]]:
        if run is None:
            return {}
        node_id = views.node_of(run.definition, "discovery")
        result: dict[str, tuple[run_pb.RunNode_State, int]] = {}
        for attempt in run.attempts:
            if attempt["node_id"] != node_id or not attempt["item_id"]:
                continue
            count = None
            if snap.has("workflow_artifacts"):
                count = snap.one(
                    "SELECT json_array_length(body,'$.candidates') "
                    "FROM workflow_artifacts WHERE run_id=? AND node_id=? "
                    "AND item_id=?",
                    [run.id, node_id, attempt["item_id"]],
                )
            result[str(attempt["item_id"])] = (
                views.NODE_STATES.get(
                    str(attempt["state"]), run_pb.RunNode_State.UNSPECIFIED
                ),
                views.int32(count[0]) if count else 0,
            )
        return result

    def _latest_edition(self, snap: Snapshot) -> edition_pb.Edition | None:
        """The newest daily edition, else the newest edition."""
        newest = None
        for row in self._edition_rows(snap, "", [], limit=MAX_RUNS):
            message = self._edition_message(snap, row)
            if message.kind == edition_pb.Edition_Kind.DAILY:
                return message
            newest = newest or message
        return newest

    @staticmethod
    def _latest_fetch(snap: Snapshot) -> dict[str, Any]:
        if not snap.has("editions"):
            return {}
        found = snap.one(
            "SELECT json_extract(body,'$.personal_digest') FROM editions "
            "WHERE json_extract(body,'$.personal_digest') IS NOT NULL "
            "ORDER BY rowid DESC LIMIT 1"
        )
        value = _json(found[0]) if found else None
        return value if isinstance(value, dict) else {}


def _material_title(properties: object) -> str:
    value = _json(properties)
    try:
        parts = value["title"]["title"]
        return "".join(views.text(part["text"]["content"]) for part in parts)[
            :300
        ]
    except (KeyError, TypeError, IndexError):
        return ""


def _directions(files: Mapping[str, str]) -> list[tuple[str, str, str]]:
    """Each discovery direction's ID, title (its first heading) and text."""
    if not files:
        return []
    try:
        instructions = content_config.config_instructions(files)
    except content_config.ContentConfigError:
        return []
    result = []
    for item in instructions:
        own = files.get(f"discovery/{item.id}.md", "")
        heading = next(
            (
                line[2:].strip()
                for line in own.splitlines()
                if line.startswith("# ")
            ),
            item.id,
        )
        result.append((item.id, heading, item.text))
    return result


def _registry(
    files: Mapping[str, str], directions: Sequence[str]
) -> list[researcher.Source]:
    text = files.get(researcher.REGISTRY_FILE)
    if not isinstance(text, str):
        return []
    try:
        return researcher.validate_registry(text, directions)
    except researcher.RegistryError:
        return []


def _budgets(
    bundle: Mapping[str, Any] | None, recent: Sequence[_Run]
) -> list[catalog_pb.NodeBudget]:
    """Each node's configured budget against how recent runs used theirs."""
    if not bundle:
        return []
    try:
        definition = content_config.config_definition(dict(bundle)).snapshot()
    except (ValueError, KeyError, TypeError):
        return []
    result = []
    for node in definition["nodes"]:
        node_id = str(node["id"])
        durations: list[float] = []
        counted = overruns = 0
        for run in recent:
            own = [a for a in run.attempts if a["node_id"] == node_id]
            if not own:
                continue
            counted += 1
            frozen = views.budget_seconds(run.definition, node_id)
            times = [
                d
                for a in own
                if (d := views.seconds(a["started_at"], a["finished_at"]))
                is not None
            ]
            durations.extend(times)
            overruns += any(a["error_code"] == "timeout" for a in own) or (
                bool(frozen) and any(t > frozen for t in times)
            )
        result.append(
            catalog_pb.NodeBudget(
                node_id=node_id,
                budget_seconds=views.budget_seconds(
                    definition["nodes"], node_id
                ),
                recent_median_seconds=round(statistics.median(durations), 3)
                if durations
                else None,
                recent_max_seconds=max(durations) if durations else None,
                recent_run_count=counted,
                overrun_count=overruns,
            )
        )
    return result


def _day(date: str, run: run_pb.Run) -> overview_pb.DayStatus:
    return overview_pb.DayStatus(
        issue_date=date,
        run=run.name,
        edition=run.edition,
        run_state=run.state,
        delivery_state=run.delivery_state,
        stop_reason=run.stop_reason,
        failed_node=run.failure.node_id if run.failure else "",
    )

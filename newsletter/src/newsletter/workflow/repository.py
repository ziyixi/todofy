"""Frozen graph/input receipts, durable attempts and immutable JSON artifacts.

Uses the existing Store transaction lock. No transaction spans a provider call.
There is deliberately no automatic retry operation for failed/unknown attempts.
"""

import json
import re
from typing import Any, cast

import newsletter.contracts as contracts
import newsletter.store as newsletter_store
import newsletter.types as types
import newsletter.workflow.definition as newsletter_workflow_definition
import newsletter.workflow.types as newsletter_workflow_types

MAX_ARTIFACT_BYTES = 2 * 1024 * 1024
_ITEM_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}\Z")
SUCCESS_STATES = frozenset({"succeeded", "skipped"})
# These describe shared execution prerequisites, not one weak retrieval source.
# An operator recipe must not turn an expired login or exhausted account into
# repeated model attempts for every remaining discovery/research item.
FATAL_ERROR_CODES = frozenset({"authentication", "configuration", "rate_limit"})
ERROR_CODES = frozenset(
    {
        "configuration",
        "invalid_input",
        "invalid_output",
        "handler_failed",
        "timeout",
        "interrupted",
        "external_unknown",
        "dependency_failed",
        "authentication",
        "rate_limit",
        "unavailable",
        "no_findings",
        "not_required",
        "partial_failure",
    }
)


class WorkflowError(RuntimeError):
    """Report a finite code for a rejected workflow storage operation."""

    def __init__(self, code: str = "invalid_state") -> None:
        self.code = (
            code
            if code
            in {"not_found", "conflict", "invalid_state", "invalid_input"}
            else "invalid_state"
        )
        super().__init__("Workflow storage rejected operation: " + self.code)


def json_value(value: Any) -> tuple[str, str]:
    """Encode and hash a bounded immutable workflow artifact."""
    try:
        body = contracts.canonical_json(value)
        if len(body.encode("utf-8")) > MAX_ARTIFACT_BYTES:
            raise ValueError
        return body, contracts.content_hash(value)
    except (TypeError, ValueError, RecursionError, OverflowError):
        raise WorkflowError("invalid_input") from None


def frozen_inputs(
    store: newsletter_store.Store, run_id: str
) -> types.Payload | None:
    """Read frozen inputs without creating workflow tables or recovering runs.

    Missing tables and runs belong to older editions and return None. Malformed
    stored JSON remains an error; it must not silently select a new template.
    """
    with store.lock:
        exists = store.db.execute(
            "SELECT 1 FROM sqlite_master "
            "WHERE type='table' AND name='workflow_runs'"
        ).fetchone()
        if exists is None:
            return None
        row = store.db.execute(
            "SELECT inputs FROM workflow_runs WHERE id=?", (run_id,)
        ).fetchone()
    if row is None:
        return None
    value: object = json.loads(row["inputs"])
    if not isinstance(value, dict):
        raise WorkflowError("invalid_state")
    return value


class WorkflowRepository:
    """Persist frozen graph inputs, ordered attempts and result artifacts."""

    def __init__(self, store: newsletter_store.Store) -> None:
        self.store = store
        with store.lock:
            store.db.executescript(
                "\n"
                "                CREATE TABLE IF NOT EXISTS wor"
                "kflow_runs (\n"
                "                    id TEXT PRIMARY KEY, defin"
                "ition_hash TEXT NOT NULL,\n"
                "                    definition TEXT NOT NULL, "
                "inputs_hash TEXT NOT NULL,\n"
                "                    inputs TEXT NOT NULL, body"
                " TEXT NOT NULL);\n"
                "                CREATE TABLE IF NOT EXISTS wor"
                "kflow_attempts (\n"
                "                    id TEXT PRIMARY KEY, run_i"
                "d TEXT NOT NULL, node_id TEXT NOT NULL,\n"
                "                    item_id TEXT NOT NULL, sta"
                "te TEXT NOT NULL, input_hash TEXT NOT NULL,\n"
                "                    artifact_id TEXT NOT NULL "
                "DEFAULT '', error_code TEXT NOT NULL DEFAULT '"
                "',\n"
                "                    started_at TEXT NOT NULL, "
                "finished_at TEXT NOT NULL DEFAULT '',\n"
                "                    UNIQUE(run_id,node_id,item"
                "_id),\n"
                "                    FOREIGN KEY(run_id) REFERE"
                "NCES workflow_runs(id));\n"
                "                CREATE TABLE IF NOT EXISTS wor"
                "kflow_artifacts (\n"
                "                    id TEXT PRIMARY KEY, run_i"
                "d TEXT NOT NULL, node_id TEXT NOT NULL,\n"
                "                    item_id TEXT NOT NULL, con"
                "tent_hash TEXT NOT NULL, body TEXT NOT NULL,\n"
                "                    created_at TEXT NOT NULL, "
                "UNIQUE(run_id,node_id,item_id),\n"
                "                    FOREIGN KEY(run_id) REFERE"
                "NCES workflow_runs(id));\n"
                "            "
            )

    def exists(self, run_id: str) -> bool:
        """Report whether a frozen graph has a durable execution receipt."""
        with self.store.lock:
            row = self.store.db.execute(
                "SELECT 1 FROM workflow_runs WHERE id=?", (run_id,)
            ).fetchone()
        return row is not None

    def has_edition_binding(self, run_id: str) -> bool:
        """Check for any edition already bound to this workflow run."""
        with self.store.lock:
            row = self.store.db.execute(
                "SELECT 1 FROM workflow_editions WHERE run_id=?", (run_id,)
            ).fetchone()
        return row is not None

    def start(
        self,
        run_id: str,
        definition: newsletter_workflow_definition.WorkflowDefinition,
        inputs: dict[str, Any],
    ) -> newsletter_workflow_types.WorkflowRun:
        """Freeze a new graph and inputs, or read the identical existing run."""
        if (
            not isinstance(run_id, str)
            or not _ITEM_ID.fullmatch(run_id)
            or not isinstance(inputs, dict)
        ):
            raise WorkflowError("invalid_input")
        definition = newsletter_workflow_definition.parse_definition(
            definition.snapshot()
        )
        definition_json, definition_hash = json_value(definition.snapshot())
        inputs_json, inputs_hash = json_value(inputs)
        with self.store.transaction():
            row = self.store.db.execute(
                "SELECT * FROM workflow_runs WHERE id=?", (run_id,)
            ).fetchone()
            if row:
                if (
                    row["definition_hash"] != definition_hash
                    or row["inputs_hash"] != inputs_hash
                ):
                    raise WorkflowError("conflict")
                return cast(
                    newsletter_workflow_types.WorkflowRun,
                    json.loads(row["body"]),
                )
            at = newsletter_store.now()
            body: newsletter_workflow_types.WorkflowRun = {
                "id": run_id,
                "state": "queued",
                "definition_hash": definition_hash,
                "inputs_hash": inputs_hash,
                "created_at": at,
                "updated_at": at,
                "nodes": {
                    node.id: {
                        "state": "pending",
                        "artifact_id": "",
                        "error_code": "",
                        "map_expanded": False,
                        "map_hash": "",
                        "items": [],
                        "degraded": False,
                    }
                    for node in definition.nodes
                },
            }
            self.store.db.execute(
                "INSERT INTO workflow_runs VALUES(?,?,?,?,?,?)",
                (
                    run_id,
                    definition_hash,
                    definition_json,
                    inputs_hash,
                    inputs_json,
                    contracts.canonical_json(body),
                ),
            )
            return body

    def get(self, run_id: str) -> newsletter_workflow_types.WorkflowRun:
        """Read a workflow run and its fixed control metadata."""
        with self.store.lock:
            row = self.store.db.execute(
                "SELECT body FROM workflow_runs WHERE id=?", (run_id,)
            ).fetchone()
            if row is None:
                raise WorkflowError("not_found")
            return cast(
                newsletter_workflow_types.WorkflowRun, json.loads(row[0])
            )

    def snapshot(
        self, run_id: str
    ) -> newsletter_workflow_types.WorkflowSnapshot:
        """Read the exact graph and inputs frozen before execution."""
        with self.store.lock:
            row = self.store.db.execute(
                "SELECT * FROM workflow_runs WHERE id=?", (run_id,)
            ).fetchone()
            if row is None:
                raise WorkflowError("not_found")
            return {
                "definition": json.loads(row["definition"]),
                "inputs": json.loads(row["inputs"]),
                "definition_hash": row["definition_hash"],
                "inputs_hash": row["inputs_hash"],
            }

    def _write(self, run: newsletter_workflow_types.WorkflowRun) -> None:
        run["updated_at"] = newsletter_store.now()
        states = [node["state"] for node in run["nodes"].values()]
        if "unknown" in states:
            run["state"] = "unknown"
        elif "failed" in states:
            run["state"] = "failed"
        elif all(state in SUCCESS_STATES for state in states):
            run["state"] = "succeeded"
        else:
            run["state"] = "running"
        self.store.db.execute(
            "UPDATE workflow_runs SET body=? WHERE id=?",
            (contracts.canonical_json(run), run["id"]),
        )

    def _artifact(
        self, run_id: str, node_id: str, item_id: str, value: Any
    ) -> str:
        body, digest = json_value(value)
        identifier = contracts.content_hash(
            {"run": run_id, "node": node_id, "item": item_id, "hash": digest}
        )
        old = self.store.db.execute(
            (
                "SELECT id,content_hash FROM workflow_artifacts WHERE "
                "run_id=? AND node_id=? AND "
                "item_id=?"
            ),
            (run_id, node_id, item_id),
        ).fetchone()
        if old:
            if old["content_hash"] != digest:
                raise WorkflowError("conflict")
            return cast(str, old["id"])
        self.store.db.execute(
            "INSERT INTO workflow_artifacts VALUES(?,?,?,?,?,?,?)",
            (
                identifier,
                run_id,
                node_id,
                item_id,
                digest,
                body,
                newsletter_store.now(),
            ),
        )
        return identifier

    def output(self, run_id: str, node_id: str) -> Any:
        """Read the immutable aggregate output of one logical node."""
        with self.store.lock:
            row = self.store.db.execute(
                (
                    "SELECT body FROM workflow_artifacts WHERE run_id=? AND "
                    "node_id=? AND "
                    "item_id=''"
                ),
                (run_id, node_id),
            ).fetchone()
            if row is None:
                raise WorkflowError("not_found")
            return json.loads(row[0])

    def artifacts(
        self, run_id: str, node_id: str | None = None
    ) -> list[dict[str, Any]]:
        """List immutable artifacts for a run or one logical node."""
        with self.store.lock:
            query, args = (
                "SELECT * FROM workflow_artifacts WHERE run_id=?",
                [run_id],
            )
            if node_id is not None:
                query += " AND node_id=?"
                args.append(node_id)
            rows = self.store.db.execute(
                query + " ORDER BY node_id,item_id", args
            ).fetchall()
            return [
                {
                    "id": row["id"],
                    "node_id": row["node_id"],
                    "item_id": row["item_id"],
                    "content_hash": row["content_hash"],
                    "value": json.loads(row["body"]),
                    "created_at": row["created_at"],
                }
                for row in rows
            ]

    def attempts(self, run_id: str) -> list[dict[str, Any]]:
        """List durable attempts in their recorded execution order."""
        with self.store.lock:
            return [
                dict(row)
                for row in self.store.db.execute(
                    (
                        "SELECT * FROM workflow_attempts WHERE run_id=? "
                        "ORDER BY started_at,id"
                    ),
                    (run_id,),
                ).fetchall()
            ]

    def expand_map(self, run_id: str, node_id: str, items: Any) -> None:
        """Freeze ordered map inputs before any child may be claimed."""
        with self.store.transaction():
            run = self.get(run_id)
            definition = newsletter_workflow_definition.parse_definition(
                self.snapshot(run_id)["definition"]
            )
            node = next(
                (item for item in definition.nodes if item.id == node_id), None
            )
            if (
                node is None
                or node.map is None
                or not isinstance(items, list)
                or len(items) > node.map.max_items
            ):
                raise WorkflowError("invalid_input")
            if any(
                not isinstance(item, dict)
                or not isinstance(item.get("id"), str)
                or not _ITEM_ID.fullmatch(item["id"])
                for item in items
            ):
                raise WorkflowError("invalid_input")
            if len({item["id"] for item in items}) != len(items):
                raise WorkflowError("invalid_input")
            # Upstream planners own priority; stable item identity is not a sort
            # key.
            # The ordered array is frozen too, so reordered replays conflict.
            serialized, digest = json_value(items)
            state = run["nodes"][node_id]
            if state["map_expanded"]:
                if state["map_hash"] != digest:
                    raise WorkflowError("conflict")
                return
            if (
                run["state"] not in {"queued", "running"}
                or state["state"] != "pending"
            ):
                raise WorkflowError()
            if any(
                run["nodes"][dependency]["state"] not in SUCCESS_STATES
                for dependency in node.needs
            ):
                raise WorkflowError()
            state.update(
                {
                    "map_expanded": True,
                    "map_hash": digest,
                    "items": [
                        {
                            "id": item["id"],
                            "value": item,
                            "state": "pending",
                            "artifact_id": "",
                            "error_code": "",
                        }
                        for item in json.loads(serialized)
                    ],
                }
            )
            if not items:
                state.update(
                    {
                        "state": "skipped",
                        "error_code": "no_findings",
                        "artifact_id": self._artifact(run_id, node_id, "", []),
                    }
                )
            self._write(run)

    def claim(
        self, run_id: str, node_id: str, item_id: str, input_value: Any
    ) -> str | None:
        """Reserve one ready node or child while enforcing serial execution."""
        _, digest = json_value(input_value)
        with self.store.transaction():
            run = self.get(run_id)
            if run["state"] not in {"queued", "running"}:
                return None
            if self.store.db.execute(
                "SELECT 1 FROM workflow_attempts WHERE state='running' LIMIT 1"
            ).fetchone():
                return None
            node = run["nodes"].get(node_id)
            if node is None:
                raise WorkflowError("invalid_input")
            definition = newsletter_workflow_definition.parse_definition(
                self.snapshot(run_id)["definition"]
            )
            specification = next(
                item for item in definition.nodes if item.id == node_id
            )
            if specification.map and node["map_expanded"] and not item_id:
                return None
            if any(
                run["nodes"][dependency]["state"] not in SUCCESS_STATES
                for dependency in specification.needs
            ):
                return None
            target = (
                next(
                    (item for item in node["items"] if item["id"] == item_id),
                    None,
                )
                if item_id
                else node
            )
            if target is None or target["state"] != "pending":
                return None
            attempt_id = contracts.content_hash(
                {"run": run_id, "node": node_id, "item": item_id}
            )
            self.store.db.execute(
                (
                    "INSERT INTO workflow_attempts(id,run_id,node_id,item_id,"
                    "state,input_hash,started_at) "
                    "VALUES(?,?,?,?,?,?,?)"
                ),
                (
                    attempt_id,
                    run_id,
                    node_id,
                    item_id,
                    "running",
                    digest,
                    newsletter_store.now(),
                ),
            )
            target["state"] = "running"
            node["state"] = "running"
            self._write(run)
            return attempt_id

    def finish(
        self,
        attempt_id: str,
        state: str,
        value: Any = None,
        error_code: str = "",
    ) -> None:
        """Persist an attempt outcome and advance its aggregate node state."""
        if state not in {*SUCCESS_STATES, "failed", "unknown"} or (
            error_code and error_code not in ERROR_CODES
        ):
            raise WorkflowError("invalid_input")
        finished_state = cast(newsletter_workflow_types.NodeState, state)
        with self.store.transaction():
            attempt = self.store.db.execute(
                "SELECT * FROM workflow_attempts WHERE id=?", (attempt_id,)
            ).fetchone()
            if attempt is None or attempt["state"] != "running":
                raise WorkflowError()
            run = self.get(attempt["run_id"])
            node = run["nodes"][attempt["node_id"]]
            definition = newsletter_workflow_definition.parse_definition(
                self.snapshot(run["id"])["definition"]
            )
            specification = next(
                item
                for item in definition.nodes
                if item.id == attempt["node_id"]
            )
            may_continue = (
                specification.on_error == "continue"
                and error_code not in FATAL_ERROR_CODES
            )
            target = (
                next(
                    item
                    for item in node["items"]
                    if item["id"] == attempt["item_id"]
                )
                if attempt["item_id"]
                else node
            )
            artifact = (
                self._artifact(
                    run["id"], attempt["node_id"], attempt["item_id"], value
                )
                if state in SUCCESS_STATES
                else ""
            )
            target["state"] = finished_state
            target["artifact_id"] = artifact
            target["error_code"] = error_code
            self.store.db.execute(
                (
                    "UPDATE workflow_attempts SET state=?,artifact_"
                    "id=?,error_code=?,finished_at=? WHERE id=?"
                ),
                (
                    state,
                    artifact,
                    error_code,
                    newsletter_store.now(),
                    attempt_id,
                ),
            )
            if attempt["item_id"]:
                if state in {"failed", "unknown"} and not may_continue:
                    node.update(
                        {"state": finished_state, "error_code": error_code}
                    )
                elif all(
                    item["state"] in {*SUCCESS_STATES, "failed", "unknown"}
                    for item in node["items"]
                ):
                    outputs = []
                    for item in node["items"]:
                        if item["state"] == "succeeded":
                            row = self.store.db.execute(
                                (
                                    "SELECT body FROM workflow_artifacts "
                                    "WHERE "
                                    "id=?"
                                ),
                                (item["artifact_id"],),
                            ).fetchone()
                            outputs.append(json.loads(row[0]))
                    node.update(
                        {
                            "state": "succeeded" if outputs else "skipped",
                            "artifact_id": self._artifact(
                                run["id"], attempt["node_id"], "", outputs
                            ),
                            "degraded": any(
                                item["state"] in {"failed", "unknown"}
                                for item in node["items"]
                            ),
                        }
                    )
                    if node["degraded"]:
                        node["error_code"] = "partial_failure"
            elif state in {"failed", "unknown"} and may_continue:
                node.update(
                    {
                        "state": "skipped",
                        "degraded": True,
                        "failure_state": finished_state,
                        "artifact_id": self._artifact(
                            run["id"],
                            attempt["node_id"],
                            "",
                            [] if specification.map else None,
                        ),
                    }
                )
            self._write(run)

    def recover(self) -> int:
        """Recover at startup with exclusive ownership, never during work."""
        with self.store.transaction():
            rows = self.store.db.execute(
                "SELECT * FROM workflow_attempts WHERE state='running'"
            ).fetchall()
            for row in rows:
                run = self.get(row["run_id"])
                node = run["nodes"][row["node_id"]]
                if row["item_id"]:
                    item = next(
                        item
                        for item in node["items"]
                        if item["id"] == row["item_id"]
                    )
                    item.update(
                        {"state": "unknown", "error_code": "interrupted"}
                    )
                node.update({"state": "unknown", "error_code": "interrupted"})
                self.store.db.execute(
                    (
                        "UPDATE workflow_attempts SET state='unknown',e"
                        "rror_code='interrupted',finished_at=? WHERE id"
                        "=?"
                    ),
                    (newsletter_store.now(), row["id"]),
                )
                self._write(run)
            return len(rows)

"""Publish reviewed stories, not an all-or-nothing model-written issue.

Only code-owned, independently reviewed component receipts can admit text to the
edition. The assembler never rewrites claims, turns failed reviews into passes,
or calls a model. Immutable brief/deep results survive a later research failure;
the frozen publication records an explicit disposition for every selected topic.
"""

from __future__ import annotations

from collections.abc import Sequence
import copy
import json
import re
import urllib.parse as parse

import ziyixi_protos.newsletter.editorial_pb2 as editorial_pb2

import newsletter.contracts as contracts
import newsletter.store as newsletter_store
import newsletter.types as types
import newsletter.workflow.components as components

MAX_STORIES = 99
MAX_VERSIONS = 8
MAX_RESULT_BYTES = 4 * 1024 * 1024
_ID = re.compile(contracts.IDENTIFIER_PATTERN + r"\Z")
_HASH = re.compile(r"[0-9a-f]{64}\Z")
_MODES = frozenset({"brief", "deep"})
_RESULT_FIELDS = frozenset(
    {
        "story_id",
        "mode",
        "content",
        "signal",
        "packets",
        "assessments",
        "issues",
        "reason",
        "provenance",
    }
)
_WITHDRAWAL_FIELDS = frozenset(
    {
        "story_id",
        "mode",
        "content_hash",
        "affected_signal_hash",
        "claim",
        "reason",
        "evidence",
        "searched",
        "opened",
        "opened_urls",
        "writer_job_id",
        "reviewer_job_id",
    }
)


class PublicationError(ValueError):
    """Emit finite diagnostics without model text or upstream errors."""

    def __init__(self, code: str = "invalid_publication_result") -> None:
        self.code = code
        super().__init__(code)


def _stored_object(body: str) -> types.Payload:
    value: object = json.loads(body)
    if not isinstance(value, dict):
        raise PublicationError()
    return value


def _stored_objects(body: str) -> list[types.Payload]:
    values: object = json.loads(body)
    if not isinstance(values, list):
        raise PublicationError()
    objects: list[types.Payload] = []
    for value in values:
        if not isinstance(value, dict):
            raise PublicationError()
        objects.append(value)
    return objects


def _identifier(value: object) -> None:
    if not isinstance(value, str) or not _ID.fullmatch(value):
        raise PublicationError()


def _task(task: types.Payload) -> None:
    try:
        contracts.parse_message(task, editorial_pb2.ResearchTask)
        _identifier(task.get("id"))
        if (
            type(task.get("priority")) is not int
            or not 1 <= task["priority"] <= 100
        ):
            raise PublicationError()
        ids = task.get("candidate_ids")
        if (
            not isinstance(ids, list)
            or len(ids) > 32
            or len(set(ids)) != len(ids)
        ):
            raise PublicationError()
        for value in ids:
            _identifier(value)
        for name in ("question", "why", "evidence_context"):
            if not isinstance(task.get(name), str) or len(task[name]) > 8000:
                raise PublicationError()
        if not task["question"].strip():
            raise PublicationError()
        if (
            not isinstance(task.get("source_urls"), list)
            or len(task["source_urls"]) > 32
        ):
            raise PublicationError()
        for url in task["source_urls"]:
            contracts.validate_public_url(url)
    except PublicationError:
        raise
    except (ValueError, TypeError, KeyError, AttributeError):
        raise PublicationError() from None


def _receipt(
    component: str,
    value: types.Payload,
    result: types.Payload,
    sources: types.Payload,
) -> None:
    references = components.citations(value)
    if not references or any(
        ref not in sources or sources[ref]["access_scope"] == "metadata"
        for ref in references
    ):
        raise PublicationError()
    urls = {parse.urldefrag(sources[ref]["url"])[0] for ref in references}
    digest = contracts.content_hash(value)
    for assessment in result["assessments"]:
        if not isinstance(assessment, dict):
            continue
        if (
            assessment.get("component") != component
            or assessment.get("status") != "approved"
            or assessment.get("content_hash") != digest
            or assessment.get("round") not in {"initial", "repair"}
            or assessment.get("searched") is not True
            or assessment.get("opened") is not True
        ):
            continue
        if any(
            isinstance(issue, dict)
            and issue.get("component") == component
            and issue.get("round") == assessment["round"]
            for issue in result["issues"]
        ):
            continue
        writer, reviewer = (
            assessment.get("writer_job_id"),
            assessment.get("reviewer_job_id"),
        )
        if (
            not isinstance(writer, str)
            or not isinstance(reviewer, str)
            or not _ID.fullmatch(writer)
            or not _ID.fullmatch(reviewer)
            or writer == reviewer
        ):
            continue
        opened = assessment.get("opened_urls")
        if not isinstance(opened, list) or len(opened) > 256:
            continue
        if any(not isinstance(url, str) for url in opened):
            continue
        if urls <= {parse.urldefrag(url)[0] for url in opened}:
            return
    raise PublicationError()


def _validate_withdrawals(
    result: types.Payload, sources: types.Payload
) -> None:
    withdrawals = result.get("withdrawals", [])
    if not isinstance(withdrawals, list) or len(withdrawals) > 1:
        raise PublicationError()
    for item in withdrawals:
        if (
            not isinstance(item, dict)
            or set(item) != _WITHDRAWAL_FIELDS
            or result["mode"] != "deep"
            or item["story_id"] != result["story_id"]
            or item["mode"] != "brief"
            or not isinstance(item["content_hash"], str)
            or not _HASH.fullmatch(item["content_hash"])
            or not isinstance(item["affected_signal_hash"], str)
            or (
                item["affected_signal_hash"]
                and not _HASH.fullmatch(item["affected_signal_hash"])
            )
            or not isinstance(item["claim"], str)
            or not 12 <= len(item["claim"].strip()) <= 2000
            or not isinstance(item["reason"], str)
            or not item["reason"].strip()
            or len(item["reason"]) > 2000
            or item["searched"] is not True
            or item["opened"] is not True
        ):
            raise PublicationError()
        _identifier(item["writer_job_id"])
        _identifier(item["reviewer_job_id"])
        if item["writer_job_id"] == item["reviewer_job_id"]:
            raise PublicationError()
        if not any(
            isinstance(assessment, dict)
            and assessment.get("round") == "initial"
            and assessment.get("reviewer_job_id") == item["reviewer_job_id"]
            for assessment in result["assessments"]
        ):
            raise PublicationError()
        evidence, opened = item["evidence"], item["opened_urls"]
        if (
            not isinstance(evidence, list)
            or not 1 <= len(evidence) <= 32
            or any(not isinstance(ref, str) for ref in evidence)
            or len(set(evidence)) != len(evidence)
            or not isinstance(opened, list)
            or len(opened) > 256
            or any(not isinstance(url, str) for url in opened)
            or any(
                ref not in sources or sources[ref]["access_scope"] == "metadata"
                for ref in evidence
            )
        ):
            raise PublicationError()
        if not {
            parse.urldefrag(sources[ref]["url"])[0] for ref in evidence
        } <= {parse.urldefrag(url)[0] for url in opened}:
            raise PublicationError()


def _withdrawn(
    results: Sequence[types.Payload],
) -> tuple[dict[str, set[str]], dict[str, set[str]]]:
    """Invalidate exact old components using an evidence-backed correction."""
    bodies: dict[str, set[str]] = {}
    signals: dict[str, set[str]] = {}
    prior_bodies: dict[tuple[str, str], list[types.Payload]] = {}
    for prior in results:
        if prior["mode"] == "brief" and prior["content"] is not None:
            key = (
                prior["story_id"],
                contracts.content_hash(
                    components.body_content(prior["content"], copy_values=False)
                ),
            )
            prior_bodies.setdefault(key, []).append(prior)
    for result in results:
        for item in result.get("withdrawals", []):
            for prior in prior_bodies.get(
                (item["story_id"], item["content_hash"]), []
            ):
                content = prior["content"]
                if not any(
                    item["claim"] in paragraph["text"]
                    for paragraph in content["paragraphs"]
                ) or not any(
                    isinstance(assessment, dict)
                    and assessment.get("component") == "body"
                    and assessment.get("status") == "approved"
                    and assessment.get("content_hash") == item["content_hash"]
                    and assessment.get("writer_job_id") == item["writer_job_id"]
                    for assessment in prior["assessments"]
                ):
                    continue
                signal = prior["signal"]
                if item["affected_signal_hash"] and (
                    signal is None
                    or contracts.content_hash(signal)
                    != item["affected_signal_hash"]
                ):
                    continue
                bodies.setdefault(item["story_id"], set()).add(
                    item["content_hash"]
                )
                if item["affected_signal_hash"]:
                    signals.setdefault(item["story_id"], set()).add(
                        item["affected_signal_hash"]
                    )
    return bodies, signals


def _available(
    result: types.Payload, field: str, withdrawn: dict[str, set[str]]
) -> bool:
    content = result[field]
    return content is not None and contracts.content_hash(
        components.body_content(content, copy_values=False)
        if field == "content"
        else content
    ) not in withdrawn.get(result["story_id"], set())


def validate_result(result: types.Payload) -> None:
    """Check exact content/packet bindings, not model approval alone.

    These receipts are generated by the trusted StoryEditor from separate writer
    and reviewer calls and observed search/open events. They are an internal
    boundary, not a public API accepting caller-supplied certificates of truth.
    """
    try:
        if (
            not isinstance(result, dict)
            or not set(result) >= _RESULT_FIELDS
            or set(result) - (_RESULT_FIELDS | {"withdrawals"})
            or result.get("mode") not in _MODES
            or not isinstance(result.get("reason"), str)
            or not result["reason"].strip()
            or len(result["reason"]) > 4000
            or len(contracts.canonical_json(result).encode()) > MAX_RESULT_BYTES
        ):
            raise PublicationError()
        _identifier(result["story_id"])
        packets = result["packets"]
        if (
            not isinstance(packets, list)
            or len(packets) > contracts.MAX_PACKETS
        ):
            raise PublicationError()
        if result["provenance"] != {
            "packets_hash": contracts.content_hash(packets)
        }:
            raise PublicationError()
        for name in ("assessments", "issues"):
            if not isinstance(result[name], list) or len(result[name]) > 64:
                raise PublicationError()
        sources: types.Payload = {}
        packet_ids: set[str] = set()
        for packet in packets:
            contracts.parse_message(packet, editorial_pb2.Packet)
            _identifier(packet["id"])
            if packet["id"] in packet_ids:
                raise PublicationError()
            packet_ids.add(packet["id"])
            contracts.validate_packet_body(packet["content"])
            if packet["content_hash"] != contracts.content_hash(
                packet["content"]
            ):
                raise PublicationError()
            for source in packet["content"]["sources"]:
                sources[packet["id"] + "/" + source["id"]] = source
        _validate_withdrawals(result, sources)
        _validate_components(result, sources)
    except PublicationError:
        raise
    except (
        ValueError,
        TypeError,
        KeyError,
        RecursionError,
        OverflowError,
        AttributeError,
    ):
        raise PublicationError() from None


def _validate_components(result: types.Payload, sources: types.Payload) -> None:
    packets = result["packets"]
    for name in ("content", "signal"):
        content = result[name]
        if content is None:
            continue
        # Shared protobuf owns the public shape; this module only adds trust
        # and admission constraints. Preserve exact submitted bytes for hash.
        contracts.parse_message(content, editorial_pb2.StoryContent)
        if content["story_id"] != result["story_id"]:
            raise PublicationError()
        contracts.validate_draft(
            components.validation_draft(
                content, subject="每日简报", title="每日简报"
            ),
            packets,
        )
        if any(
            not paragraph["citations"] for paragraph in content["paragraphs"]
        ):
            raise PublicationError()
        if name == "signal":
            if any(key in content for key in components.OPTIONAL_COMPONENTS):
                raise PublicationError()
            _receipt("signal", content, result, sources)
        else:
            _receipt(
                "body",
                components.body_content(content, copy_values=False),
                result,
                sources,
            )
            for field, component in (
                ("recommended_reading", "reading"),
                ("chart", "chart"),
            ):
                if field in content:
                    _receipt(component, content[field], result, sources)


def _merge_packets(chosen: Sequence[types.Payload]) -> list[types.Payload]:
    by_id: types.Payload = {}
    for choice in chosen:
        refs = components.citations(choice["content"])
        wanted = {reference.split("/", 1)[0] for reference in refs}
        for packet in choice["result"]["packets"]:
            if packet["id"] not in wanted:
                continue
            if packet["id"] in by_id and by_id[packet["id"]] != packet:
                raise PublicationError("conflicting_publication_evidence")
            by_id[packet["id"]] = packet
    if len(by_id) > contracts.MAX_PACKETS:
        raise PublicationError("publication_capacity")
    return list(by_id.values())


def _section(content: types.Payload) -> types.Payload:
    return {
        "kind": content["kind"],
        "heading": content["title"],
        "paragraphs": copy.deepcopy(content["paragraphs"]),
        "limitations": content["limitations"],
    }


def _draft(choices: Sequence[types.Payload], issue_date: str) -> types.Payload:
    # Topic identity is independent of publication depth: an AI brief is not
    # world news, and a world deep-dive is not automatically a research paper.
    # Each reviewed title/body/limitation stays together in its own section.
    # Preserve priority order and the reviewed kind; never infer it from a
    # title.
    sections = [_section(item["content"]) for item in choices]
    draft: types.Payload = {
        "subject": f"每日简报 · {issue_date}",
        "title": "每日简报",
        "introduction": "从已核实的信息开始，重要的进展持续跟进。",
        "sections": sections,
        "limitations": "",
    }
    # An optional component can never veto its story. Only the first
    # independently
    # approved extra is displayed; every story body itself remains complete.
    for name in components.OPTIONAL_COMPONENTS:
        for choice in choices:
            if name in choice["content"]:
                draft[name] = copy.deepcopy(choice["content"][name])
                break
    return draft


def _group_results(
    tasks: Sequence[types.Payload], results: Sequence[types.Payload]
) -> tuple[dict[str, dict[str, list[types.Payload]]], set[str]]:
    """Group immutable versions and retain invalid-topic diagnostics."""
    by_task: dict[str, dict[str, list[types.Payload]]] = {}
    invalid: set[str] = set()
    for task in tasks:
        _task(task)
        if task["id"] in by_task:
            raise PublicationError()
        by_task[task["id"]] = {}
    for result in results:
        if (
            not isinstance(result, dict)
            or result.get("story_id") not in by_task
        ):
            raise PublicationError()
        story_id = result["story_id"]
        try:
            validate_result(result)
        except PublicationError:
            invalid.add(story_id)
            continue
        mode = result["mode"]
        mode_versions = by_task[story_id].setdefault(mode, [])
        if result not in mode_versions:
            mode_versions.append(result)
        if len(mode_versions) > MAX_VERSIONS:
            raise PublicationError("publication_capacity")
    return by_task, invalid


def assemble(
    run_id: str,
    issue_date: str,
    tasks: Sequence[types.Payload],
    results: Sequence[types.Payload],
    *,
    max_features: int = 2,
    reason: str = "completed",
) -> types.Payload:
    """Freeze the best approved topic forms without creating new claims."""
    _identifier(run_id)
    contracts.validate_issue_date(issue_date)
    if (
        len(tasks) > MAX_STORIES
        or type(max_features) is not int
        or not 0 <= max_features <= 2
        or not isinstance(reason, str)
        or not reason.strip()
        or len(reason) > 2000
        or len(results) > MAX_STORIES * 2 * MAX_VERSIONS
    ):
        raise PublicationError()
    if not tasks:
        if results:
            raise PublicationError()
        raise PublicationError("no_publishable_content")
    by_task, invalid = _group_results(tasks, results)
    ordered = sorted(
        enumerate(tasks), key=lambda item: (item[1]["priority"], item[0])
    )
    choices: list[types.Payload] = []
    coverage: list[types.Payload] = []
    withdrawn_bodies, withdrawn_signals = _withdrawn(
        [
            version
            for modes in by_task.values()
            for versions in modes.values()
            for version in versions
        ]
    )
    feature_count = 0
    for _, task in ordered:
        versions = by_task[task["id"]]
        options: list[tuple[str, types.Payload, types.Payload]] = []
        deeps = list(reversed(versions.get("deep", [])))
        briefs = list(reversed(versions.get("brief", [])))
        if feature_count < max_features:
            options.extend(
                ("deep", result["content"], result)
                for result in deeps
                if _available(result, "content", withdrawn_bodies)
            )
        options.extend(
            ("brief", result["content"], result)
            for result in briefs
            if _available(result, "content", withdrawn_bodies)
        )
        options.extend(
            ("watch", result["signal"], result)
            for result in [*briefs, *deeps]
            if _available(result, "signal", withdrawn_signals)
        )
        admitted: types.Payload | None = None
        capacity = feature_count >= max_features and any(
            result["content"] for result in deeps
        )
        for disposition, content, result in options:
            choice = {
                "disposition": disposition,
                "content": content,
                "result": result,
            }
            try:
                candidate_choices = [*choices, choice]
                packets = _merge_packets(candidate_choices)
                contracts.validate_draft(
                    _draft(candidate_choices, issue_date), packets
                )
            except (ValueError, TypeError, KeyError):
                capacity = True
                continue
            admitted = choice
            choices.append(choice)
            feature_count += disposition == "deep"
            break
        if admitted:
            disposition = admitted["disposition"]
            title = admitted["content"]["title"]
            explanation = {
                "deep": "独立核验通过，完整解读已发布。",
                "brief": (
                    "已发布独立核验的简讯；未完成或未采用的深读不阻塞本期。"
                ),
                "watch": "已发布独立核验的事件与边界，核心结论继续跟进。",
            }[disposition]
        else:
            disposition, title = "deferred", task["question"][:300]
            if task["id"] in withdrawn_bodies:
                explanation = (
                    "先前简讯存在经独立核实的明确事实错误，已撤回对"
                    "应正文；此选题保留继续跟进。"
                )
            elif capacity:
                explanation = (
                    "已核实内容超出本期容量，完整保留至后续选题，不"
                    "裁剪已审正文。"
                )
            elif task["id"] in invalid:
                explanation = "审核凭证不完整，未发布未经独立核验的内容。"
            else:
                explanation = (
                    "截至编排时没有独立核验通过的正文或观察短讯，保"
                    "留选题继续跟进。"
                )
        coverage.append(
            {
                "story_id": task["id"],
                "title": title,
                "candidate_ids": list(task["candidate_ids"]),
                "disposition": disposition,
                "reason": explanation,
                "priority": task["priority"],
            }
        )
    if not choices:
        raise PublicationError("no_publishable_content")
    packets = _merge_packets(choices)
    draft = _draft(choices, issue_date)
    deferred = sum(story["disposition"] == "deferred" for story in coverage)
    if deferred:
        # Capacity and an evidence-backed withdrawal also defer a topic; do not
        # falsely describe every omission as a research failure or name its
        # claims.
        draft["introduction"] = (
            f"本期采用已完成独立核验的内容；另有 {deferred} "
            "个入选选题暂未刊出，已保留继续跟进。"
        )
    elif reason != "completed":
        draft["introduction"] = (
            "本期采用已完成独立核验的内容；尚未完成的深入调查继续跟进。"
        )
    contracts.validate_draft(draft, packets)
    summary = {
        "mode": "complete"
        if not deferred and reason == "completed"
        else "partial",
        "reason": reason,
        "stories": coverage,
    }
    return {
        "draft": draft,
        "review": {
            "passed": True,
            "findings": [
                "代码拼版：仅采用与独立核验凭证及证据快照精确匹配的内容；"
                "每个入选选题均记录发布形态或暂缓原因。"
            ],
        },
        "packets": packets,
        "coverage": summary,
        "notion_required": False,
    }


class PublicationRepository:
    """Store append-only approved-content and publication ledgers."""

    def __init__(self, store: newsletter_store.Store) -> None:
        self.store = store
        with store.lock:
            store.db.executescript(
                "\n"
                "                CREATE TABLE IF NOT EXISTS pub"
                "lication_units (\n"
                "                    run_id TEXT NOT NULL, stor"
                "y_id TEXT NOT NULL, mode TEXT NOT NULL,\n"
                "                    issue_date TEXT NOT NULL, "
                "task TEXT NOT NULL, body TEXT NOT NULL,\n"
                "                    digest TEXT NOT NULL, crea"
                "ted_at TEXT NOT NULL,\n"
                "                    PRIMARY KEY(run_id,story_i"
                "d,mode,digest));\n"
                "                CREATE TABLE IF NOT EXISTS pub"
                "lication_plans (\n"
                "                    run_id TEXT PRIMARY KEY, i"
                "ssue_date TEXT NOT NULL,\n"
                "                    tasks TEXT NOT NULL, diges"
                "t TEXT NOT NULL, created_at TEXT NOT NULL);\n"
                "                CREATE TABLE IF NOT EXISTS pub"
                "lication_snapshots (\n"
                "                    run_id TEXT PRIMARY KEY, i"
                "ssue_date TEXT NOT NULL,\n"
                "                    tasks TEXT NOT NULL, body "
                "TEXT NOT NULL, digest TEXT NOT NULL,\n"
                "                    created_at TEXT NOT NULL);"
                "\n"
                "            "
            )

    def save_plan(
        self, run_id: str, issue_date: str, tasks: Sequence[types.Payload]
    ) -> list[types.Payload]:
        """Record selected topics even if no model attempt completes."""
        _identifier(run_id)
        contracts.validate_issue_date(issue_date)
        if len(tasks) > MAX_STORIES:
            raise PublicationError()
        for task in tasks:
            _task(task)
        if len({task["id"] for task in tasks}) != len(tasks):
            raise PublicationError()
        body = contracts.canonical_json(list(tasks))
        if len(body.encode()) > contracts.MAX_MESSAGE_BYTES:
            raise PublicationError("publication_capacity")
        digest = contracts.content_hash(
            {"issue_date": issue_date, "tasks": list(tasks)}
        )
        with self.store.transaction():
            previous = self.store.db.execute(
                "SELECT digest,tasks FROM publication_plans WHERE run_id=?",
                (run_id,),
            ).fetchone()
            if previous:
                if previous["digest"] != digest:
                    raise newsletter_store.StoreError(
                        "conflict", "Frozen publication plan cannot change"
                    )
                return _stored_objects(previous["tasks"])
            by_id = {
                task["id"]: contracts.canonical_json(task) for task in tasks
            }
            rows = self.store.db.execute(
                (
                    "SELECT story_id,issue_date,task FROM publication_units "
                    "WHERE run_id=?"
                ),
                (run_id,),
            ).fetchall()
            if any(
                row["issue_date"] != issue_date
                or by_id.get(row["story_id"]) != row["task"]
                for row in rows
            ):
                raise newsletter_store.StoreError(
                    "conflict",
                    "Publication plan conflicts with existing results",
                )
            self.store.db.execute(
                "INSERT INTO publication_plans VALUES(?,?,?,?,?)",
                (run_id, issue_date, body, digest, newsletter_store.now()),
            )
        return _stored_objects(body)

    def save(
        self,
        run_id: str,
        task: types.Payload,
        mode: str,
        result: types.Payload,
        *,
        issue_date: str,
    ) -> types.Payload:
        """Append a validated story checkpoint or replay its receipt."""
        _identifier(run_id)
        _task(task)
        contracts.validate_issue_date(issue_date)
        validate_result(result)
        if (
            mode not in _MODES
            or result["mode"] != mode
            or result["story_id"] != task["id"]
        ):
            raise PublicationError()
        body, task_body = (
            contracts.canonical_json(result),
            contracts.canonical_json(task),
        )
        digest = contracts.content_hash(
            {"issue_date": issue_date, "task": task, "result": result}
        )
        with self.store.transaction():
            row = self.store.db.execute(
                "SELECT digest,body FROM publication_units "
                "WHERE run_id=? AND story_id=? AND mode=? AND digest=?",
                (run_id, task["id"], mode, digest),
            ).fetchone()
            if row is not None:
                return _stored_object(row["body"])
            if self.store.db.execute(
                "SELECT 1 FROM publication_snapshots WHERE run_id=?", (run_id,)
            ).fetchone():
                raise newsletter_store.StoreError(
                    "conflict", "Published content snapshot is already frozen"
                )
            plan = self.store.db.execute(
                "SELECT issue_date,tasks FROM publication_plans WHERE run_id=?",
                (run_id,),
            ).fetchone()
            if plan is not None and (
                plan["issue_date"] != issue_date
                or task not in json.loads(plan["tasks"])
            ):
                raise newsletter_store.StoreError(
                    "conflict",
                    "Result is not part of the frozen publication plan",
                )
            siblings = self.store.db.execute(
                (
                    "SELECT story_id,issue_date,task,mode FROM "
                    "publication_units WHERE "
                    "run_id=?"
                ),
                (run_id,),
            ).fetchall()
            if any(
                row["issue_date"] != issue_date
                or (row["story_id"] == task["id"] and row["task"] != task_body)
                for row in siblings
            ):
                raise newsletter_store.StoreError(
                    "conflict", "Publication task identity cannot change"
                )
            if (
                len({row["story_id"] for row in siblings} | {task["id"]})
                > MAX_STORIES
            ):
                raise PublicationError("publication_capacity")
            if (
                sum(
                    row["story_id"] == task["id"] and row["mode"] == mode
                    for row in siblings
                )
                >= MAX_VERSIONS
            ):
                raise PublicationError("publication_capacity")
            self.store.db.execute(
                "INSERT INTO publication_units VALUES(?,?,?,?,?,?,?,?)",
                (
                    run_id,
                    task["id"],
                    mode,
                    issue_date,
                    task_body,
                    body,
                    digest,
                    newsletter_store.now(),
                ),
            )
        return _stored_object(body)

    def plan(self, run_id: str) -> list[types.Payload]:
        """Read all selected topics, including never-started items."""
        _identifier(run_id)
        with self.store.lock:
            row = self.store.db.execute(
                "SELECT tasks FROM publication_plans WHERE run_id=?", (run_id,)
            ).fetchone()
        return json.loads(row["tasks"]) if row else []

    def results(self, run_id: str) -> list[types.Payload]:
        """Read story checkpoints in their persisted admission order."""
        _identifier(run_id)
        with self.store.lock:
            rows = self.store.db.execute(
                (
                    "SELECT body FROM publication_units WHERE run_id=? ORDER "
                    "BY rowid"
                ),
                (run_id,),
            ).fetchall()
        return [json.loads(row["body"]) for row in rows]

    def best_result(
        self, run_id: str, story_id: str, mode: str = "brief"
    ) -> types.Payload | None:
        """Prefer an approved body over a signal or a later failed job."""
        _identifier(story_id)
        if mode not in _MODES:
            raise PublicationError()
        valid = []
        for result in self.results(run_id):
            if result.get("story_id") != story_id:
                continue
            try:
                validate_result(result)
            except PublicationError:
                continue
            valid.append(result)
        bodies, signals = _withdrawn(valid)
        best: types.Payload | None = None
        score = 0
        for result in valid:
            if result["mode"] != mode:
                continue
            body_ok, signal_ok = (
                _available(result, "content", bodies),
                _available(result, "signal", signals),
            )
            if body_ok:
                value = 2
            elif signal_ok:
                value = 1
            else:
                value = 0
            if value and value >= score:
                best, score = result, value
                if not body_ok:
                    best["content"] = None
                if not signal_ok:
                    best["signal"] = None
        return best

    def get_publication(self, run_id: str) -> types.Payload | None:
        """Read the first frozen publication, if one has been recorded."""
        _identifier(run_id)
        with self.store.lock:
            row = self.store.db.execute(
                "SELECT body FROM publication_snapshots WHERE run_id=?",
                (run_id,),
            ).fetchone()
        return _stored_object(row["body"]) if row else None

    def record_publication(
        self,
        run_id: str,
        issue_date: str,
        tasks: Sequence[types.Payload],
        assembled: types.Payload,
    ) -> types.Payload:
        """Freeze a reconstruction from immutable accepted receipts."""
        _identifier(run_id)
        contracts.validate_issue_date(issue_date)
        self.save_plan(run_id, issue_date, tasks)
        body, task_body = (
            contracts.canonical_json(assembled),
            contracts.canonical_json(list(tasks)),
        )
        digest = contracts.content_hash(
            {
                "issue_date": issue_date,
                "tasks": list(tasks),
                "result": assembled,
            }
        )
        if len(body.encode()) > contracts.MAX_MESSAGE_BYTES:
            raise PublicationError("publication_capacity")
        with self.store.transaction():
            row = self.store.db.execute(
                "SELECT digest,body FROM publication_snapshots WHERE run_id=?",
                (run_id,),
            ).fetchone()
            if row is not None:
                if row["digest"] != digest:
                    raise newsletter_store.StoreError(
                        "conflict", "Frozen publication snapshot cannot change"
                    )
                # A persisted layout is authoritative across renderer/assembler
                # upgrades. Verify its exact receipt, not today's layout rules;
                # otherwise a restart could rewrite or reject an older issue.
                return _stored_object(row["body"])
            reason = assembled.get("coverage", {}).get("reason")
            max_features = sum(
                story["disposition"] == "deep"
                for story in assembled.get("coverage", {}).get("stories", [])
            )
            expected = assemble(
                run_id,
                issue_date,
                tasks,
                self.results(run_id),
                max_features=max_features,
                reason=reason,
            )
            if expected != assembled:
                raise PublicationError("invalid_publication_snapshot")
            self.store.db.execute(
                "INSERT INTO publication_snapshots VALUES(?,?,?,?,?,?)",
                (
                    run_id,
                    issue_date,
                    task_body,
                    body,
                    digest,
                    newsletter_store.now(),
                ),
            )
        return _stored_object(body)

    def pending_history(
        self, issue_date: str, limit: int = 30
    ) -> list[types.Payload]:
        """Carry unresolved topics forward without recycling published claims.

        A later publication of the same story/candidate supersedes its earlier
        disposition. History supplies research context, not evidence itself.
        """
        contracts.validate_issue_date(issue_date)
        if type(limit) is not int or not 1 <= limit <= MAX_STORIES:
            raise PublicationError()
        with self.store.lock:
            rows = self.store.db.execute(
                (
                    "SELECT p.issue_date,p.tasks,s.body,e.body AS e"
                    "dition,COALESCE(d.edition_id,v.edition_id) AS "
                    "attempted FROM publication_plans p LEFT JOIN p"
                    "ublication_snapshots s ON p.run_id=s.run_id LE"
                    "FT JOIN workflow_editions w ON w.run_id=p.run_"
                    "id LEFT JOIN editions e ON e.id=w.edition_id L"
                    "EFT JOIN sends d ON d.edition_id=e.id LEFT JOI"
                    "N verification_sends v ON v.edition_id=e.id WH"
                    "ERE p.issue_date<? ORDER BY p.issue_date DESC,"
                    "p.rowid DESC LIMIT 120"
                ),
                (issue_date,),
            ).fetchall()
        seen: set[str] = set()
        pending = []
        for row in rows:
            delivery = (
                json.loads(row["edition"])["delivery_state"]
                if row["edition"]
                else "not_requested"
            )
            accepted = bool(row["attempted"]) and delivery in {
                "provider_accepted",
                "simulated",
            }
            tasks = {task["id"]: task for task in json.loads(row["tasks"])}
            stories = (
                json.loads(row["body"])["coverage"]["stories"]
                if row["body"] is not None
                else [
                    {
                        "story_id": task["id"],
                        "title": task["question"][:300],
                        "candidate_ids": task["candidate_ids"],
                        "disposition": "deferred",
                        "reason": (
                            "此选题尚无冻结的可发布版本，继续核验；历史任务"
                            "本身不是证据。"
                        ),
                    }
                    for task in tasks.values()
                ]
            )
            for story in stories:
                keys = {"story:" + story["story_id"]} | {
                    "candidate:" + value for value in story["candidate_ids"]
                }
                duplicate = bool(keys & seen)
                seen.update(keys)
                if duplicate or (story["disposition"] == "deep" and accepted):
                    continue
                if story["disposition"] == "deep":
                    story = {
                        **story,
                        "disposition": "deferred",
                        "reason": (
                            (
                                "该深读已有冻结版本，"
                                "但发送状态尚未确认；先核对投递结果，"
                                "再调查新进展，勿自动重发原稿。"
                            )
                            if delivery in {"unknown", "submitting"}
                            else (
                                "该深读已有冻结版本，但邮件服务尚未确认接收；继"
                                "续调查新进展，勿自动重发原稿。"
                            )
                        ),
                    }
                task = tasks[story["story_id"]]
                pending.append(
                    {
                        **copy.deepcopy(task),
                        "story_id": story["story_id"],
                        "title": story["title"],
                        "issue_date": row["issue_date"],
                        "disposition": story["disposition"],
                        "reason": story["reason"],
                    }
                )
        return sorted(pending, key=lambda item: item["priority"])[:limit]

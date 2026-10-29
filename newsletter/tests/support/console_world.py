"""A synthetic Newsletter database and content configuration for the console.

Every value is invented: no production row, address or credential. The world
mirrors what the engine's own tables hold for one late-October week, written
with the engine's schema (the real repositories create the tables) and fixed
times, so the console's answers are the same bytes on every machine:

- 10-24, 10-25 and 10-27: scheduled runs whose editions were delivered;
- 10-26: a fixture edition of a manual run;
- 10-27: also a correction sent the next night;
- 10-28: the selection node ran past the 150 seconds its run froze, its model
  turn never answered, and the run stopped with nothing publishable (the
  run's model calls predate start times and purposes);
- 10-29: the scheduled run (budget 420) delivered, its Notion copy still
  being written, and a manual test run.

Between them the editions hold every Notion copy state but DISABLED, which a
world without the backup (``notion=False``) shows.
"""

from __future__ import annotations

import base64
import dataclasses
import datetime
import hashlib
import json
import pathlib
from typing import Any

import newsletter.collection.repository as repository
import newsletter.console_read as console_read
import newsletter.content_config as content_config
import newsletter.contracts as contracts
import newsletter.notion_journal as notion_journal
import newsletter.settings as newsletter_settings
import newsletter.store as newsletter_store
import newsletter.workflow.definition as definition
import newsletter.workflow.publication as publication
import newsletter.workflow.repository as workflow_repository
import newsletter.workflow.state as workflow_state
import newsletter.workflow.story_replay_repository as replays

Payload = dict[str, Any]
NOW = datetime.datetime(2026, 10, 29, 16, 30, tzinfo=datetime.UTC)
TIME_ZONE = "America/Los_Angeles"
MODEL = "gpt-6.1-sol"
REPORTED = "gpt-6.1-sol-2026-10-01"
OLD_REVISION = "0123456789abcdef0123456789abcdef01234567"
NEW_REVISION = "89abcdef0123456789abcdef0123456789abcdef"
# A 1x1 PNG: the console passes the frozen chart through, never draws it.
PNG = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGA"
    "WjR9awAAAABJRU5ErkJggg=="
)
RECIPE = """version: 1
id: daily-topics
nodes:
  - id: history
    type: history
  - id: feeds
    type: api_feed
    on_error: continue
    params: {{timeout_seconds: 180}}
  - id: discovery
    type: discovery
    on_error: continue
    needs: [history, feeds]
    map: {{from: run.instructions, max_items: 8}}
    params: {{timeout_seconds: 240}}
  - id: candidates
    type: deduplicate
    needs: [history, feeds, discovery]
    params: {{max_candidates: 30}}
  - id: selection
    type: selection
    needs: [history, candidates]
    params: {{max_tasks: 8, timeout_seconds: {selection}}}
  - id: story_plan
    type: story_plan
    needs: [history, candidates, selection]
    params: {{max_deep: 4}}
  - id: briefs
    type: story_brief
    on_error: continue
    needs: [history, candidates, story_plan]
    map: {{from: story_plan.brief_tasks, max_items: 12}}
    params: {{timeout_seconds: 300}}
  - id: deep
    type: story_deep
    on_error: continue
    needs: [history, candidates, story_plan, briefs]
    map: {{from: story_plan.deep_tasks, max_items: 4}}
    params: {{timeout_seconds: 420}}
  - id: publish
    type: publish
    needs: [story_plan, briefs, deep]
"""
REGISTRY = """version: 1
sources:
  - id: synthetic-ml-feed
    name: Synthetic ML Notes
    direction: 01-ai-ml
    kind: feed
    url: "https://example.org/ml.xml"
  - id: synthetic-arxiv
    name: arXiv
    direction: 01-ai-ml
    kind: arxiv
    url: "https://export.arxiv.org/api/query"
    query: "cat:cs.LG"
    max_seeds: 3
  - id: synthetic-world-feed
    name: Synthetic World Wire
    direction: 03-world
    kind: feed
    url: "https://example.com/world.xml"
  - id: synthetic-paused-feed
    name: Synthetic Paused
    direction: 03-world
    kind: feed
    url: "https://example.net/paused.xml"
    enabled: false
"""
DIRECTIONS = {
    "01-ai-ml": "# AI / ML 候选发现\n\n合成方向：只用于控制台测试。\n",
    "03-world": "# 世界简报\n\n合成方向：只用于控制台测试。\n",
}


def uid(number: int) -> str:
    """A fixed version-4 UUID per synthetic record."""
    return f"00000000-0000-4000-8000-{number:012d}"


def at(text: str) -> str:
    """A UTC time as the store writes it (microseconds, +00:00)."""
    moment = datetime.datetime.fromisoformat(text).replace(tzinfo=datetime.UTC)
    return moment.isoformat(timespec="microseconds")


def epoch(text: str) -> float:
    """A UTC time as the Notion journal and the config sync write it."""
    return (
        datetime.datetime.fromisoformat(text)
        .replace(tzinfo=datetime.UTC)
        .timestamp()
    )


RUN_24, RUN_25, RUN_26, RUN_27, RUN_28, RUN_29, RUN_29M = (
    uid(n) for n in (2400, 2500, 2600, 2700, 2800, 2900, 2901)
)
EDITION_24, EDITION_25, EDITION_26, EDITION_27, EDITION_29, EDITION_29M = (
    uid(n) for n in (24, 25, 26, 27, 29, 291)
)
CORRECTION_27 = uid(271)


def recipe(selection: int) -> Payload:
    """The frozen graph, with the selection budget of its day."""
    loaded = definition.load_definition(RECIPE.format(selection=selection))
    return loaded.snapshot()


def bundle() -> Payload:
    """A valid synthetic content-config bundle at NEW_REVISION."""
    packaged = content_config.packaged_snapshot()["files"]
    files = {
        "editorial.yaml": "max_public_items: 6\nmax_research_items: 1\n"
        "max_deep: 1\nmax_research_candidates: 10\n",
        "workflow.yaml": RECIPE.format(selection=420),
        "policy/editorial.md": "合成编辑规则。\n",
        "policy/reader-profile.md": "合成读者画像。\n",
        "prompts/discovery.md": "合成搜集提示。\n",
        "prompts/selection.md": "合成选题提示。\n",
        # The one packaged file: a template must pass the renderer's checks.
        "templates/edition.html.j2": packaged["templates/edition.html.j2"],
        "researcher.yaml": REGISTRY,
        **{f"discovery/{key}.md": text for key, text in DIRECTIONS.items()},
    }
    return content_config.build_snapshot(files, NEW_REVISION)


def install_config(root: pathlib.Path) -> Payload:
    """The active bundle and a sync that last checked ten minutes ago."""
    snapshot = bundle()
    content_config.install_snapshot(root, snapshot)
    status = {
        "last_attempt": epoch("2026-10-29T16:20:00"),
        "last_success": epoch("2026-10-29T16:20:00"),
        "error": None,
        "wanted_commit": NEW_REVISION,
        "wanted_revision": NEW_REVISION,
        "wanted_digest": snapshot["digest"],
        "repository": "ziyixi/newsletter",
    }
    (root / "sync-status.json").write_text(json.dumps(status))
    return snapshot


@dataclasses.dataclass
class World:
    """The synthetic world's settings, reader and open store."""

    settings: newsletter_settings.Settings
    reader: console_read.ConsoleReader
    store: newsletter_store.Store

    def close(self) -> None:
        """Close the writer's connection (the reader opens its own)."""
        self.store.close()


def build(root: pathlib.Path, *, notion: bool = True) -> World:
    """Write the world under ``root`` and return a reader of it at NOW."""
    # The configuration refuses symlinked ancestors (macOS's /var is one).
    root = root.resolve()
    data = root / "data"
    config = root / "config"
    data.mkdir(parents=True)
    install_config(config)
    settings = newsletter_settings.Settings(
        data_dir=data,
        mode="live",
        time_zone=TIME_ZONE,
        notion_backend="notion" if notion else "disabled",
        notion_archive_private=False,
        todofy_backend="todofy",
        content_config_dir=config,
    )
    store = newsletter_store.Store(data / "newsletter.sqlite3", "live")
    # The engine's own repositories create every table the console reads.
    repository.RunRepository(store)
    workflow_repository.WorkflowRepository(store)
    workflow_state.WorkflowState(store)
    publication.PublicationRepository(store)
    replays.StoryReplayRepository(store)
    notion_journal.NotionJournal(
        store,
        {
            "materials": uid(9001),
            "editions": uid(9002),
            "include_personal": False,
        },
        clock=lambda: epoch("2026-10-29T15:00:00"),
    )
    with store.transaction():
        _Writer(store.db).write()
    return World(
        settings, console_read.ConsoleReader(settings, clock=lambda: NOW), store
    )


def _sources(
    first: str, second: str, *, paper: str = "https://example.org/paper"
) -> list[Payload]:
    return [
        {
            "id": "s1",
            "title": first,
            "url": "https://example.org/report",
            "excerpt": "合成摘录。",
            "access_scope": "abstract",
            "published_at": "2026-10-26",
        },
        {
            "id": "s2",
            "title": second,
            "url": paper,
            "excerpt": "合成摘录。",
            "access_scope": "full_text",
            "published_at": "",
        },
    ]


def packets() -> list[Payload]:
    """The frozen evidence of the 10-27 edition (the citations' sources)."""
    return [
        {
            "id": "packet-world",
            "workflow_id": "",
            "producer_id": "workflow-editor",
            "content_hash": "",
            "created_at": at("2026-10-27T14:10:00"),
            "is_fixture": False,
            "content": {
                "title": "合成材料一",
                "body": "合成材料正文。",
                "sources": _sources("合成报告：港口吞吐", "合成数据集说明"),
                "tags": [],
            },
        },
        {
            "id": "packet-research",
            "workflow_id": "",
            "producer_id": "workflow-editor",
            "content_hash": "",
            "created_at": at("2026-10-27T14:11:00"),
            "is_fixture": False,
            "content": {
                "title": "合成材料二",
                "body": "合成材料正文。",
                "sources": _sources(
                    "合成论文：小模型推理",
                    "合成复现记录",
                    paper="https://example.com/paper",
                ),
                "tags": [],
            },
        },
    ]


def draft(title: str) -> Payload:
    """A full structured body citing both packets, with a chart."""
    return {
        "subject": "视野 · " + title,
        "title": title,
        "introduction": "合成导读：本期两则。\n第二行。",
        "sections": [
            {
                "kind": "world",
                "heading": "合成世界简报",
                "paragraphs": [
                    {
                        "text": "合成段落，含不可信文本 "
                        "<img src=x onerror=alert(1)>。",
                        "citations": [
                            "packet-world/s1",
                            "packet-research/s2",
                        ],
                    }
                ],
                "limitations": "合成边界说明。",
            },
            {
                "kind": "feature",
                "heading": "合成研究进展",
                "paragraphs": [
                    {
                        "text": "合成研究段落。",
                        "citations": ["packet-research/s1"],
                    },
                    {"text": "无引用段落。", "citations": []},
                ],
            },
        ],
        "chart": {
            "kind": "bar",
            "question": "合成问题：吞吐变化？",
            "metric": "吞吐",
            "unit": "万标箱",
            "period": "2026 年 9 月",
            "caption": "合成图注。",
            "alt_text": "合成图表替代文本。",
            "limitations": "合成图表边界。",
            "points": [
                {
                    "label": "甲港",
                    "decimal_value": "12.5",
                    "citations": ["packet-world/s1"],
                },
                {
                    "label": "乙港",
                    "missing_reason": "未公布",
                    "citations": [],
                },
            ],
        },
        "recommended_reading": {
            "citation": "packet-research/s1",
            "reason": "合成推荐理由。",
            "supporting_citations": ["packet-world/s2"],
        },
        "limitations": "合成本期说明。",
    }


def rendered(title: str) -> Payload:
    """A frozen email; the console shows these bytes, it never renders."""
    html = (
        "<!doctype html><html><head><title>" + title + "</title></head><body>"
        "<h1>" + title + "</h1>"
        '<img src="cid:newsletter-chart" alt="合成图表替代文本。" width="580">'
        "<p>TODOFY / 与你有关</p></body></html>"
    )
    text = title + "\n\n合成纯文本。\n"
    payload = json.dumps(
        {"html": html, "text": text, "chart_png": PNG},
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode()
    return {
        "html": html,
        "text": text,
        "chart_png": PNG,
        "render_hash": hashlib.sha256(payload).hexdigest(),
    }


def personal(fetched: str) -> Payload:
    """The private Todofy section (synthetic tasks)."""
    return {
        "state": "current",
        "title": "今天与你有关",
        "summary": "合成个人事项摘要。",
        "items": [
            {"rank": 1, "title": "合成事项一", "detail": "合成说明。"},
            {"rank": 2, "title": "合成事项二", "detail": "合成说明。"},
        ],
        "task_count": 3,
        "time_window_hours": 24,
        "fetched_at": at(fetched),
        "source_label": "Todofy",
        "limitations": "",
        "is_fixture": False,
        "error_code": "",
    }


def call(
    number: int,
    stage: str,
    *,
    status: str = "completed",
    started: str | None = None,
    finished: str | None = None,
    purpose: str | None = None,
    tokens: tuple[int, int, int] | None = (12000, 4000, 900),
    turns: tuple[int, int] = (1, 1),
    partial: bool = False,
    cost: int | None = None,
    failure: str | None = None,
) -> Payload:
    """One model_usage record; without ``started`` it predates S1's keys."""
    record: Payload = {
        "id": uid(5000 + number),
        "provider": "model_router",
        "model": MODEL,
        "stage": stage,
        "thread_id": f"conversations/{uid(6000 + number)}",
        "status": status,
        "usage": None
        if tokens is None
        else {
            "input_tokens": tokens[0],
            "cached_input_tokens": tokens[1],
            "output_tokens": tokens[2],
            "reasoning_output_tokens": 0,
            "total_tokens": tokens[0] + tokens[2],
        },
        "turns_started": turns[0],
        "turns_completed": turns[1],
        "turns_with_usage": turns[1] if tokens else 0,
        "usage_events": turns[1] if tokens else 0,
        "partial": partial,
    }
    if started is None:
        return record
    record.update(
        purpose=purpose or stage.partition(":")[0],
        started_at=at(started),
        requests=[
            {"name": f"requests/{uid(7000 + number)}", "model": REPORTED}
        ][: turns[1]],
        contributing_models=[REPORTED] if turns[1] else [],
        billing_kind="subscription",
    )
    if finished:
        record["finished_at"] = at(finished)
    if cost is not None:
        record["estimated_cost_microusd"] = cost
    if failure:
        record["failure"] = failure
    return record


class _Writer:
    """Insert the world's rows with the schema the repositories created."""

    def __init__(self, db: Any) -> None:
        self.db = db

    def insert(self, table: str, *values: object) -> None:
        marks = ",".join("?" for _ in values)
        self.db.execute(f"INSERT INTO {table} VALUES ({marks})", values)

    def run(
        self,
        run_id: str,
        key: str,
        issue_date: str,
        *,
        state: str,
        created: str,
        updated: str,
        selection: int,
        revision: str,
        edition: str = "",
        error: str = "",
    ) -> Payload:
        body = {
            "id": run_id,
            "issue_date": issue_date,
            "state": state,
            "instructions_hash": "0" * 64,
            # Legacy per-direction states: never shown as live.
            "directions": [],
            "edition_id": edition,
            "error_code": error,
            "created_at": at(created),
            "updated_at": at(updated),
            "is_fixture": False,
        }
        self.insert(
            "collection_runs",
            run_id,
            key,
            "0" * 64,
            state,
            contracts.canonical_json(body),
            "[]",
        )
        graph = recipe(selection)
        inputs = {
            "issue_date": issue_date,
            "instructions": [
                {"id": key_, "text": text, "digest": "0" * 64}
                for key_, text in DIRECTIONS.items()
            ],
            "history": [],
            "pending_stories": [],
            "editions": [],
            "policy": {},
            "started_at": at(created),
            "timeout_seconds": 5400.0,
            "model": MODEL,
            "content_config": {"revision": revision, "digest": "1" * 64},
        }
        snapshot = {"definition": graph, "inputs": inputs}
        self.insert(
            "collection_workflow_snapshots",
            run_id,
            contracts.canonical_json(snapshot),
        )
        return graph

    def workflow(
        self,
        run_id: str,
        created: str,
        nodes: dict[str, Payload],
        attempts: list[tuple[str, str, str, str, str, str]],
    ) -> None:
        """The run's workflow row and its attempts.

        One attempt per (node, item, state, code, started, finished).
        """
        body = {
            "id": run_id,
            "state": "succeeded",
            "definition_hash": "0" * 64,
            "inputs_hash": "0" * 64,
            "created_at": at(created),
            "updated_at": at(created),
            "nodes": nodes,
        }
        self.insert(
            "workflow_runs",
            run_id,
            "0" * 64,
            "{}",
            "0" * 64,
            "{}",
            contracts.canonical_json(body),
        )
        for node, item, state, code, started, finished in attempts:
            self.insert(
                "workflow_attempts",
                hashlib.sha256((run_id + node + item).encode()).hexdigest(),
                run_id,
                node,
                item,
                state,
                "0" * 64,
                "",
                code,
                at(started),
                at(finished) if finished else "",
            )

    def artifact(self, run_id: str, node: str, item: str, body: Any) -> None:
        self.insert(
            "workflow_artifacts",
            hashlib.sha256((run_id + node + item + "a").encode()).hexdigest(),
            run_id,
            node,
            item,
            "0" * 64,
            contracts.canonical_json(body),
            at("2026-10-01T00:00:00"),
        )

    def calls(self, run_id: str, records: list[Payload], updated: str) -> None:
        for record in records:
            self.insert(
                "model_usage",
                record["id"],
                run_id,
                contracts.canonical_json(record),
                at(updated),
            )

    def edition(
        self,
        edition_id: str,
        key: str,
        issue_date: str,
        *,
        created: str,
        updated: str,
        title: str,
        delivery: str,
        run_id: str = "",
        fixture: bool = False,
        full: bool = False,
        error: str = "",
    ) -> Payload:
        body: Payload = {
            "id": edition_id,
            "issue_date": issue_date,
            "state": "ready",
            "packet_ids": [],
            "delivery_state": delivery,
            "created_at": at(created),
            "updated_at": at(updated),
            "is_fixture": fixture,
            "draft": draft(title)
            if full
            else {
                "subject": "视野 · " + title,
                "title": title,
                "introduction": "合成导读。",
                "sections": [
                    {
                        "kind": "world",
                        "heading": "合成标题",
                        "paragraphs": [{"text": "合成段落。", "citations": []}],
                    }
                ],
            },
            "review": {"passed": True, "findings": ["合成审核意见。"]},
            "rendered": rendered(title),
            "provider_message_id": "",
            "error_code": error,
        }
        if full:
            body["personal_digest"] = personal("2026-10-27T14:00:03.25")
            body["usage"] = {
                "usage": {
                    "input_tokens": 61000,
                    "cached_input_tokens": 20000,
                    "output_tokens": 4500,
                    "reasoning_output_tokens": 0,
                    "total_tokens": 65500,
                },
                "invocations": 5,
                "missing_invocations": 0,
                "partial": False,
            }
        self.insert(
            "editions",
            edition_id,
            key,
            "0" * 64,
            "ready",
            contracts.canonical_json(body),
            contracts.canonical_json(packets() if full else []),
        )
        if run_id:
            self.insert("workflow_editions", edition_id, run_id, "{}", "[]", 0)
        return body

    def entity(
        self,
        key: str,
        kind: str,
        *,
        page: str = "",
        create: str = "ready",
        error: str = "",
        retry: float = 0,
        attempts: int = 0,
        progress: float = 0,
        versions: tuple[str, ...] = ("done",),
        title: str = "",
    ) -> None:
        properties = {
            "title": {"title": [{"type": "text", "text": {"content": title}}]}
        }
        self.db.execute(
            "INSERT INTO notion_entities(key,kind,page_id,create_state,"
            "properties,applied_hash,error,retry_at,attempts,progress_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?)",
            (
                key,
                kind,
                page,
                create,
                json.dumps(properties, ensure_ascii=False),
                "",
                error,
                retry,
                attempts,
                progress,
            ),
        )
        for index, state in enumerate(versions):
            self.db.execute(
                "INSERT INTO notion_versions(entity_key,digest,blocks,chart,"
                "state) VALUES (?,?,?,?,?)",
                (key, f"{index:064d}", "[]", "", state),
            )

    def write(self) -> None:
        self._delivered()
        self._fixture()
        self._timeout()
        self._today()
        self._journal()

    def _delivered(self) -> None:
        for run_id, edition_id, day, title in (
            (RUN_24, EDITION_24, "24", "合成期刊 10/24"),
            (RUN_25, EDITION_25, "25", "合成期刊 10/25"),
        ):
            issue = f"2026-10-{day}"
            graph = self.run(
                run_id,
                "daily-" + issue,
                issue,
                state="ready",
                created=f"{issue}T14:00:00",
                updated=f"{issue}T14:30:00",
                selection=150,
                revision=OLD_REVISION,
                edition=edition_id,
            )
            self._succeeded(run_id, issue, graph, legacy=True)
            self.edition(
                edition_id,
                "collection:" + run_id,
                issue,
                created=f"{issue}T14:29:00",
                updated=f"{issue}T14:31:00",
                title=title,
                delivery="provider_accepted",
                run_id=run_id,
            )
        graph = self.run(
            RUN_27,
            "daily-2026-10-27",
            "2026-10-27",
            state="ready",
            created="2026-10-27T14:00:00",
            updated="2026-10-27T14:18:00",
            selection=150,
            revision=OLD_REVISION,
            edition=EDITION_27,
        )
        self._succeeded(RUN_27, "2026-10-27", graph, legacy=False)
        self.edition(
            EDITION_27,
            "collection:" + RUN_27,
            "2026-10-27",
            created="2026-10-27T14:17:00",
            updated="2026-10-27T14:20:12.345678",
            title="合成期刊：港口与小模型",
            delivery="provider_accepted",
            run_id=RUN_27,
            full=True,
        )
        self.insert(
            "publication_snapshots",
            RUN_27,
            "2026-10-27",
            "[]",
            contracts.canonical_json(
                {
                    "coverage": {
                        "mode": "partial",
                        "reason": "completed",
                        "stories": [
                            {
                                "story_id": "story-ports",
                                "title": "合成选题：港口",
                                "candidate_ids": [],
                                "disposition": "brief",
                                "reason": "已发布独立核验的简讯。",
                                "priority": 1,
                            },
                            {
                                "story_id": "story-models",
                                "title": "合成选题：小模型",
                                "candidate_ids": [],
                                "disposition": "deferred",
                                "reason": "保留继续跟进。",
                                "priority": 2,
                            },
                        ],
                    }
                }
            ),
            "0" * 64,
            at("2026-10-27T14:16:00"),
        )
        self.insert(
            "publication_units",
            RUN_27,
            "story-ports",
            "brief",
            "2026-10-27",
            "{}",
            contracts.canonical_json({"reason": "approved"}),
            "0" * 64,
            at("2026-10-27T14:12:00"),
        )
        # The correction sent the next night: no run of its own.
        self.edition(
            CORRECTION_27,
            "verification-2026-10-27",
            "2026-10-27",
            created="2026-10-28T02:00:00",
            updated="2026-10-28T02:05:00",
            title="合成期刊：港口与小模型（修订）",
            delivery="provider_accepted",
        )
        self.insert(
            "verification_sends",
            "2026-10-27",
            CORRECTION_27,
            "verification-key",
            "0" * 64,
            EDITION_27,
            at("2026-10-28T02:01:00"),
        )

    def _succeeded(
        self, run_id: str, issue: str, graph: Payload, *, legacy: bool
    ) -> None:
        base = int(issue[-2:]) * 100
        start = f"{issue}T14:00:01"
        nodes = {
            node["id"]: {
                "state": "succeeded",
                "artifact_id": "",
                "error_code": "",
                "map_expanded": False,
                "map_hash": "",
                "items": [],
                "degraded": False,
            }
            for node in graph["nodes"]
        }
        nodes["feeds"].update(degraded=False, error_code="partial_failure")
        nodes["discovery"]["items"] = [
            {
                "id": key,
                "value": {"id": key},
                "state": "succeeded",
                "artifact_id": "",
                "error_code": "",
            }
            for key in DIRECTIONS
        ]
        nodes["briefs"]["items"] = [
            {
                "id": "story-ports",
                "value": {"id": "story-ports", "question": "合成选题：港口？"},
                "state": "succeeded",
                "artifact_id": "",
                "error_code": "",
            }
        ]
        times = [
            ("history", "", "14:00:01", "14:00:02"),
            ("feeds", "", "14:00:02", "14:01:10"),
            ("discovery", "01-ai-ml", "14:01:10", "14:03:00"),
            ("discovery", "03-world", "14:03:00", "14:04:30"),
            ("candidates", "", "14:04:30", "14:04:31"),
            ("selection", "", "14:04:31", "14:05:29.5"),
            ("story_plan", "", "14:05:29.5", "14:05:30"),
            ("briefs", "story-ports", "14:05:30", "14:10:00"),
            ("deep", "", "14:10:00", "14:10:00"),
            ("publish", "", "14:10:00", "14:10:01"),
        ]
        self.workflow(
            run_id,
            start,
            nodes,
            [
                (node, item, "succeeded", "", f"{issue}T{a}", f"{issue}T{b}")
                for node, item, a, b in times
            ],
        )
        self.artifact(
            run_id,
            "feeds",
            "",
            {
                "candidates": [],
                "notes": {},
                "diagnostics": [
                    "synthetic-ml-feed:ok",
                    "synthetic-arxiv:ok",
                    "synthetic-world-feed:http_error",
                    "artifact:trimmed:0",
                ],
                **(
                    {}
                    if legacy
                    else {
                        "sources": [
                            {
                                "id": "synthetic-ml-feed",
                                "code": "ok",
                                "entries": 14,
                                "accepted": 6,
                                "seeds": 4,
                                "truncated": False,
                            },
                            {
                                "id": "synthetic-arxiv",
                                "code": "ok",
                                "entries": 30,
                                "accepted": 9,
                                "seeds": 3,
                                "truncated": False,
                            },
                            {
                                "id": "synthetic-world-feed",
                                "code": "http_error",
                                "entries": 0,
                                "accepted": 0,
                                "seeds": 0,
                                "truncated": False,
                            },
                        ]
                    }
                ),
            },
        )
        self.artifact(
            run_id, "candidates", "", {"candidates": [{}, {}, {}, {}]}
        )
        self.artifact(run_id, "selection", "", {"research_tasks": [{}, {}]})
        for key, count in zip(DIRECTIONS, (3, 1), strict=True):
            self.artifact(
                run_id, "discovery", key, {"candidates": [{}] * count}
            )
        if legacy:
            records = [
                call(base + n, stage)
                for n, stage in (
                    (1, "discovery:01-ai-ml"),
                    (2, "discovery:03-world"),
                    (3, "selection"),
                )
            ]
            self.calls(run_id, records, f"{issue}T14:10:00")
            return
        self.calls(
            run_id,
            [
                call(
                    base + 11,
                    "discovery:01-ai-ml",
                    started=f"{issue}T14:01:10.5",
                    finished=f"{issue}T14:02:58",
                    cost=1500,
                ),
                call(
                    base + 12,
                    "discovery:03-world",
                    started=f"{issue}T14:03:00.5",
                    finished=f"{issue}T14:04:29",
                    cost=1200,
                ),
                call(
                    base + 13,
                    "selection",
                    started=f"{issue}T14:04:31.2",
                    finished=f"{issue}T14:05:29.4",
                    tokens=(25000, 8000, 1800),
                    cost=2600,
                ),
                call(
                    base + 14,
                    "briefs:story-ports",
                    started=f"{issue}T14:05:31",
                    finished=f"{issue}T14:08:00",
                    purpose="writer",
                    turns=(2, 2),
                    tokens=(8000, 4000, 1500),
                ),
                call(
                    base + 15,
                    "briefs:story-ports",
                    started=f"{issue}T14:08:01",
                    finished=f"{issue}T14:09:58",
                    purpose="reviewer",
                    tokens=(4000, 0, 300),
                    cost=400,
                ),
            ],
            f"{issue}T14:10:00",
        )

    def _fixture(self) -> None:
        self.run(
            RUN_26,
            "image-smoke-2026-10-26",
            "2026-10-26",
            state="ready",
            created="2026-10-26T18:00:00",
            updated="2026-10-26T18:05:00",
            selection=150,
            revision=OLD_REVISION,
            edition=EDITION_26,
        )
        self.edition(
            EDITION_26,
            "collection:" + RUN_26,
            "2026-10-26",
            created="2026-10-26T18:04:00",
            updated="2026-10-26T18:04:30",
            title="合成样张",
            delivery="simulated",
            run_id=RUN_26,
            fixture=True,
        )

    def _timeout(self) -> None:
        """10-28: selection past its frozen 150 s, nothing publishable."""
        graph = self.run(
            RUN_28,
            "daily-2026-10-28",
            "2026-10-28",
            state="blocked",
            created="2026-10-28T14:00:00",
            updated="2026-10-28T14:07:42",
            selection=150,
            revision=OLD_REVISION,
            error="no_publishable_content",
        )
        node = {
            "artifact_id": "",
            "map_expanded": False,
            "map_hash": "",
            "items": [],
            "degraded": False,
        }
        nodes = {
            item["id"]: {**node, "state": "pending", "error_code": ""}
            for item in graph["nodes"]
        }
        for done in ("history", "candidates"):
            nodes[done]["state"] = "succeeded"
        nodes["feeds"].update(
            state="succeeded", error_code="partial_failure", degraded=False
        )
        nodes["discovery"].update(
            state="succeeded",
            items=[
                {
                    "id": key,
                    "value": {"id": key},
                    "state": "succeeded",
                    "artifact_id": "",
                    "error_code": "",
                }
                for key in DIRECTIONS
            ],
        )
        nodes["selection"].update(state="failed", error_code="timeout")
        day = "2026-10-28T"
        self.workflow(
            RUN_28,
            day + "14:00:01",
            nodes,
            [
                (
                    "history",
                    "",
                    "succeeded",
                    "",
                    day + "14:00:01",
                    day + "14:00:02",
                ),
                (
                    "feeds",
                    "",
                    "succeeded",
                    "",
                    day + "14:00:02",
                    day + "14:01:30",
                ),
                (
                    "discovery",
                    "01-ai-ml",
                    "succeeded",
                    "",
                    day + "14:01:30",
                    day + "14:03:10",
                ),
                (
                    "discovery",
                    "03-world",
                    "succeeded",
                    "",
                    day + "14:03:10",
                    day + "14:04:59",
                ),
                (
                    "candidates",
                    "",
                    "succeeded",
                    "",
                    day + "14:04:59",
                    day + "14:05:00",
                ),
                # The node's 150 s, and up to ~30 s more to close its
                # conversation.
                (
                    "selection",
                    "",
                    "failed",
                    "timeout",
                    day + "14:05:00",
                    day + "14:07:41.25",
                ),
            ],
        )
        self.artifact(
            RUN_28,
            "feeds",
            "",
            {
                "candidates": [],
                "notes": {},
                "diagnostics": [
                    "synthetic-ml-feed:ok",
                    "synthetic-arxiv:timeout",
                    "synthetic-world-feed:ok",
                ],
            },
        )
        self.artifact(
            RUN_28, "candidates", "", {"candidates": [{}, {}, {}, {}, {}]}
        )
        for key, count in zip(DIRECTIONS, (4, 1), strict=True):
            self.artifact(
                RUN_28, "discovery", key, {"candidates": [{}] * count}
            )
        # Recorded before calls kept their times, purposes and failures.
        self.calls(
            RUN_28,
            [
                call(2801, "discovery:01-ai-ml"),
                call(2802, "discovery:03-world"),
                call(
                    2803,
                    "selection",
                    status="failed",
                    tokens=None,
                    turns=(1, 0),
                    partial=True,
                ),
            ],
            "2026-10-28T14:07:41.3",
        )

    def _today(self) -> None:
        graph = self.run(
            RUN_29,
            "daily-2026-10-29",
            "2026-10-29",
            state="ready",
            created="2026-10-29T14:00:00",
            updated="2026-10-29T14:30:00",
            selection=420,
            revision=NEW_REVISION,
            edition=EDITION_29,
        )
        self._succeeded(RUN_29, "2026-10-29", graph, legacy=False)
        self.edition(
            EDITION_29,
            "collection:" + RUN_29,
            "2026-10-29",
            created="2026-10-29T14:29:00",
            updated="2026-10-29T14:31:07.5",
            title="合成期刊 10/29",
            delivery="provider_accepted",
            run_id=RUN_29,
        )
        self.run(
            RUN_29M,
            "manual-2026-10-29",
            "2026-10-29",
            state="ready",
            created="2026-10-29T15:00:00",
            updated="2026-10-29T15:20:00",
            selection=420,
            revision=NEW_REVISION,
            edition=EDITION_29M,
        )
        self.edition(
            EDITION_29M,
            "collection:" + RUN_29M,
            "2026-10-29",
            created="2026-10-29T15:19:00",
            updated="2026-10-29T15:19:30",
            title="合成试刊 10/29",
            delivery="not_requested",
            run_id=RUN_29M,
        )
        self.insert(
            "candidate_history",
            "candidate-1",
            "{}",
            at("2026-10-20T00:00:00"),
            at("2026-10-29T00:00:00"),
            "seen",
            "",
        )

    def _journal(self) -> None:
        page = "0123456789abcdef0123456789abcdef"
        progress = epoch("2026-10-29T15:00:00")
        self.entity(
            "edition:" + EDITION_27,
            "edition",
            page=page,
            progress=epoch("2026-10-27T14:40:00"),
        )
        self.entity(
            "edition:" + EDITION_29,
            "edition",
            page=page[::-1],
            versions=("done", "pending"),
            progress=progress,
        )
        self.entity(
            "edition:" + CORRECTION_27,
            "edition",
            page="fedcba9876543210fedcba9876543211",
            progress=epoch("2026-10-28T02:03:00"),
        )
        self.entity(
            "edition:" + EDITION_25,
            "edition",
            page="fedcba9876543210fedcba9876543212",
            error="notion_rate_limited",
            retry=epoch("2026-10-29T16:40:00"),
            attempts=3,
        )
        self.entity("edition:" + EDITION_26, "edition", create="conflict")
        self.entity(
            "edition:" + EDITION_29M,
            "edition",
            create="unknown",
            versions=("unknown",),
        )
        self.entity(
            "material:v1:" + "a" * 64,
            "material",
            page="fedcba9876543210fedcba9876543213",
            progress=epoch("2026-10-29T14:50:00"),
            title="合成材料：小模型推理",
        )
        self.entity(
            "material:v1:" + "b" * 64,
            "material",
            page="",
            create="new",
            error="notion_unavailable",
            retry=epoch("2026-10-29T17:00:00"),
            attempts=1,
            versions=("pending",),
            title="合成材料：港口吞吐",
        )
        for key, seen in (
            ("a", "2026-10-27T14:05:00"),
            ("b", "2026-10-28T14:05:00"),
        ):
            self.insert(
                "notion_candidates",
                RUN_27,
                "candidate-" + key,
                "material:v1:" + key * 64,
                "{}",
                at(seen),
            )
        for edition, digest in (
            (EDITION_27, at("2026-10-27T14:20:12.345678")),
            (EDITION_29, at("2026-10-29T14:31:07.5")),
            # Imported before its delivery was recorded: outdated.
            (CORRECTION_27, at("2026-10-28T02:00:00")),
            (EDITION_25, at("2026-10-25T14:31:00")),
            (EDITION_26, at("2026-10-26T18:04:30")),
            (EDITION_29M, at("2026-10-29T15:19:30")),
        ):
            self.insert("notion_imports", "edition", edition, digest, "")
        self.insert(
            "notion_imports",
            "research",
            "0" * 64,
            "invalid",
            "notion_research_import_failed",
        )


def png_bytes() -> bytes:
    """The synthetic chart image."""
    return base64.b64decode(PNG)

"""Shared offline story pipeline builders and fakes."""

from __future__ import annotations

from collections.abc import Iterator, Mapping
import dataclasses
import datetime
import importlib.resources as resources
import pathlib
from typing import Never, Protocol

import google.protobuf.message as message
import pytest

import newsletter.adapters as adapters
import newsletter.collection.collector as collector
import newsletter.collection.instructions as newsletter_collection_instructions
import newsletter.collection.repository as repository
import newsletter.contracts as contracts
import newsletter.editor as editor
import newsletter.settings as settings
import newsletter.store as newsletter_store
import newsletter.types as types
import newsletter.worker as newsletter_worker
import newsletter.workflow.definition as newsletter_workflow_definition
import newsletter.workflow.pipeline as newsletter_workflow_pipeline
import newsletter.workflow.publication as publication
import tests.support.publication as tests_support_publication


class FailingNotion:
    """Record projection attempts and fail without contacting Notion."""

    def __init__(self) -> None:
        self.calls: list[str] = []

    async def project(
        self, packet: Mapping[str, object] | message.Message
    ) -> Never:
        """Record the packet ID and simulate an explicit provider rejection."""
        value = (
            contracts.to_dict(packet)
            if isinstance(packet, message.Message)
            else packet
        )
        identifier = value["id"]
        assert isinstance(identifier, str)
        self.calls.append(identifier)
        raise adapters.AdapterError("NOTION_REJECTED")


@dataclasses.dataclass
class PublicationRig:
    """Durable publication components sharing one isolated test database."""

    path: pathlib.Path
    store: newsletter_store.Store
    runs: repository.RunRepository
    pipeline: newsletter_workflow_pipeline.DagPipeline
    publications: publication.PublicationRepository
    run: types.Payload
    definition: newsletter_workflow_definition.WorkflowDefinition
    instructions: list[newsletter_collection_instructions.Instruction]
    snapshot: types.Payload
    request: types.Payload
    tasks: list[types.Payload]
    notion: FailingNotion
    worker: newsletter_worker.Worker


class RigFactory(Protocol):
    """Construct isolated publication state, optionally with legacy inputs."""

    def __call__(
        self, *, expired: bool = False, legacy: bool = False
    ) -> PublicationRig:
        """Create one database, closed automatically by the owning fixture."""
        ...


@pytest.fixture
def rig_factory(
    tmp_path: pathlib.Path, monkeypatch: pytest.MonkeyPatch
) -> Iterator[RigFactory]:
    """Yield a factory whose publication tail cannot invoke live collection."""
    stores: list[newsletter_store.Store] = []

    async def forbidden(*args: object, **kwargs: object) -> Never:
        raise AssertionError(
            "A publication checkpoint must never run another model or collector"
        )

    monkeypatch.setattr(editor.CodexEditor, "execute", forbidden)
    monkeypatch.setattr(editor.CodexEditor, "prepare", forbidden)
    monkeypatch.setattr(collector.MockCollector, "collect", forbidden)

    def make(*, expired: bool = False, legacy: bool = False) -> PublicationRig:
        directory = tmp_path / str(len(stores))
        store = newsletter_store.Store(directory / "newsletter.sqlite3", "mock")
        stores.append(store)
        recipe = pathlib.Path(
            str(
                resources.files("newsletter").joinpath(
                    "workflows/legacy-daily.yaml"
                    if legacy
                    else "workflows/daily.yaml"
                )
            )
        )
        runs = repository.RunRepository(store)
        pipeline = newsletter_workflow_pipeline.DagPipeline(
            runs,
            collector.MockCollector(),
            directory / "collection",
            10,
            32,
            editor=editor.CodexEditor(directory / "nonexistent-auth"),
            recipe_path=recipe,
        )
        instructions, snapshot = newsletter_workflow_pipeline.freeze_workflow(
            settings.Settings(data_dir=directory, workflow_file=recipe),
            pipeline.state,
            tests_support_publication.DAY,
        )
        if expired:
            snapshot["inputs"]["started_at"] = (
                datetime.datetime.now(datetime.UTC) - datetime.timedelta(days=1)
            ).isoformat()
        request = {
            "request_key": "synthetic-topics",
            "issue_date": tests_support_publication.DAY,
        }
        run = runs.start(request, instructions, workflow_snapshot=snapshot)
        definition = newsletter_workflow_definition.parse_definition(
            snapshot["definition"]
        )
        pipeline.repository.start(run["id"], definition, snapshot["inputs"])
        notion = FailingNotion()
        return PublicationRig(
            path=directory,
            store=store,
            runs=runs,
            pipeline=pipeline,
            publications=publication.PublicationRepository(store),
            run=run,
            definition=definition,
            instructions=instructions,
            snapshot=snapshot,
            request=request,
            tasks=[
                tests_support_publication.task(1),
                tests_support_publication.task(2),
                tests_support_publication.task(3),
            ],
            notion=notion,
            worker=newsletter_worker.Worker(
                store,
                editor.MockEditor(),
                notion,
                directory / "editor",
                10,
                pipeline=pipeline,
            ),
        )

    try:
        yield make
    finally:
        for store in stores:
            store.close()

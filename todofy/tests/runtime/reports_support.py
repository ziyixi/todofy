"""Shared setup for the reports, reminder and retention runtime tests.

They drive the modules through the reports probe (tests/runtime/reports_probe)
against the loopback Gemini and Todoist fakes, with real D1 in workerd. Test
modules import ``probe_fixture`` and ``clean_fixture``: each module gets its own
probe, and every test starts from empty tables and fakes.
"""

import hashlib
from collections.abc import Iterator
from datetime import UTC, datetime
from typing import Any

import jsonschema
import pytest

from tests.fakes.gemini_fake import API_KEY as GEMINI_KEY
from tests.fakes.gemini_fake import GeminiFake
from tests.fakes.todoist_fake import PROJECT_ID, TodoistFake
from tests.fakes.todoist_fake import TOKEN as TODOIST_TOKEN
from tests.runtime.harness import Worker
from tests.runtime.owner_support import DOCUMENT, REGISTRY
from tests.runtime.reports_probe import start_probe

MODEL = "gemini-probe"
PUBLIC_HOST = "todofy.example"
NEWSLETTER = ("newsletter", "correct horse")
ROTATED = ("newsletter", "battery staple")
TABLES = ("mail_events", "mail_reminders", "summaries", "daily_reports", "owner_actions", "auth_failures")
TABLES += ("legacy_mail_text", "event_transitions", "gtd_snapshots", "gtd_snapshot_tasks", "gtd_daily", "gtd_reviews")
# 2026-09-28T15:00:00Z, after the 13:30 precompute time.
NOW = int(datetime(2026, 9, 28, 15, tzinfo=UTC).timestamp())


def digest(user: str, password: str) -> str:
    return hashlib.sha256(f"{user}:{password}".encode()).hexdigest()


class Probe:
    def __init__(self, worker: Worker, gemini: GeminiFake, todoist: TodoistFake) -> None:
        self.worker = worker
        self.gemini = gemini
        self.todoist = todoist

    def call(self, path: str, **args: Any) -> dict[str, Any]:
        response = self.worker.hooks.post(path, json=args)
        assert response.status_code == 200, response.text
        return response.json()

    def sql(self, sql: str, *params: Any) -> list[dict[str, Any]]:
        return self.call("/d1", statements=[[sql, list(params)]])["results"][0]

    def insert(self, table: str, **row: Any) -> None:
        self.sql(f"INSERT INTO {table} ({', '.join(row)}) VALUES ({', '.join('?' * len(row))})", *row.values())


@pytest.fixture(scope="module", name="probe")
def probe_fixture(tmp_path_factory: pytest.TempPathFactory) -> Iterator[Probe]:
    gemini, todoist = GeminiFake(), TodoistFake()
    variables = {
        "GEMINI_API_BASE": gemini.url,
        "GEMINI_API_KEY": GEMINI_KEY,
        "GEMINI_MODELS": MODEL,
        "GEMINI_TIMEOUT_MS": "5000",
        "TODOIST_API_BASE": todoist.url,
        "TODOIST_API_KEY": TODOIST_TOKEN,
        "TODOIST_DEFAULT_PROJECT_ID": PROJECT_ID,
        "REPORT_BASIC_AUTH_SHA256": f"{digest(*NEWSLETTER)},{digest(*ROTATED)}",
        "REMINDER_ENABLED": "true",
        "TODOFY_PUBLIC_HOST": PUBLIC_HOST,
    }
    try:
        for worker in start_probe(tmp_path_factory.mktemp("reports-probe"), variables):
            yield Probe(worker, gemini, todoist)
    finally:
        gemini.close()
        todoist.close()


@pytest.fixture(autouse=True, name="clean")
def clean_fixture(probe: Probe) -> Probe:
    probe.gemini.reset()
    probe.todoist.reset()
    probe.todoist.reset_state()
    probe.call("/d1", statements=[[f"DELETE FROM {table}", []] for table in TABLES])
    return probe


def component_errors(name: str, instance: Any) -> list[str]:
    """Validation errors of ``instance`` against an OpenAPI component schema."""
    schema = {"$ref": f"{DOCUMENT}#/components/schemas/{name}"}
    validator = jsonschema.Draft202012Validator(schema, registry=REGISTRY)
    return [f"{list(error.absolute_path)}: {error.message}" for error in validator.iter_errors(instance)]

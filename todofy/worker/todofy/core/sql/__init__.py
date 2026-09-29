"""Every D1 statement the Worker runs, grouped by the runtime module that owns it.

Each statement is a module-level ``Query`` naming the index it must use;
tests/unit/test_schema_sql.py finds them all and checks their query plans
against migrations/. SQLite uses a partial index only when the query repeats
its WHERE terms, so "active" is always spelled as the ``ACTIVE`` IN list.
"""

from collections.abc import Iterable
from typing import NamedTuple

from ..vocab import ALWAYS_ATTENTION_STATES, TERMINAL_STATES, EventState


class Query(NamedTuple):
    sql: str
    index: str
    sort_allowed: bool = False  # only when the sort sees rows already bounded by the index


def sql_list(values: Iterable[str]) -> str:
    return ", ".join(f"'{value}'" for value in values)


ACTIVE_STATES = tuple(state for state in EventState if state not in TERMINAL_STATES)
ACTIVE = f"state IN ({sql_list(ACTIVE_STATES)})"
DUE = f"state IN ({sql_list([EventState.PENDING, EventState.SUMMARIZED, EventState.TODO_CREATED])})"
# Bind the attention cutoff (now - ATTENTION_AGE_SECONDS) to the placeholder.
ATTENTION = f"(state IN ({sql_list(sorted(ALWAYS_ATTENTION_STATES))}) OR created_at <= ?)"

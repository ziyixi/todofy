"""As-of joins of time-stamped tables onto decision samples."""

from __future__ import annotations

from collections.abc import Sequence

import numpy as np
import pandas as pd

from . import clocks
from .constants import FAMILY_SPECS


def asof_join(
    samples: pd.DataFrame,
    table: pd.DataFrame,
    *,
    by: str | Sequence[str],
    columns: Sequence[str],
    sample_time: str = "decision_at",
    table_time: str = "available_at",
    inclusive: bool = True,
    family: str | None = None,
) -> pd.DataFrame:
    """For each sample, ``columns`` of the latest ``table`` row of the same ``by`` key
    whose ``table_time`` is at or before (``inclusive``) the sample's time.

    The result keeps the samples' order and index. Times follow the SDK clock rule:
    only offset-bearing values are instants. Table rows without one are dropped and
    counted in ``attrs["unclocked_rows"]``; samples without one get missing values. Keys
    are compared as plain values, so categorical and object keys match. Families
    registered as evaluation-only (e.g. factor returns) are refused: they describe
    outcomes, not information available at a decision. Among rows with the same key
    and clock, the last in table order wins.
    """
    name = family if family is not None else table.attrs.get("family")
    spec = FAMILY_SPECS.get(name) if isinstance(name, str) else None
    if spec is not None and spec.evaluation_only:
        raise ValueError(f"EVALUATION_ONLY: {name} cannot be joined as a feature")
    keys = [by] if isinstance(by, str) else list(by)
    columns = list(columns)
    right = table[columns].reset_index(drop=True)
    for key in keys:
        right[key] = table[key].to_numpy(dtype=object)
    right["_table_time"] = clocks.instants(table[table_time])
    clocked = right["_table_time"].to_numpy() != clocks.NAT
    right = right[clocked].sort_values("_table_time", kind="stable")
    left = pd.DataFrame({key: samples[key].to_numpy(dtype=object) for key in keys})
    left["_time"] = clocks.instants(samples[sample_time])
    left["_position"] = np.arange(len(samples))
    timed = left[left["_time"] != clocks.NAT].sort_values("_time", kind="stable")
    joined = pd.merge_asof(
        timed,
        right,
        left_on="_time",
        right_on="_table_time",
        by=keys,
        direction="backward",
        allow_exact_matches=inclusive,
    )
    result = (
        joined.set_index("_position")[columns]
        .reindex(np.arange(len(samples)))
        .set_axis(samples.index)
    )
    result.attrs["unclocked_rows"] = int((~clocked).sum())
    return result


def step_stream(
    changes: pd.DataFrame, *, by: str | Sequence[str], time: str, state: Sequence[str]
) -> pd.DataFrame:
    """A merge_asof-ready step function from ``(by, time, state)`` change rows.

    Rows are ordered by time (stable); of several rows of one key at one instant the
    last wins, and rows that repeat the key's previous state are dropped.
    """
    keys = [by] if isinstance(by, str) else list(by)
    frame = changes[[*keys, time, *state]].sort_values(time, kind="stable")
    frame = frame.drop_duplicates([*keys, time], keep="last")
    current = frame[list(state)]
    previous = frame.groupby(keys, sort=False)[list(state)].shift(1)
    same = ((current == previous) | (current.isna() & previous.isna())).all(axis=1)
    first = ~frame.duplicated(keys, keep="first")
    return frame[~same | first].reset_index(drop=True)

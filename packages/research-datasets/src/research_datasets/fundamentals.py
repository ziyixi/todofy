"""Fundamental features and ratios: as-filed SEC facts joined as of each decision.

A fact version is usable at its public clock (SEC filings: max(acceptance, 06:00 New
York on the filing date)); observed_content also needs its capture by the decision plus
CAPTURE_GRACE. At a decision each fact (``fact_id``) has one selected version, and
versions with an unknown clock remain possible values. ``FactEngine`` turns every
version into the interval of decision instants during which it is a possible value and
each (issuer, metric, unit, period kind, period end) bucket into a step function, so a
panel is joined with sorted lookups instead of one scan of the issuer's facts per
sample. The tests hold the engine to the scalar rule, kept there as the reference.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from datetime import date
from decimal import Decimal, InvalidOperation
from functools import lru_cache
from heapq import heappop, heappush
from typing import Any

import numpy as np
import pandas as pd

from . import clocks
from .candidates import ensure_samples
from .clocks import NAT, NEVER
from .constants import (
    ALL_METRICS,
    DURATION_METRICS,
    INSTANT_METRICS,
    KEYS,
    QUARTER_DEFAULT_EXCLUDED_METRICS,
    RATIO_METRICS,
)

# Per-metric columns of a feature frame, then the selected fact's provenance.
FEATURE_FIELDS = (
    "value",
    "status",
    "raw_value",
    "available_at",
    "public_clock_missing",
    "availability_basis",
)
PROVENANCE = (
    "fact_id",
    "cik",
    "unit",
    "currency",
    "period_start",
    "period_end",
    "period_kind",
    "accession",
    "tag",
    "source_url",
    "public_at",
    "public_date",
    "public_time_precision",
    "observed_at",
)
STATUSES = (
    "ok",
    "ok_observed_only",
    "mapping_missing",
    "clock_unknown",
    "metric_missing",
    "not_yet_available",
    "retracted",
    "unit_unavailable",
    "period_unavailable",
    "invalid_value",
    "ambiguous",
    "nonfinite_model_value",
)
(
    OK,
    OK_OBSERVED,
    MAPPING_MISSING,
    CLOCK_UNKNOWN,
    METRIC_MISSING,
    NOT_YET,
    RETRACTED,
    UNIT_UNAVAILABLE,
    PERIOD_UNAVAILABLE,
    INVALID,
    AMBIGUOUS,
    NONFINITE,
) = range(len(STATUSES))
RATIO_INPUTS = (
    "revenue",
    "gross_profit",
    "operating_income",
    "net_income",
    "operating_cash_flow",
    "capex",
)
RATIO_REFERENCES = (
    "status",
    "fact_id",
    "raw_value",
    "cik",
    "unit",
    "currency",
    "period_start",
    "period_end",
    "accession",
    "available_at",
)
RATIO_STATUSES = (
    "ok",
    "ok_observed_only",
    "input_unavailable",
    "basis_missing",
    "unit_mismatch",
    "issuer_mismatch",
    "period_mismatch",
    "accession_mismatch",
    "zero_revenue",
    "nonfinite_result",
    "prior_unavailable",
    "prior_basis_mismatch",
    "unverified_prior_period",
    "zero_prior_revenue",
)
RATIO_DEFINITIONS = (
    ("gross_margin", ("gross_profit", "revenue")),
    ("operating_margin", ("operating_income", "revenue")),
    ("net_margin", ("net_income", "revenue")),
    ("free_cash_flow", ("operating_cash_flow", "capex")),
    ("free_cash_flow_margin", ("operating_cash_flow", "capex", "revenue")),
)
# Inputs of one ratio must agree on these selected-fact fields, in this order.
RATIO_BASIS = ("cik", "period_start", "period_end", "unit", "currency", "accession")
RATIO_MISMATCHES = (
    ("cik", "issuer_mismatch"),
    ("period_start", "period_mismatch"),
    ("period_end", "period_mismatch"),
    ("accession", "accession_mismatch"),
)
LIMITATIONS = [
    "Frozen verified issuer mappings are static; share classes retain separate candidate UUIDs.",
    "Public reconstruction keeps first saved states per fact/public clock; unknown public withdrawals are ignored.",
    "SEC as-filed facts are not a restatement-complete PIT ledger; no FX, EPS or YTD-to-quarter derivation is performed.",
]
YOY_LIMITATION = "YoY requires exact one-calendar-year-shifted actual periods, with February 29 clamped; unverified 52/53-week comparisons stay missing."
_PERIOD_SPAN = date.max.toordinal() + 1
_UNVERIFIED = -2  # issuer code of a sample without a verified frozen mapping


def _per_value(values: Any, function: Callable[[Any], Any], dtype: Any) -> np.ndarray:
    """``function`` of every cell, called once per distinct value."""
    cells = np.asarray(values, dtype=object)
    codes, uniques = pd.factorize(pd.Series(cells, dtype=object))
    result = np.empty(len(cells), dtype=dtype)
    known = codes >= 0
    if len(uniques):
        mapped = np.asarray([function(value) for value in uniques], dtype=dtype)
        result[known] = mapped[codes[known]]
    for index in np.flatnonzero(~known):
        result[index] = function(cells[index])
    return result


def _column(frame: pd.DataFrame, name: str, default: Any = None) -> np.ndarray:
    if name in frame.columns:
        return frame[name].to_numpy(dtype=object)
    return np.full(len(frame), default, dtype=object)


def _starts(keys: np.ndarray) -> np.ndarray:
    """True where a run of equal keys begins."""
    result = np.ones(len(keys), dtype=bool)
    result[1:] = keys[1:] != keys[:-1]
    return result


def _following(values: np.ndarray, keys: np.ndarray, fill: int) -> np.ndarray:
    """Each element's successor within its run of equal keys, else ``fill``."""
    result = np.full(len(values), fill, dtype=values.dtype)
    same = keys[1:] == keys[:-1]
    result[:-1][same] = values[1:][same]
    return result


def _sequences(frame: pd.DataFrame) -> np.ndarray:
    error = ValueError("Facts require a nonnegative observation_sequence")
    if not len(frame):
        return np.zeros(0, dtype=np.int64)
    if "observation_sequence" not in frame.columns:
        raise error
    column = frame["observation_sequence"]
    if pd.api.types.is_integer_dtype(column.dtype) and not column.isna().any():
        values = column.to_numpy(dtype=np.int64)
    else:
        cells = column.to_numpy(dtype=object)
        if not all(
            isinstance(value, (int, np.integer)) and not isinstance(value, bool)
            for value in cells
        ):
            raise error
        values = cells.astype(np.int64)
    if (values < 0).any():
        raise error
    return values


def _ordinal(value: Any) -> int:
    """A date-like value as an ordinal, 0 when it is missing or empty."""
    if value is None or (not isinstance(value, str) and pd.isna(value)) or value == "":
        return 0
    return clocks.day(value).toordinal()


@lru_cache(maxsize=65536)
def _decimal(text: str) -> Decimal:
    return Decimal(text)


class _Steps:
    """Step functions per integer key: ``values[i]`` holds from ``times[i]``
    (inclusive) until the key's next time. Rows are sorted by key, then time."""

    def __init__(self, keys: np.ndarray, times: np.ndarray, values: np.ndarray):
        self.keys, self.times, self.values = keys, times, values
        self._unique = np.unique(times)
        self._width = len(self._unique) + 1
        self._sorted = keys * self._width + np.searchsorted(self._unique, times) + 1

    @classmethod
    def count(
        cls, keys: np.ndarray, starts: np.ndarray, ends: np.ndarray, domain: int
    ) -> _Steps:
        """How many ``[start, end)`` intervals of each key cover an instant; every key
        below ``domain`` starts at 0 from NAT."""
        closing = ends != NEVER
        key = np.concatenate([np.arange(domain), keys, keys[closing]])
        time = np.concatenate([np.full(domain, NAT), starts, ends[closing]])
        delta = np.concatenate(
            [
                np.zeros(domain, dtype=np.int64),
                np.ones(len(keys), dtype=np.int64),
                np.full(int(closing.sum()), -1, dtype=np.int64),
            ]
        )
        order = np.lexsort((time, key))
        key, time, delta = key[order], time[order], delta[order]
        total = np.cumsum(delta)
        first = _starts(key)
        before = (total - delta)[np.flatnonzero(first)][np.cumsum(first) - 1]
        last = np.ones(len(key), dtype=bool)
        last[:-1] = (key[1:] != key[:-1]) | (time[1:] != time[:-1])
        return cls(key[last], time[last], (total - before)[last])

    def at(self, keys: np.ndarray, times: np.ndarray) -> np.ndarray:
        """Row of each key's step at each instant, -1 when the key has none."""
        query = keys * self._width + np.searchsorted(self._unique, times, "right")
        position = np.searchsorted(self._sorted, query, "right") - 1
        found = position >= 0
        found[found] = self.keys[position[found]] == keys[found]
        return np.where(found, position, -1)

    def span(self, key: int) -> tuple[int, int]:
        return (
            int(np.searchsorted(self.keys, key, "left")),
            int(np.searchsorted(self.keys, key, "right")),
        )


class _MetricSteps:
    """Step functions of one (metric, unit, period kind) over issuers and periods."""

    def __init__(self, engine: FactEngine, metric: str, unit: str, period_kind: str):
        domain = len(engine.cik_names)
        in_metric = engine.metric_of(metric)
        self.present = np.zeros(domain, dtype=bool)
        self.present[engine.cik[in_metric]] = True
        live = np.flatnonzero(in_metric & (engine.start != NEVER))
        cik, start, end = engine.cik[live], engine.start[live], engine.end[live]
        self.counts = _Steps.count(cik, start, end, domain)
        in_unit = engine.equals("unit", unit)[live]
        self.unit_counts = _Steps.count(
            cik[in_unit], start[in_unit], end[in_unit], domain
        )
        retracted = in_metric[engine.retracted_rows]
        self.retracted = _Steps.count(
            engine.cik[engine.retracted_rows[retracted]],
            engine.retracted_start[retracted],
            engine.retracted_end[retracted],
            domain,
        )
        dated = live[
            in_unit
            & engine.equals("period_kind", period_kind)[live]
            & (engine.period[live] > 0)
        ]
        self.bucket_keys, bucket = np.unique(
            engine.cik[dated] * _PERIOD_SPAN + engine.period[dated],
            return_inverse=True,
        )
        self.bucket_cik = self.bucket_keys // _PERIOD_SPAN
        self.bucket_period = self.bucket_keys % _PERIOD_SPAN
        order = np.argsort(bucket, kind="stable")
        self.bucket_rows = dated[order]
        self.bucket_offsets = np.searchsorted(
            bucket[order], np.arange(len(self.bucket_keys) + 1)
        )
        self.buckets = _Steps.count(
            bucket, engine.start[dated], engine.end[dated], len(self.bucket_keys)
        )
        self.top = self._top(domain)
        self.results: dict[int, tuple[int, int, float]] = {}

    def _top(self, domain: int) -> _Steps:
        """The largest period with a non-empty bucket, per issuer and instant (0: none)."""
        steps = self.buckets
        filled = steps.values > 0
        was = np.zeros(len(filled), dtype=bool)
        was[1:] = filled[:-1]
        was &= ~_starts(steps.keys)
        change = filled != was
        bucket = steps.keys[change]
        cik, period = self.bucket_cik[bucket], self.bucket_period[bucket]
        time, delta = steps.times[change], np.where(filled[change], 1, -1)
        order = np.lexsort((time, cik))
        cells = list(
            zip(
                cik[order].tolist(),
                time[order].tolist(),
                period[order].tolist(),
                delta[order].tolist(),
                strict=True,
            )
        )
        keys, times, tops = list(range(domain)), [NAT] * domain, [0] * domain
        heap: list[int] = []
        active: dict[int, int] = {}
        current, shown = -1, 0
        for index, (key, instant, value, step) in enumerate(cells):
            if key != current:
                heap, active, current, shown = [], {}, key, 0
            active[value] = active.get(value, 0) + step
            if step > 0:
                heappush(heap, -value)
            following = cells[index + 1] if index + 1 < len(cells) else None
            if following is None or following[:2] != (key, instant):
                while heap and active.get(-heap[0], 0) <= 0:
                    heappop(heap)
                best = -heap[0] if heap else 0
                if best != shown:
                    keys.append(key)
                    times.append(instant)
                    tops.append(best)
                    shown = best
        key = np.asarray(keys, dtype=np.int64)
        time = np.asarray(times, dtype=np.int64)
        top = np.asarray(tops, dtype=np.int64)
        order = np.lexsort((time, key))
        key, time, top = key[order], time[order], top[order]
        last = np.ones(len(key), dtype=bool)
        last[:-1] = (key[1:] != key[:-1]) | (time[1:] != time[:-1])
        return _Steps(key[last], time[last], top[last])


class FactEngine:
    """Fact versions of one read, prepared for one time policy.

    Each version gets the interval ``[start, end)`` of decision instants during which
    it is a possible value of its fact: as the selected version unless that version is
    retracted (observed_content: the highest observation_sequence available at or before
    the decision; public_reconstructed: the first saved version of the latest public
    clock at or before it), or as a version with an unknown clock (observed_content:
    captured by the decision plus CAPTURE_GRACE and newer than the selected version;
    public_reconstructed: not retracted, before the fact's first public clock). A
    bucket's result is its latest report among those possible values.
    """

    def __init__(
        self, facts: pd.DataFrame, zones: Mapping[str, str], time_policy: str
    ) -> None:
        self.policy = clocks.policy(time_policy)
        frame = pd.DataFrame(facts).reset_index(drop=True)
        rows = len(frame)
        self.frame = frame
        self.sequence = _sequences(frame)
        if rows and "fact_id" not in frame.columns:
            raise KeyError("fact_id")
        public, invalid = clocks.public_clocks(
            frame if "source" in frame.columns else frame.assign(source="sec"), zones
        )
        observed = (
            clocks.instants(frame["observed_at"])
            if "observed_at" in frame.columns
            else np.full(rows, NAT, dtype=np.int64)
        )
        self.public, self.observed = public, observed
        self.available = clocks.available_at(public, invalid, self.policy, [observed])
        self.period = _per_value(
            _column(frame, "period_end"),
            lambda value: clocks.day(value).toordinal() if value else 0,
            np.int64,
        )
        cik = _per_value(
            _column(frame, "cik", ""), lambda value: str(value).zfill(10), object
        )
        self.cik, self.cik_names = pd.factorize(pd.Series(cik, dtype=object))
        self.cik_index = {name: code for code, name in enumerate(self.cik_names)}
        metric = _column(frame, "metric")
        self.metric_codes, self.metric_names = pd.factorize(
            pd.Series(metric, dtype=object), use_na_sentinel=False
        )
        self.fact_id = _column(frame, "fact_id")
        self.retracted = _per_value(_column(frame, "is_retracted", False), bool, bool)
        self.value = _column(frame, "value")
        self.period_start = _column(frame, "period_start")
        self.tag_priority = _column(frame, "tag_priority", 0)
        chain = (
            pd.DataFrame({"c": cik, "m": metric, "f": self.fact_id})
            .groupby(["c", "m", "f"], sort=False, dropna=False)
            .ngroup()
            .to_numpy(dtype=np.int64)
            if rows
            else np.zeros(0, dtype=np.int64)
        )
        order = np.lexsort((self.sequence, chain))
        if (
            (chain[order][1:] == chain[order][:-1])
            & (self.sequence[order][1:] == self.sequence[order][:-1])
        ).any():
            raise ValueError("Duplicate observation_sequence for one fact")
        self.start = np.full(rows, NEVER, dtype=np.int64)
        self.end = np.full(rows, NEVER, dtype=np.int64)
        selected, selected_start, selected_end = self._intervals(chain)
        withdrawn = self.retracted[selected]
        kept = selected[~withdrawn]
        self.start[kept] = selected_start[~withdrawn]
        self.end[kept] = selected_end[~withdrawn]
        empty = self.start >= self.end
        self.start[empty], self.end[empty] = NEVER, NEVER
        closed = withdrawn & (selected_start < selected_end)
        self.retracted_rows = selected[closed]
        self.retracted_start = selected_start[closed]
        self.retracted_end = selected_end[closed]
        self._steps: dict[tuple[str, str, str], _MetricSteps] = {}
        self._codes: dict[str, tuple[np.ndarray, np.ndarray]] = {}
        self._equals: dict[tuple[str, str], np.ndarray] = {}

    def _intervals(
        self, chain: np.ndarray
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """Selected versions with their intervals; sets the unknown-clock intervals."""
        sequence = self.sequence
        if self.policy == "observed_content":
            known = np.flatnonzero(self.available != NAT)
            order = known[
                np.lexsort((sequence[known], self.available[known], chain[known]))
            ]
            highest = (
                pd.Series(sequence[order]).groupby(chain[order]).cummax().to_numpy()
            )
            before = np.full(len(order), -1, dtype=np.int64)
            before[1:] = highest[:-1]
            before[_starts(chain[order])] = -1
            selected = order[highest > before]
            group, time = chain[selected], self.available[selected]
            unknown = np.flatnonzero(self.available == NAT)
            observed = self.observed[unknown]
            self.start[unknown] = np.where(
                observed != NAT, observed - clocks.GRACE_NS, NAT
            )
            # A version with an unknown clock counts until a newer version is selected.
            if len(selected) and len(unknown):
                ranks = np.unique(sequence[np.r_[selected, unknown]])
                width = len(ranks) + 1
                position = np.searchsorted(
                    group * width + np.searchsorted(ranks, sequence[selected]),
                    chain[unknown] * width + np.searchsorted(ranks, sequence[unknown]),
                    "right",
                )
                inside = position < len(selected)
                inside[inside] = group[position[inside]] == chain[unknown][inside]
                self.end[unknown] = np.where(
                    inside, time[np.minimum(position, len(selected) - 1)], NEVER
                )
            return selected, time, _following(time, group, NEVER)
        known = np.flatnonzero(self.public != NAT)
        order = known[np.lexsort((sequence[known], chain[known]))]
        first_saved = ~(
            pd.DataFrame({"c": chain[order], "p": self.public[order]})
            .duplicated(["c", "p"])
            .to_numpy()
        )
        selected = order[first_saved]
        selected = selected[np.lexsort((self.public[selected], chain[selected]))]
        group, time = chain[selected], self.public[selected]
        earliest = np.full(len(chain), NEVER, dtype=np.int64)
        opening = _starts(group)
        earliest[group[opening]] = time[opening]
        unknown = np.flatnonzero((self.public == NAT) & ~self.retracted)
        self.start[unknown] = NAT
        self.end[unknown] = earliest[chain[unknown]]
        return selected, time, _following(time, group, NEVER)

    def metric_of(self, metric: str) -> np.ndarray:
        names = list(self.metric_names)
        if metric not in names:
            return np.zeros(len(self.frame), dtype=bool)
        return self.metric_codes == names.index(metric)

    def steps(self, metric: str, unit: str, period_kind: str) -> _MetricSteps:
        key = (metric, unit, period_kind)
        if key not in self._steps:
            self._steps[key] = _MetricSteps(self, metric, unit, period_kind)
        return self._steps[key]

    def codes(self, name: str) -> tuple[np.ndarray, np.ndarray]:
        """Per fact row: a code per distinct value of column ``name`` (-1: missing) and
        the value's truthiness."""
        if name not in self._codes:
            cells = _column(self.frame, name)
            codes, _ = pd.factorize(pd.Series(cells, dtype=object))
            self._codes[name] = codes, _per_value(cells, bool, bool)
        return self._codes[name]

    def equals(self, name: str, text: str) -> np.ndarray:
        """Per fact row: whether column ``name`` equals ``text``."""
        if (name, text) not in self._equals:
            cells = _column(self.frame, name)
            self._equals[name, text] = np.fromiter(
                (cell == text for cell in cells), dtype=bool, count=len(cells)
            )
        return self._equals[name, text]

    def _bucket_result(self, rows: Sequence[int]) -> tuple[int, int, float]:
        """Status, selected row and value of the latest report among a bucket's rows."""
        if any(self.available[row] == NAT for row in rows):
            return CLOCK_UNKNOWN, -1, np.nan
        report = [
            self.public[row] if self.public[row] != NAT else self.observed[row]
            for row in rows
        ]
        latest = max(report)
        candidates = [row for row, at in zip(rows, report, strict=True) if at == latest]
        texts = [self.value[row] for row in candidates]
        try:
            values = (
                {_decimal(text) for text in texts}
                if all(isinstance(text, str) for text in texts)
                else set()
            )
        except (InvalidOperation, TypeError, ValueError):
            values = set()
        if not values or any(not value.is_finite() for value in values):
            return INVALID, -1, np.nan
        if len(values) != 1 or len({self.period_start[row] for row in candidates}) != 1:
            return AMBIGUOUS, -1, np.nan
        chosen = min(
            candidates, key=lambda row: (self.tag_priority[row], self.fact_id[row])
        )
        number = float(next(iter(values)))
        if not np.isfinite(number):
            return NONFINITE, chosen, np.nan
        return (OK_OBSERVED if self.public[chosen] == NAT else OK), chosen, number

    def _result(self, steps: _MetricSteps, position: int) -> tuple[int, int, float]:
        cached = steps.results.get(position)
        if cached is None:
            bucket = steps.buckets.keys[position]
            instant = steps.buckets.times[position]
            rows = steps.bucket_rows[
                steps.bucket_offsets[bucket] : steps.bucket_offsets[bucket + 1]
            ]
            active = rows[(self.start[rows] <= instant) & (instant < self.end[rows])]
            cached = steps.results[position] = self._bucket_result(active.tolist())
        return cached

    def _scan_lower(self, steps: _MetricSteps, bucket: int, instant: int) -> int:
        """Step of the first non-empty bucket at ``instant`` from ``bucket`` down (same
        issuer), -1 when there is none."""
        issuer = steps.bucket_cik[bucket]
        while bucket >= 0 and steps.bucket_cik[bucket] == issuer:
            low, high = steps.buckets.span(bucket)
            position = (
                low
                - 1
                + int(np.searchsorted(steps.buckets.times[low:high], instant, "right"))
            )
            if position >= low and steps.buckets.values[position] > 0:
                return position
            bucket -= 1
        return -1

    def evaluate(
        self,
        metric: str,
        unit: str,
        period_kind: str,
        cik: np.ndarray,
        decision: np.ndarray,
        limit: np.ndarray,
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """Status codes, selected rows (-1: none) and values for issuer codes (-1: no
        facts), decision instants (known) and period-end limits (ordinals; 0: none)."""
        size = len(cik)
        status = np.full(size, METRIC_MISSING, dtype=np.int8)
        chosen = np.full(size, -1, dtype=np.int64)
        value = np.full(size, np.nan)
        steps = self.steps(metric, unit, period_kind)
        live = cik >= 0
        live[live] = steps.present[cik[live]]
        query = np.flatnonzero(live)
        issuer, instant, bound = cik[query], decision[query], limit[query]
        possible = steps.counts.values[steps.counts.at(issuer, instant)] > 0
        in_unit = steps.unit_counts.values[steps.unit_counts.at(issuer, instant)] > 0
        retracted = steps.retracted.values[steps.retracted.at(issuer, instant)] > 0
        status[query] = np.where(
            possible,
            np.where(in_unit, PERIOD_UNAVAILABLE, UNIT_UNAVAILABLE),
            np.where(retracted, RETRACTED, NOT_YET),
        )
        dated = possible & in_unit & (bound > 0)
        query, issuer, instant, bound = (
            array[dated] for array in (query, issuer, instant, bound)
        )
        top = steps.top.values[steps.top.at(issuer, instant)]
        # The latest available period when it qualifies, else the largest stored period
        # at or below the limit; an empty bucket there means scanning lower periods.
        bucket = (
            np.searchsorted(
                steps.bucket_keys,
                issuer * _PERIOD_SPAN + np.minimum(top, bound),
                "right",
            )
            - 1
        )
        found = (top > 0) & (bucket >= 0)
        found[found] = steps.bucket_cik[bucket[found]] == issuer[found]
        query, instant, bucket = (array[found] for array in (query, instant, bucket))
        position = steps.buckets.at(bucket, instant)
        for index in np.flatnonzero(steps.buckets.values[position] <= 0):
            position[index] = self._scan_lower(
                steps, int(bucket[index]), int(instant[index])
            )
        # One result per distinct bucket step, broadcast to the samples that use it.
        found = position >= 0
        distinct, inverse = np.unique(position[found], return_inverse=True)
        results = [self._result(steps, int(step)) for step in distinct]
        if results:
            codes, rows, numbers = zip(*results, strict=True)
            query = query[found]
            status[query] = np.asarray(codes, dtype=np.int8)[inverse]
            chosen[query] = np.asarray(rows, dtype=np.int64)[inverse]
            value[query] = np.asarray(numbers, dtype=np.float64)[inverse]
        return status, chosen, value


class FactInputs:
    """Manifest, frozen universe and fact versions of one call, read once."""

    def __init__(
        self, version_or_material: Any, asset_ids: Any, metrics: Sequence[str]
    ) -> None:
        if isinstance(version_or_material, Mapping):
            manifest = version_or_material["manifest"]
            universe = version_or_material["universe"]
            facts = version_or_material["fundamentals"]
        else:
            manifest = version_or_material.manifest
            universe = version_or_material.universe
            records = (
                universe.to_dict("records")
                if isinstance(universe, pd.DataFrame)
                else universe
            )
            requested = set(asset_ids)
            mapped = [
                row["asset_id"]
                for row in records
                if row["asset_id"] in requested
                and row.get("issuer_mapping_status") == "verified"
                and isinstance(row.get("cik"), str)
                and len(row["cik"]) == 10
                and row["cik"].isascii()
                and row["cik"].isdigit()
            ]
            facts = (
                version_or_material.fundamentals(mapped, metrics=list(metrics))
                if mapped
                else pd.DataFrame()
            )
        universe = (
            universe.to_dict("records")
            if isinstance(universe, pd.DataFrame)
            else universe
        )
        self.frozen = {row["asset_id"]: row for row in universe}
        if len(self.frozen) != len(universe):
            raise ValueError("Frozen universe contains duplicate security UUIDs")
        self.manifest = manifest
        self.facts = facts
        self._engines: dict[str, FactEngine] = {}

    def engine(self, time_policy: str) -> FactEngine:
        if time_policy not in self._engines:
            self._engines[time_policy] = FactEngine(
                self.facts, self.manifest.get("source_timezones", {}), time_policy
            )
        return self._engines[time_policy]

    def limitations(self) -> list[str]:
        return list(self.manifest.get("limitations", [])) + LIMITATIONS


class _Samples:
    """Issuer code, decision instant and report-period limit of each sample row."""

    def __init__(self, inputs: FactInputs, engine: FactEngine, samples: pd.DataFrame):
        def issuer(asset: Any) -> int:
            identity = inputs.frozen.get(asset, {})
            cik = str(identity.get("cik", ""))
            if not (
                identity.get("issuer_mapping_status") == "verified"
                and cik.isdigit()
                and len(cik) <= 10
                and int(cik) > 0
            ):
                return _UNVERIFIED
            return engine.cik_index.get(cik.zfill(10), -1)

        self.cik = _per_value(samples["asset_id"], issuer, np.int64)
        self.decision = clocks.instants(samples["decision_at"])
        self.signal = _per_value(
            samples["signal_session"],
            lambda value: clocks.day(value).toordinal(),
            np.int64,
        )
        # report_period_end (optional) caps the report periods, never the decision.
        self.limit = (
            self.capped(_per_value(samples["report_period_end"], _ordinal, np.int64))
            if "report_period_end" in samples.columns
            else self.signal.copy()
        )

    def capped(self, ordinal: np.ndarray) -> np.ndarray:
        return np.where(ordinal > 0, np.minimum(self.signal, ordinal), 0)

    def evaluate(
        self,
        engine: FactEngine,
        metric: str,
        unit: str,
        period_kind: str,
        limit: np.ndarray | None = None,
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        size = len(self.cik)
        status = np.full(size, MAPPING_MISSING, dtype=np.int8)
        chosen = np.full(size, -1, dtype=np.int64)
        value = np.full(size, np.nan)
        verified = self.cik != _UNVERIFIED
        status[verified & (self.decision == NAT)] = CLOCK_UNKNOWN
        query = np.flatnonzero(verified & (self.decision != NAT))
        status[query], chosen[query], value[query] = engine.evaluate(
            metric,
            unit,
            period_kind,
            self.cik[query],
            self.decision[query],
            (self.limit if limit is None else limit)[query],
        )
        return status, chosen, value


def _pick(values: np.ndarray, chosen: np.ndarray, fill: Any) -> np.ndarray:
    """``values`` of the selected rows (-1: none -> ``fill``)."""
    result = np.full(len(chosen), fill, dtype=values.dtype)
    picked = chosen >= 0
    result[picked] = values[chosen[picked]]
    return result


def _feature_columns(
    engine: FactEngine,
    result: tuple[np.ndarray, np.ndarray, np.ndarray],
    names: Sequence[str],
) -> dict[str, Any]:
    """Columns ``names`` (feature fields or provenance) of one metric's result."""
    status, chosen, value = result
    picked = chosen >= 0
    unclocked = picked & (_pick(engine.public, chosen, NAT) == NAT)
    columns: dict[str, Any] = {}
    for name in names:
        if name == "value":
            columns[name] = value
        elif name == "status":
            columns[name] = np.asarray(STATUSES, dtype=object)[status]
        elif name == "raw_value":
            columns[name] = _pick(engine.value, chosen, None)
        elif name == "available_at":
            columns[name] = clocks.utc(_pick(engine.available, chosen, NAT)).array
        elif name == "public_clock_missing":
            columns[name] = unclocked
        elif name == "availability_basis":
            basis = np.full(len(chosen), "", dtype=object)
            basis[picked] = engine.policy
            basis[unclocked] = "observed_only"
            columns[name] = basis
        else:
            columns[name] = _pick(_column(engine.frame, name), chosen, None)
    return columns


def _features(
    inputs: FactInputs,
    samples: pd.DataFrame,
    metrics: Mapping[str, str],
    period_kind: str,
    time_policy: str,
    provenance: bool,
) -> pd.DataFrame:
    engine = inputs.engine(time_policy)
    rows = _Samples(inputs, engine, samples)
    data: dict[str, Any] = {}
    for metric, unit in metrics.items():
        result = rows.evaluate(engine, metric, unit, period_kind)
        if provenance:
            fields = _feature_columns(engine, result, (*FEATURE_FIELDS, *PROVENANCE))
        else:
            fields = {
                "value": result[2],
                "status": pd.Categorical.from_codes(result[0], STATUSES),
            }
        data.update({f"{metric}_{name}": column for name, column in fields.items()})
    result = pd.concat(
        [samples[KEYS].copy(), pd.DataFrame(data, index=samples.index)], axis=1
    )
    result.attrs["parameters"] = {
        "metrics": dict(metrics),
        "period_kind": period_kind,
        "time_policy": time_policy,
    }
    result.attrs["limitations"] = inputs.limitations()
    return result


def _check_metrics(metrics: Any) -> dict[str, str]:
    if (
        not isinstance(metrics, Mapping)
        or not metrics
        or any(
            not isinstance(metric, str)
            or not metric
            or not isinstance(unit, str)
            or not unit
            for metric, unit in metrics.items()
        )
    ):
        raise ValueError("metrics must map each requested metric to an explicit unit")
    return dict(metrics)


def _check_samples(samples: pd.DataFrame) -> None:
    if not set(KEYS + ["decision_at"]).issubset(samples.columns):
        raise ValueError("Samples require candidate keys and decision_at")


def prepare_fundamental_features(
    version_or_material: Any,
    samples: pd.DataFrame,
    *,
    metrics: Mapping[str, str],
    period_kind: str = "quarter",
    time_policy: str,
    provenance: bool = True,
) -> pd.DataFrame:
    """Join explicit-unit SEC facts to frozen candidate UUIDs without dropping rows.

    A fact is available at or before the decision: public_reconstructed uses its public
    clock (SEC filing-date rule), observed_content also needs its capture by the
    decision plus CAPTURE_GRACE. ``provenance=False`` returns only ``{metric}_value``
    and a categorical ``{metric}_status``.
    """
    metrics = _check_metrics(metrics)
    clocks.policy(time_policy)
    _check_samples(samples)
    inputs = FactInputs(version_or_material, samples["asset_id"], list(metrics))
    return _features(inputs, samples, metrics, period_kind, time_policy, provenance)


def _previous_year(ordinal: np.ndarray) -> np.ndarray:
    """The same calendar day a year earlier (February 29 -> 28); 0 stays 0."""

    def shift(value: int) -> int:
        if value <= 0:
            return 0
        day = date.fromordinal(value)
        try:
            return day.replace(year=day.year - 1).toordinal()
        except ValueError:
            return day.replace(year=day.year - 1, day=28).toordinal()

    return _per_value(ordinal, shift, np.int64)


class _Selection:
    """Selected rows of one metric with code access to their provenance fields."""

    def __init__(
        self, engine: FactEngine, result: tuple[np.ndarray, np.ndarray, np.ndarray]
    ) -> None:
        self.engine = engine
        self.result = result
        self.status = np.asarray(STATUSES, dtype=object)[result[0]]
        self.chosen = result[1]
        self.value = result[2]
        self.picked = self.chosen >= 0
        self.usable = np.isin(result[0], [OK, OK_OBSERVED]) & np.isfinite(self.value)
        self.observed_only = result[0] == OK_OBSERVED

    def code(self, name: str) -> np.ndarray:
        return _pick(self.engine.codes(name)[0], self.chosen, -1)

    def truthy(self, name: str) -> np.ndarray:
        return _pick(self.engine.codes(name)[1], self.chosen, False)

    def equals(self, name: str, text: str) -> np.ndarray:
        return _pick(self.engine.equals(name, text), self.chosen, False)

    def ordinals(self, name: str, rows: np.ndarray) -> np.ndarray:
        """Date ordinals of field ``name`` on ``rows`` (0 when missing)."""
        cells = _column(self.engine.frame, name)
        result = np.zeros(len(self.chosen), dtype=np.int64)
        result[rows] = _per_value(cells[self.chosen[rows]], _ordinal, np.int64)
        return result


def _ratios(
    inputs: FactInputs,
    samples: pd.DataFrame,
    currency: str,
    period_kind: str,
    time_policy: str,
    provenance: bool,
) -> pd.DataFrame:
    engine = inputs.engine(time_policy)
    rows = _Samples(inputs, engine, samples)
    size = len(samples)
    current = {
        metric: _Selection(engine, rows.evaluate(engine, metric, currency, period_kind))
        for metric in RATIO_INPUTS
    }
    revenue = current["revenue"]
    end = revenue.ordinals("period_end", np.flatnonzero(revenue.picked))
    prior = _Selection(
        engine,
        rows.evaluate(
            engine,
            "revenue",
            currency,
            period_kind,
            rows.capped(_previous_year(end)),
        ),
    )
    code = {name: index for index, name in enumerate(RATIO_STATUSES)}

    def input_status(names: Sequence[str]) -> np.ndarray:
        status = np.full(size, -1, dtype=np.int64)

        def first(mask: np.ndarray, name: str) -> None:
            status[(status < 0) & mask] = code[name]

        selections = [current[name] for name in names]
        first(
            ~np.logical_and.reduce([item.usable for item in selections]),
            "input_unavailable",
        )
        first(
            ~np.logical_and.reduce(
                [item.truthy(field) for item in selections for field in RATIO_BASIS]
            ),
            "basis_missing",
        )
        first(
            ~np.logical_and.reduce(
                [
                    item.equals("unit", currency) & item.equals("currency", currency)
                    for item in selections
                ]
            ),
            "unit_mismatch",
        )
        for field, name in RATIO_MISMATCHES:
            base = selections[0].code(field)
            first(
                np.logical_or.reduce(
                    [np.zeros(size, dtype=bool)]
                    + [item.code(field) != base for item in selections[1:]]
                ),
                name,
            )
        first(
            np.logical_or.reduce([item.observed_only for item in selections]),
            "ok_observed_only",
        )
        first(np.ones(size, dtype=bool), "ok")
        return status

    usable = (code["ok"], code["ok_observed_only"])
    derived: dict[str, tuple[np.ndarray, np.ndarray]] = {}
    with np.errstate(divide="ignore", invalid="ignore", over="ignore"):
        for name, used in RATIO_DEFINITIONS:
            status = input_status(used)
            good = np.isin(status, usable)
            numerator = current[used[0]].value
            if name.startswith("free_cash_flow"):
                numerator = numerator - current["capex"].value
            if name != "free_cash_flow":
                zero = good & (revenue.value == 0)
                status[zero] = code["zero_revenue"]
                good &= ~zero
                numerator = numerator / np.where(good, revenue.value, 1.0)
            value = np.where(good, numerator, np.nan)
            broken = good & ~np.isfinite(value)
            status[broken], value[broken] = code["nonfinite_result"], np.nan
            derived[name] = value, status
        status = input_status(("revenue",))
        good = np.isin(status, usable)
        checks = (
            ("prior_unavailable", lambda: ~np.isin(prior.result[0], [OK, OK_OBSERVED])),
            (
                "prior_basis_mismatch",
                lambda: np.logical_or.reduce(
                    [
                        prior.code(field) != revenue.code(field)
                        for field in ("cik", "unit", "currency")
                    ]
                ),
            ),
            ("unverified_prior_period", lambda: _unverified(revenue, prior, good)),
            ("zero_prior_revenue", lambda: prior.value == 0),
        )
        for name, mask in checks:
            hit = good & mask()
            status[hit] = code[name]
            good &= ~hit
        growth = np.full(size, np.nan)
        growth[good] = revenue.value[good] / prior.value[good] - 1
        either = revenue.observed_only | prior.observed_only
        status[good] = np.where(either[good], code["ok_observed_only"], code["ok"])
        broken = good & ~np.isfinite(growth)
        status[broken], growth[broken] = code["nonfinite_result"], np.nan
        derived["revenue_yoy"] = growth, status
    data: dict[str, Any] = {}
    if provenance:
        for prefix, selections in (
            ("source", current),
            ("prior", {"revenue": prior}),
        ):
            for metric, selection in selections.items():
                columns = _feature_columns(
                    engine, selection.result, (*FEATURE_FIELDS, *PROVENANCE)
                )
                for field in RATIO_REFERENCES:
                    data[f"{prefix}_{metric}_{field}"] = columns[field]
    names = np.asarray(RATIO_STATUSES, dtype=object)
    for metric in RATIO_METRICS:
        value, status = derived[metric]
        data[f"{metric}_value"] = value
        data[f"{metric}_status"] = (
            names[status]
            if provenance
            else pd.Categorical.from_codes(status, RATIO_STATUSES)
        )
    result = pd.concat(
        [samples[KEYS].copy(), pd.DataFrame(data, index=samples.index)], axis=1
    )
    result.attrs["parameters"] = {
        "currency": currency,
        "period_kind": period_kind,
        "time_policy": time_policy,
    }
    result.attrs["limitations"] = inputs.limitations() + [YOY_LIMITATION]
    return result


def _unverified(current: _Selection, prior: _Selection, good: np.ndarray) -> np.ndarray:
    """Rows whose prior period is not the current period shifted back one year."""
    rows = np.flatnonzero(good)
    result = np.zeros(len(good), dtype=bool)
    for field in ("period_start", "period_end"):
        present = prior.truthy(field)
        shown = prior.ordinals(field, rows[present[rows]])
        expected = _previous_year(current.ordinals(field, rows))
        result |= ~present | (shown != expected) | (expected == 0)
    return result


def prepare_fundamental_ratios(
    version_or_material: Any,
    samples: pd.DataFrame,
    *,
    currency: str = "USD",
    period_kind: str = "quarter",
    time_policy: str,
    provenance: bool = True,
) -> pd.DataFrame:
    """Six derived financial features with explicit source and comparison bases.

    Inputs share issuer, period, currency and accession. The prior-year revenue is the
    latest report for a period ending at or before one year before the current period,
    as known at the same decision. ``provenance=False`` leaves out the source and prior
    reference columns and makes each status categorical.
    """
    _check_metrics(dict.fromkeys(RATIO_INPUTS, currency))
    clocks.policy(time_policy)
    _check_samples(samples)
    inputs = FactInputs(version_or_material, samples["asset_id"], list(RATIO_INPUTS))
    return _ratios(inputs, samples, currency, period_kind, time_policy, provenance)


# ---------------------------------------------------------------------------
# Split-free builders over candidates or symbols (Layer 2)
# ---------------------------------------------------------------------------


def default_metrics(period_kind: str) -> dict[str, str]:
    if period_kind == "instant":
        return dict(INSTANT_METRICS)
    if period_kind == "quarter":
        return {
            name: unit
            for name, unit in DURATION_METRICS.items()
            if name not in QUARTER_DEFAULT_EXCLUDED_METRICS
        }
    if period_kind == "annual":
        return dict(DURATION_METRICS)
    return dict(ALL_METRICS)


def _period_kinds(period_kind: str | Sequence[str], every: Sequence[str]) -> list[str]:
    if period_kind == "all":
        return list(every)
    return [period_kind] if isinstance(period_kind, str) else list(period_kind)


def _merge_periods(
    samples: pd.DataFrame, parts: Mapping[str, pd.DataFrame]
) -> pd.DataFrame:
    merged = samples[KEYS].copy()
    for period_kind, part in parts.items():
        values = [column for column in part.columns if column not in KEYS]
        merged = pd.concat(
            [
                merged,
                part[values].rename(
                    columns={column: f"{period_kind}_{column}" for column in values}
                ),
            ],
            axis=1,
        )
    return merged


def features_by_period(
    version: Any,
    samples: pd.DataFrame,
    metrics: Mapping[str, Mapping[str, str]],
    *,
    time_policy: str,
    provenance: bool,
    inputs: FactInputs | None = None,
) -> pd.DataFrame:
    """Features of each period kind (``{period_kind: {metric: unit}}``); several kinds
    prefix their columns with ``{period_kind}_``."""
    metrics = {kind: _check_metrics(names) for kind, names in metrics.items()}
    clocks.policy(time_policy)
    _check_samples(samples)
    if inputs is None:
        wanted = dict.fromkeys(name for names in metrics.values() for name in names)
        inputs = FactInputs(version, samples["asset_id"], list(wanted))
    parts = {
        kind: _features(inputs, samples, names, kind, time_policy, provenance)
        for kind, names in metrics.items()
    }
    if len(parts) == 1:
        return next(iter(parts.values()))
    merged = _merge_periods(samples, parts)
    merged.attrs["parameters"] = {
        "period_kinds": list(parts),
        "time_policy": time_policy,
    }
    return merged


def ratios_by_period(
    version: Any,
    samples: pd.DataFrame,
    period_kinds: Sequence[str],
    *,
    currency: str,
    time_policy: str,
    provenance: bool,
    inputs: FactInputs | None = None,
) -> pd.DataFrame:
    """Ratios of each period kind; several kinds prefix their columns."""
    _check_metrics(dict.fromkeys(RATIO_INPUTS, currency))
    clocks.policy(time_policy)
    _check_samples(samples)
    if inputs is None:
        inputs = FactInputs(version, samples["asset_id"], list(RATIO_INPUTS))
    parts = {
        kind: _ratios(inputs, samples, currency, kind, time_policy, provenance)
        for kind in period_kinds
    }
    if len(parts) == 1:
        return next(iter(parts.values()))
    merged = _merge_periods(samples, parts)
    merged.attrs["parameters"] = {
        "currency": currency,
        "period_kinds": list(parts),
        "time_policy": time_policy,
    }
    return merged


def fundamental_features(
    version: Any,
    candidates_or_symbols: pd.DataFrame | str | Sequence[str] | None = None,
    *,
    time_policy: str,
    start: str | date | None = None,
    end: str | date | None = None,
    metrics: Mapping[str, str] | Sequence[str] | None = None,
    period_kind: str | Sequence[str] = "quarter",
    provenance: bool = True,
) -> pd.DataFrame:
    """Return PIT-aligned fundamental features as a ``pd.DataFrame``.

    - ``metrics`` may be ``None`` (standard duration or instant metrics for ``period_kind``;
      quarterly defaults omit the year-to-date cash-flow metrics),
      a sequence of metric names (auto-mapped via ``ALL_METRICS``), or an explicit ``{metric: unit}`` mapping.
    - ``period_kind`` may be ``"quarter"``, ``"annual"``, ``"instant"``, ``"all"``, or a sequence of period kinds.
      When multiple period kinds are requested, columns are prefixed with ``{period_kind}_``.
    - ``provenance=False`` keeps only each metric's value and categorical status.
    """
    samples = ensure_samples(version, candidates_or_symbols, start=start, end=end)

    def resolve(kind: str) -> dict[str, str]:
        if metrics is None:
            return default_metrics(kind)
        if isinstance(metrics, Mapping):
            return dict(metrics)
        return {name: ALL_METRICS.get(name, "USD") for name in metrics}

    kinds = _period_kinds(period_kind, ("quarter", "annual", "instant"))
    return features_by_period(
        version,
        samples,
        {kind: resolve(kind) for kind in kinds},
        time_policy=time_policy,
        provenance=provenance,
    )


def fundamental_ratios(
    version: Any,
    candidates_or_symbols: pd.DataFrame | str | Sequence[str] | None = None,
    *,
    time_policy: str,
    start: str | date | None = None,
    end: str | date | None = None,
    currency: str = "USD",
    period_kind: str | Sequence[str] = "quarter",
    provenance: bool = True,
) -> pd.DataFrame:
    """Return PIT-aligned fundamental ratios as a ``pd.DataFrame``.

    ``period_kind`` may be ``"quarter"``, ``"annual"``, or ``("quarter", "annual")``.
    """
    samples = ensure_samples(version, candidates_or_symbols, start=start, end=end)
    kinds = [period_kind] if isinstance(period_kind, str) else list(period_kind)
    return ratios_by_period(
        version,
        samples,
        kinds,
        currency=currency,
        time_policy=time_policy,
        provenance=provenance,
    )

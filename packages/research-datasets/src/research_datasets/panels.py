"""Point-in-time (PIT) pandas DataFrame panel builders for frozen research datasets.

Every high-level function returns a ``pandas.DataFrame`` directly without requiring
preset train/validation/test split boundaries. ``time_policy`` is always explicit.
"""

from __future__ import annotations

import hashlib
import json
import platform
from bisect import bisect_right
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from dataclasses import field as _field
from datetime import date, datetime, time, timedelta
from decimal import Decimal, InvalidOperation
from functools import lru_cache
from pathlib import Path
from typing import Any
from uuid import UUID
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd
import pyarrow

from .constants import (
    ALL_METRICS,
    CAPTURE_GRACE,
    COUNT_SOURCES,
    DECISION_TIME,
    DURATION_METRICS,
    INSTANT_METRICS,
    KEYS,
    LABEL_CLOSE_TIME,
    LABEL_OPEN_TIME,
    NEW_YORK_ZONE,
    NOT_LISTED_CODES,
    POLICIES,
    QUARTER_DEFAULT_EXCLUDED_METRICS,
    QUARTER_DEFAULT_EXCLUDED_RATIOS,
    RANK_WINDOW_SESSIONS,
    RATIO_METRICS,
    SEC_DISSEMINATION_START,
    SOURCE_CONTRACTS,
    STORY_WINDOW,
    TIME_POLICY_VERSION,
    VETO_CODES,
    SourceContract,
    __version__,
)

NEW_YORK = ZoneInfo(NEW_YORK_ZONE)
_CAPTURE_DEADLINE = (
    datetime.combine(date(2000, 1, 3), DECISION_TIME) + CAPTURE_GRACE
).time()
LIMITATIONS = [
    "Vendor-adjusted prices can be revised; this is not a strict price-PIT dataset.",
    "The frozen research universe is not a historical eligibility universe.",
    "Adjusted open-to-close ratios are analytical proxies, not fills or net PnL.",
    "A date-only calendar uses 16:00 New York label ends, conservatively including early-close days.",
    "A row is decided at 06:00 New York on its entry session and sees information public at or before then; its event window is (06:00 on the signal session, 06:00 on the entry session].",
    "SEC filings are public at max(acceptance, 06:00 New York on the SEC filing date); observed_content also requires each capture by 09:00 New York on the entry session.",
    "Under public_reconstructed, event links come from each event's latest saved version and coverage comes from saved check windows regardless of when they ran.",
    "Unverified-identity, not-listed and truncated check windows stay missing, never 0; source coverage describes saved checks, not publication completeness.",
    "sec counts keep the 8-K, 10-K, 10-Q, 6-K and 20-F forms; sources without a publication clock produce no count features.",
    "21-session event ranks are percentiles over the universe's non-benchmark securities and stay missing unless the selection holds all of them.",
    "Quarterly cash-flow facts are year-to-date in 10-Q filings, so default quarterly columns omit operating cash flow, capex and free cash flow.",
]


@lru_cache(maxsize=65536)
def _day_str(value: str) -> date:
    return date.fromisoformat(value[:10])


def _day(value: Any) -> date:
    if isinstance(value, date) and not isinstance(value, datetime):
        return value
    return _day_str(str(value))


@lru_cache(maxsize=131072)
def _clock_str(value: str) -> pd.Timestamp | None:
    try:
        parsed = pd.Timestamp(value)
    except (TypeError, ValueError):
        return None
    if pd.isna(parsed) or parsed.tzinfo is None:
        return None
    return parsed.tz_convert("UTC")


def _clock(value: Any) -> pd.Timestamp | None:
    """Only offset-bearing timestamps establish an instant."""
    if value is None or value is pd.NaT:
        return None
    if isinstance(value, str):
        return _clock_str(value) if value else None
    if pd.isna(value):
        return None
    if isinstance(value, pd.Timestamp):
        if value.tzinfo is None:
            return None
        return value.tz_convert("UTC")
    return _clock_str(str(value))


@lru_cache(maxsize=16384)
def _at(day: date, hour: int, minute: int = 0) -> pd.Timestamp:
    return pd.Timestamp(datetime.combine(day, time(hour, minute), NEW_YORK)).tz_convert(
        "UTC"
    )


def _decision_at(day: date) -> pd.Timestamp:
    return _at(day, DECISION_TIME.hour, DECISION_TIME.minute)


def _policy(time_policy: str) -> str:
    if time_policy not in POLICIES:
        raise ValueError(
            "Choose an explicit supported time policy: " + " or ".join(POLICIES)
        )
    return time_policy


def _mapping(value: Any) -> dict[str, Any]:
    if isinstance(value, Mapping):
        return dict(value)
    if isinstance(value, (list, tuple, np.ndarray)):
        return dict(
            (item["key"], item["value"]) if isinstance(item, Mapping) else item
            for item in value
        )
    return {}


def _date_field(row: Mapping[str, Any], *names: str) -> date | None:
    """The first present YYYY-MM-DD field; a malformed present value gives None."""
    for name in names:
        value = row.get(name)
        if isinstance(value, str) and value:
            try:
                return _day_str(value)
            except ValueError:
                return None
    return None


def _source_zone(source: str, source_timezones: Mapping[str, str]) -> ZoneInfo:
    contract = SOURCE_CONTRACTS.get(source)
    for name in (
        source_timezones.get(source),
        contract.timezone if contract else NEW_YORK_ZONE,
    ):
        if name:
            try:
                return ZoneInfo(name)
            except (ValueError, KeyError):
                continue
    return NEW_YORK


def _public_clock(
    row: Mapping[str, Any], source_timezones: Mapping[str, str]
) -> pd.Timestamp | None:
    precision = row.get("public_time_precision")
    if not isinstance(precision, str):
        return None
    source = str(row.get("source", ""))
    contract = SOURCE_CONTRACTS.get(source)
    if precision == "second":
        public = _clock(row.get("public_at"))
        if (
            public is not None
            and contract is not None
            and contract.clock == "sec_filing"
        ):
            # SEC assigns the next business day to filings accepted after 17:30 or on
            # non-business days, and disseminates from 06:00 on the filing date.
            filed = _date_field(row, "filing_date", "filed")
            if filed is not None:
                public = max(
                    public,
                    _at(
                        filed,
                        SEC_DISSEMINATION_START.hour,
                        SEC_DISSEMINATION_START.minute,
                    ),
                )
        return public
    if precision != "date":
        return None
    public_date = row.get("public_date")
    if public_date is None or pd.isna(public_date) or public_date == "":
        return None
    zone = source_timezones.get(source) or (contract.timezone if contract else None)
    if not zone:
        return None
    try:
        next_day = _day(public_date) + timedelta(days=1)
        return pd.Timestamp(
            datetime.combine(next_day, time(), ZoneInfo(zone))
        ).tz_convert("UTC")
    except (ValueError, KeyError):
        return None


@dataclass
class _EventIndex:
    """Count-source events reduced for one policy, plus what was left out."""

    policy: str
    # public_reconstructed: per (asset, source) sorted first public clocks and the
    # [start, end) days of events without any public clock.
    placed: dict[tuple[str, str], list[pd.Timestamp]] = _field(default_factory=dict)
    missing: dict[tuple[str, str], list[tuple[pd.Timestamp, pd.Timestamp]]] = _field(
        default_factory=dict
    )
    # observed_content: per (asset, source) version chains and first-known clocks.
    histories: dict[tuple[str, str], list[tuple[Any, list[dict[str, Any]], Any]]] = (
        _field(default_factory=dict)
    )
    first_known: dict[tuple[str, str, Any], pd.Timestamp] = _field(default_factory=dict)
    skipped: dict[str, int] = _field(default_factory=dict)
    undatable: dict[str, int] = _field(default_factory=dict)


def _story_keys(news_versions: pd.DataFrame | None) -> dict[tuple[str, str], str]:
    """(source, event_id) -> story key of the article's earliest saved text version."""
    if (
        news_versions is None
        or news_versions.empty
        or not {"event_id", "story_key"}.issubset(news_versions.columns)
    ):
        return {}
    frame = news_versions
    if "provider_updated_at" in frame.columns:
        frame = frame.sort_values(
            ["provider_updated_at", "story_key"], kind="stable", na_position="last"
        )
    keys: dict[tuple[str, str], str] = {}
    sources = (
        frame["source"] if "source" in frame.columns else [None] * len(frame.index)
    )
    for event_id, story, source in zip(frame["event_id"], frame["story_key"], sources):
        if isinstance(story, str) and story and event_id is not None:
            name = source if isinstance(source, str) and source else "alpaca_news"
            keys.setdefault((name, str(event_id)), story)
    return keys


def _story(
    row: Mapping[str, Any], source: str, stories: Mapping[tuple[str, str], str]
) -> str | None:
    value = row.get("story_key")
    if isinstance(value, str) and value:
        return value
    event_id = row.get("event_id")
    if isinstance(event_id, str) and event_id:
        return stories.get((source, event_id))
    return None


def _first_of_story(
    entries: list[tuple[pd.Timestamp, str | None, Any]],
) -> list[tuple[pd.Timestamp, Any]]:
    """Keep one entry per story key and STORY_WINDOW, anchored at the first entry."""
    entries.sort(key=lambda entry: (entry[0], str(entry[2])))
    anchors: dict[str, pd.Timestamp] = {}
    kept = []
    for instant, story, uid in entries:
        if story:
            anchor = anchors.get(story)
            if anchor is not None and instant < anchor + STORY_WINDOW:
                continue
            anchors[story] = instant
        kept.append((instant, uid))
    return kept


def _event_index(
    observations: pd.DataFrame,
    asset_ids: set[str],
    policy: str,
    source_timezones: Mapping[str, str],
    stories: Mapping[tuple[str, str], str],
) -> _EventIndex:
    """Reduce observation versions of count sources; rows of unknown sources are counted."""
    index = _EventIndex(policy)
    chains: dict[tuple[str, Any], list[dict[str, Any]]] = {}
    for row in observations.to_dict("records"):
        source = row.get("source")
        contract = SOURCE_CONTRACTS.get(source) if isinstance(source, str) else None
        if contract is None:
            name = source if isinstance(source, str) and source else "(missing)"
            index.skipped[name] = index.skipped.get(name, 0) + 1
            continue
        if not contract.counts:
            continue
        event_uid = row.get("event_uid")
        if not event_uid:
            raise ValueError("Observation requires a logical event_uid")
        sequence = row.get("observation_sequence")
        if (
            not isinstance(sequence, (int, np.integer))
            or isinstance(sequence, bool)
            or sequence < 0
        ):
            raise ValueError("Observation requires a nonnegative observation_sequence")
        linked = row.get("asset_ids")
        chains.setdefault((source, event_uid), []).append(
            {
                "row": row,
                "sequence": int(sequence),
                "public": _public_clock(row, source_timezones),
                "links": [] if linked is None else [str(asset) for asset in linked],
            }
        )
    placed: dict[tuple[str, str], list[tuple[pd.Timestamp, str | None, Any]]] = {}
    for (source, event_uid), versions in chains.items():
        versions.sort(key=lambda version: version["sequence"])
        if len({version["sequence"] for version in versions}) != len(versions):
            raise ValueError("Duplicate observation_sequence for one logical event")
        contract = SOURCE_CONTRACTS[source]
        latest = versions[-1]["row"]
        if contract.count_forms is not None and "form" in latest:
            _mark_count_forms(versions, contract.count_forms)
            # Reconstruction reads the latest saved form; observed_content the selected one.
            if not (
                versions[-1]["counts"]
                if policy == "public_reconstructed"
                else any(version["counts"] for version in versions)
            ):
                continue
        story = _story(latest, source, stories)
        if policy == "public_reconstructed":
            zone = _source_zone(source, source_timezones)
            _place_reconstructed(
                index, placed, (source, event_uid), versions, asset_ids, story, zone
            )
        else:
            _place_observed(index, (source, event_uid), versions, asset_ids, story)
    for key, entries in placed.items():
        index.placed[key] = [instant for instant, _ in _first_of_story(entries)]
    return index


def _mark_count_forms(versions: list[dict[str, Any]], forms: frozenset[str]) -> None:
    """Each version counts by its form, or by the latest earlier form when it has none."""
    form = None
    for version in versions:
        value = version["row"].get("form")
        if isinstance(value, str) and value:
            form = value
        version["counts"] = form is not None and form.removesuffix("/A") in forms


def _place_reconstructed(
    index: _EventIndex,
    placed: dict[tuple[str, str], list[tuple[pd.Timestamp, str | None, Any]]],
    chain: tuple[str, Any],
    versions: list[dict[str, Any]],
    asset_ids: set[str],
    story: str | None,
    zone: ZoneInfo,
) -> None:
    """Links of the latest version from the earliest public clock: order-independent."""
    source, event_uid = chain
    links = [
        asset for asset in dict.fromkeys(versions[-1]["links"]) if asset in asset_ids
    ]
    if not links:
        return
    publics = [
        version["public"] for version in versions if version["public"] is not None
    ]
    if publics:
        first = min(publics)
        for asset in links:
            placed.setdefault((asset, source), []).append((first, story, event_uid))
        return
    day = _date_field(versions[-1]["row"], "event_date", "filing_date")
    if day is None:
        index.undatable[source] = index.undatable.get(source, 0) + 1
        return
    start = pd.Timestamp(datetime.combine(day, time(), zone)).tz_convert("UTC")
    end = pd.Timestamp(
        datetime.combine(day + timedelta(days=1), time(), zone)
    ).tz_convert("UTC")
    for asset in links:
        index.missing.setdefault((asset, source), []).append((start, end))


def _place_observed(
    index: _EventIndex,
    chain: tuple[str, Any],
    versions: list[dict[str, Any]],
    asset_ids: set[str],
    story: str | None,
) -> None:
    """Keep the version chain with capture-bounded clocks and association times."""
    source, event_uid = chain
    history = []
    for version in versions:
        row, public = version["row"], version["public"]
        content = _clock(row.get("content_first_seen_at"))
        recorded = _clock(row.get("observation_recorded_at"))
        invalid_public = (
            row.get("public_time_precision") in {"second", "date"} and public is None
        )
        available = None
        if content is not None and recorded is not None and not invalid_public:
            available = max(
                clock
                for clock in (public, content - CAPTURE_GRACE, recorded - CAPTURE_GRACE)
                if clock is not None
            )
        associations = _mapping(row.get("asset_first_seen_at"))
        assets: dict[str, pd.Timestamp | None] = {}
        for asset_id in set(version["links"]).intersection(asset_ids):
            association = _clock(associations.get(asset_id))
            assets[asset_id] = (
                max(available, association - CAPTURE_GRACE)
                if available is not None and association is not None
                else None
            )
        history.append(
            {
                "sequence": version["sequence"],
                "available": available,
                "recorded": recorded,
                "assets": assets,
                "public_missing": public is None,
                "counts": version.get("counts", True),
            }
        )
    for version in history:
        for asset, available in version["assets"].items():
            key = (asset, source, event_uid)
            if available is not None and (
                key not in index.first_known or available < index.first_known[key]
            ):
                index.first_known[key] = available
    for asset in set().union(*(version["assets"] for version in history)):
        index.histories.setdefault((asset, source), []).append(
            (event_uid, history, story)
        )


def _window_events(
    index: _EventIndex,
    asset_id: str,
    source: str,
    previous: pd.Timestamp,
    decision: pd.Timestamp,
) -> tuple[int, bool, bool]:
    """Events first available in (previous, decision], clock gaps and missing publics."""
    if pd.isna(decision):
        return 0, False, False
    key = (asset_id, source)
    if index.policy == "public_reconstructed":
        instants = index.placed.get(key, [])
        count = bisect_right(instants, decision) - bisect_right(instants, previous)
        clock_missing = any(
            start <= decision and previous < end
            for start, end in index.missing.get(key, [])
        )
        return count, clock_missing, False
    clock_missing = False
    # Articles linked to the security at this decision; stories dedupe among them only.
    linked: list[tuple[pd.Timestamp, str | None, Any]] = []
    missing_public: dict[Any, bool] = {}
    for event_uid, versions, story in index.histories.get(key, []):
        selected = next(
            (
                version
                for version in reversed(versions)
                if version["available"] is not None and version["available"] <= decision
            ),
            None,
        )
        selected_sequence = selected["sequence"] if selected is not None else -1
        clock_missing |= any(
            version["available"] is None
            and version["sequence"] > selected_sequence
            and (
                version["recorded"] is None
                or version["recorded"] - CAPTURE_GRACE <= decision
            )
            for version in versions
        )
        if (
            selected is None
            or not selected["counts"]
            or asset_id not in selected["assets"]
        ):
            continue
        available = selected["assets"][asset_id]
        if available is None:
            clock_missing = True
            continue
        if available > decision:
            continue
        linked.append(
            (index.first_known[(asset_id, source, event_uid)], story, event_uid)
        )
        missing_public[event_uid] = selected["public_missing"]
    count, public_missing = 0, False
    for initial, event_uid in _first_of_story(linked):
        public_missing |= missing_public[event_uid]
        count += previous < initial <= decision
    return int(count), bool(clock_missing), bool(public_missing)


_COUNTABLE_STATUSES = frozenset({"checked", "empty", "not_changed"})
_STRONG_CLASSES = frozenset({"countable", "veto", "na"})


def _classify(status: str, code: str, contract: SourceContract) -> tuple[str, str]:
    """Coverage class and label of one check (see constants.VETO_CODES)."""
    if code in VETO_CODES:
        return "veto", "mapping_missing"
    if code in NOT_LISTED_CODES:
        return "na", "not_listed"
    if status in _COUNTABLE_STATUSES and not code:
        return "countable", "empty" if status == "empty" else "checked"
    if status == "partial" or status in _COUNTABLE_STATUSES:
        if code in contract.read_complete_codes:
            return "countable", "read_complete"
        if code in contract.countable_partial:
            return "countable", "checked"
        return "soft", "partial"
    return ("error" if status == "error" else "soft"), status or "unknown"


def _parse_checks(
    rows: Iterable[Mapping[str, Any]],
) -> list[tuple[pd.Timestamp, date | None, date | None, str, str]]:
    parsed = []
    for row in rows:
        checked = _clock(row.get("checked_at"))
        if checked is None:
            continue
        status, code = row.get("status"), row.get("error_code")
        status = status if isinstance(status, str) else "unknown"
        code = code if isinstance(code, str) else ""
        if not row.get("checked_start") or not row.get("checked_end"):
            parsed.append((checked, None, None, status, code))
        else:
            start, end = _day(row["checked_start"]), _day(row["checked_end"])
            parsed.append((checked, start, end, status, code))
    parsed.sort(key=lambda item: item[0])
    return parsed


def _coverage(
    checks: Sequence[tuple[pd.Timestamp, date | None, date | None, str, str]],
    contract: SourceContract,
    previous: pd.Timestamp,
    decision: pd.Timestamp,
    zone: ZoneInfo,
    policy: str,
) -> tuple[str, str]:
    """Window label and basis ('' unless every day of (previous, decision] is countable).

    public_reconstructed paints saved check windows in check order whenever they ran:
    countable, veto and not-listed checks overwrite, other checks only fill days that
    are not countable, and unbounded checks are ignored. observed_content keeps the
    latest covering check captured by the decision plus CAPTURE_GRACE.
    """
    if pd.isna(decision):
        return "unknown", ""
    first = previous.tz_convert(zone).date()
    last = decision.tz_convert(zone).date()
    days = [first + timedelta(days=offset) for offset in range((last - first).days + 1)]
    deadline = decision + CAPTURE_GRACE
    states: dict[date, tuple[str, str, pd.Timestamp | None]] = {}
    if policy == "observed_content":
        visible = [check for check in checks if check[0] <= deadline]
        windowed = [
            check
            for check in visible
            if check[1] is not None and check[1] <= last and check[2] >= first
        ]
        unbounded = [check for check in visible if check[1] is None]
        latest_unbounded = (
            max(unbounded, key=lambda check: check[0]) if unbounded else None
        )
        if not windowed:
            if latest_unbounded is None:
                return "unknown", ""
            cls, label = _classify(latest_unbounded[3], latest_unbounded[4], contract)
            return (label, "observed") if cls == "countable" else (label, "")
        if (
            latest_unbounded is not None
            and latest_unbounded[0] >= max(check[0] for check in windowed)
            and latest_unbounded[3] not in {"checked", "empty"}
        ):
            return latest_unbounded[3], ""
        for day in days:
            covering = [check for check in windowed if check[1] <= day <= check[2]]
            if covering:
                checked, _, _, status, code = max(covering, key=lambda check: check[0])
                cls, label = _classify(status, code, contract)
                states[day] = (cls, label, checked)
    else:
        for checked, start, end, status, code in checks:
            if start is None or start > last or end < first:
                continue
            cls, label = _classify(status, code, contract)
            for day in days:
                if not start <= day <= end:
                    continue
                current = states.get(day)
                if cls in _STRONG_CLASSES:
                    first_ok = None
                    if cls == "countable":
                        first_ok = (
                            current[2]
                            if current is not None and current[0] == "countable"
                            else checked
                        )
                    states[day] = (cls, label, first_ok)
                elif current is None or current[0] != "countable":
                    states[day] = (cls, label, None)
    labels = []
    for day in days:
        state = states.get(day)
        if state is None:
            return "unknown", ""
        if state[0] != "countable":
            return state[1], ""
        labels.append(state[1])
    label = (
        "empty"
        if all(value == "empty" for value in labels)
        else "read_complete"
        if "read_complete" in labels
        else "checked"
    )
    if policy == "observed_content":
        return label, "observed"
    observed = all(
        states[day][2] is not None and states[day][2] <= deadline for day in days
    )
    return label, "observed" if observed else "reconstructed"


def _prices(frame: pd.DataFrame, calendar: Sequence[date]) -> dict[str, pd.DataFrame]:
    required = {"asset_id", "date", "open", "close", "volume"}
    if not required.issubset(frame.columns):
        raise ValueError(
            f"Price material lacks columns: {sorted(required - set(frame.columns))}"
        )
    result = frame.copy()
    result["date"] = result["date"].map(_day)
    if result.duplicated(["asset_id", "date"]).any():
        raise ValueError("Duplicate security/session prices")
    for column in ("open", "close", "volume"):
        result[column] = pd.to_numeric(result[column], errors="coerce")
    return {
        str(asset): rows.set_index("date").reindex(calendar)
        for asset, rows in result.groupby("asset_id", observed=True)
    }


def _families(version: Any) -> Mapping[str, Any]:
    manifest = getattr(version, "manifest", None)
    families = manifest.get("data_families") if isinstance(manifest, Mapping) else None
    return families if isinstance(families, Mapping) else {}


def _news_versions(version: Any) -> pd.DataFrame | None:
    """Story keys of frozen article text versions, when the version has them."""
    if "news_versions" not in _families(version) or not hasattr(version, "family"):
        return None
    return version.family(
        "news_versions", columns=["event_id", "story_key", "provider_updated_at"]
    )


def _rank_population(universe: Any, benchmark_ids: Iterable[str]) -> frozenset[str]:
    """Universe members ranked against each other: not flagged or passed as benchmarks."""
    records = (
        universe.to_dict("records") if isinstance(universe, pd.DataFrame) else universe
    )
    members, flagged = set(), set(map(str, benchmark_ids))
    for row in records or []:
        if not isinstance(row, Mapping) or not row.get("asset_id"):
            continue
        members.add(str(row["asset_id"]))
        flag = row.get("is_benchmark")
        if isinstance(flag, (bool, np.bool_)) and bool(flag):
            flagged.add(str(row["asset_id"]))
    return frozenset(members - flagged)


def material_from_version(
    version: Any,
    dataset_id: str,
    asset_ids: Sequence[str],
    benchmark_id: str | None = None,
) -> dict[str, Any]:
    """Read frozen families only; missing capabilities deliberately raise."""
    if str(version.id) != dataset_id:
        raise ValueError("Version does not match the explicit dataset UUID")
    ids = list(
        dict.fromkeys(
            [*asset_ids, *([benchmark_id] if benchmark_id is not None else [])]
        )
    )
    return {
        "manifest": version.manifest,
        "manifest_sha256": version.manifest_sha256,
        "calendar": version.calendar,
        "universe": version.universe,
        "raw": version.prices(ids, adjusted=False),
        "all": version.prices(ids, adjusted=True),
        "event_observations": version.event_observations(),
        "source_checks": version.source_checks(asset_ids),
        "news_versions": _news_versions(version),
    }


def _feature_rows(
    calendar: Sequence[date],
    signals: Sequence[date],
    asset_ids: Sequence[str],
    raw: Mapping[str, pd.DataFrame],
    adjusted: Mapping[str, pd.DataFrame],
    observations: pd.DataFrame,
    checks: pd.DataFrame,
    policy: str,
    zones: Mapping[str, str],
    news_versions: pd.DataFrame | None = None,
    population: frozenset[str] = frozenset(),
) -> tuple[pd.DataFrame, dict[str, Any]]:
    """Daily features for contiguous signal sessions and the event reduction summary."""
    index = _event_index(
        observations, set(asset_ids), policy, zones, _story_keys(news_versions)
    )
    grouped: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for row in checks.to_dict("records"):
        if row.get("source") in COUNT_SOURCES:
            grouped.setdefault((str(row.get("asset_id")), row["source"]), []).append(
                row
            )
    parsed = {key: _parse_checks(rows) for key, rows in grouped.items()}
    zone_of = {source: _source_zone(source, zones) for source in COUNT_SOURCES}
    cal_index = {day: idx for idx, day in enumerate(calendar)}
    first, last = cal_index[signals[0]], cal_index[signals[-1]]
    # Earlier sessions feed the rolling counts of the first signals and are dropped.
    days = calendar[max(0, first - RANK_WINDOW_SESSIONS + 1) : last + 1]
    result = []
    for asset_id in asset_ids:
        bars = adjusted.get(asset_id)
        closes = pd.Series(np.nan, index=calendar) if bars is None else bars["close"]
        closes = closes.where(np.isfinite(closes) & (closes > 0))
        returns = closes / closes.shift(1) - 1
        consecutive = closes.rolling(21, min_periods=21).count() == 21
        momentum = (closes / closes.shift(20) - 1).where(consecutive)
        volatility = returns.rolling(20, min_periods=20).std(ddof=1).where(consecutive)
        nominal = raw.get(asset_id)
        for signal in days:
            position = cal_index[signal]
            decision = (
                _decision_at(calendar[position + 1])
                if position + 1 < len(calendar)
                else pd.NaT
            )
            previous = _decision_at(signal)
            close = np.nan if nominal is None else nominal.at[signal, "close"]
            volume = np.nan if nominal is None else nominal.at[signal, "volume"]
            dollars = (
                close * volume
                if np.isfinite(close)
                and close > 0
                and np.isfinite(volume)
                and volume >= 0
                else np.nan
            )
            feature: dict[str, Any] = {
                "asset_id": asset_id,
                "signal_session": signal,
                "previous_decision_at": previous,
                "decision_at": decision,
                "momentum20": momentum.loc[signal],
                "volatility20": volatility.loc[signal],
                "price_history_missing": not bool(consecutive.loc[signal]),
                "raw_dollar_volume": float(dollars),
                "raw_dollar_volume_missing": pd.isna(dollars),
            }
            for source in COUNT_SOURCES:
                count, clock_missing, public_missing = _window_events(
                    index, asset_id, source, previous, decision
                )
                coverage, basis = _coverage(
                    parsed.get((asset_id, source), ()),
                    SOURCE_CONTRACTS[source],
                    previous,
                    decision,
                    zone_of[source],
                    policy,
                )
                feature[f"{source}_new_event_count"] = (
                    count if basis and not clock_missing else np.nan
                )
                feature[f"{source}_observed_new_event_count"] = count
                feature[f"{source}_coverage"] = coverage
                feature[f"{source}_coverage_basis"] = basis
                feature[f"{source}_clock_missing"] = clock_missing
                feature[f"{source}_public_clock_missing"] = public_missing
            result.append(feature)
    frame = pd.DataFrame(result)
    owners = frame["asset_id"].to_numpy()
    # A rank is a percentile over the whole non-benchmark universe, so it exists only
    # when the selection holds every member; otherwise it would depend on the selection.
    ranked = bool(population) and population.issubset(asset_ids)
    for source in COUNT_SOURCES:
        column = f"{source}_new_event_count"
        frame[column] = frame[column].astype("Int64")
        values = pd.Series(
            frame[column].to_numpy(dtype="float64", na_value=np.nan), index=frame.index
        )
        # NaN unless every one of the 21 one-session windows is countable.
        total = values.groupby(owners, sort=False).transform(
            lambda series: series.rolling(
                RANK_WINDOW_SESSIONS, min_periods=RANK_WINDOW_SESSIONS
            ).sum()
        )
        frame[f"{source}_events_21d"] = total
        frame[f"{source}_events_rank_21d"] = (
            total.where(frame["asset_id"].isin(population))
            .groupby(frame["signal_session"])
            .rank(pct=True)
            if ranked
            else np.nan
        )
    frame = frame[frame["signal_session"] >= signals[0]].reset_index(drop=True)
    summary = {
        "skipped_sources": dict(sorted(index.skipped.items())),
        "undatable_events": dict(sorted(index.undatable.items())),
        "rank_population": {
            "basis": "universe_non_benchmark",
            "members": len(population),
            "selected": len(population.intersection(asset_ids)),
            "ranked": ranked,
        },
    }
    return frame, summary


def _time_parameters(time_policy: str) -> dict[str, Any]:
    return {
        "time_policy": time_policy,
        "time_policy_version": TIME_POLICY_VERSION,
        "decision_time": f"{DECISION_TIME:%H:%M} {NEW_YORK_ZONE}",
        "capture_deadline": f"{_CAPTURE_DEADLINE:%H:%M} {NEW_YORK_ZONE}",
    }


def _feature_provenance(
    features: pd.DataFrame, events: Mapping[str, Any]
) -> dict[str, Any]:
    return {
        "feature_masks": {
            column: int(features[column].sum())
            for column in features
            if column.endswith("_missing")
        },
        "source_coverage_counts": {
            source: {
                str(key): int(value)
                for key, value in features[f"{source}_coverage"].value_counts().items()
            }
            for source in COUNT_SOURCES
        },
        "source_coverage": _coverage_summary(features),
        "skipped_sources": dict(events["skipped_sources"]),
        "undatable_events": dict(events["undatable_events"]),
        "rank_population": dict(events["rank_population"]),
    }


def _coverage_summary(features: pd.DataFrame) -> dict[str, Any]:
    """Per count source: window labels, bases and the first countable signal session."""
    summary = {}
    for source in COUNT_SOURCES:
        basis = features[f"{source}_coverage_basis"]
        covered = features.loc[basis != "", "signal_session"]
        assets = features.loc[basis != "", "asset_id"]
        summary[source] = {
            "states": {
                str(key): int(value)
                for key, value in features[f"{source}_coverage"].value_counts().items()
            },
            "basis": {
                str(key): int(value)
                for key, value in basis[basis != ""].value_counts().items()
            },
            "first_covered_session": str(covered.min()) if len(covered) else None,
            "assets_with_coverage": int(assets.nunique()),
        }
    return summary


def _positive(value: Any) -> bool:
    return bool(pd.notna(value) and np.isfinite(value) and value > 0)


def _label_rows(
    features: pd.DataFrame,
    calendar: Sequence[date],
    adjusted: Mapping[str, pd.DataFrame],
    benchmark_id: str,
    horizon: int,
    material_end: date,
) -> pd.DataFrame:
    cal_index = {day: idx for idx, day in enumerate(calendar)}
    labels = []
    for row in features.itertuples(index=False):
        sig_day = _day(row.signal_session)
        index = cal_index[sig_day]
        entry_index, exit_index = index + 1, index + horizon
        entry = calendar[entry_index] if entry_index < len(calendar) else None
        exit_day = calendar[exit_index] if exit_index < len(calendar) else None
        beyond = exit_day is None or exit_day > material_end
        expected = calendar[entry_index : exit_index + 1] if not beyond else []
        bars, benchmark = adjusted.get(row.asset_id), adjusted.get(benchmark_id)
        entry_expected = entry is not None and entry <= material_end
        missing_entry = entry_expected and (
            bars is None or not _positive(bars.at[entry, "open"])
        )
        missing_post = not beyond and (
            bars is None
            or not all(_positive(bars.at[day, "close"]) for day in expected)
        )
        missing_benchmark = not beyond and (
            benchmark is None
            or not _positive(benchmark.at[entry, "open"])
            or not all(_positive(benchmark.at[day, "close"]) for day in expected)
        )
        asset_return = (
            np.nan
            if beyond or missing_entry or missing_post
            else bars.at[exit_day, "close"] / bars.at[entry, "open"] - 1
        )
        benchmark_return = (
            np.nan
            if beyond or missing_benchmark
            else benchmark.at[exit_day, "close"] / benchmark.at[entry, "open"] - 1
        )
        pair_valid = not (beyond or missing_entry or missing_post or missing_benchmark)
        labels.append(
            {
                "asset_id": row.asset_id,
                "signal_session": row.signal_session,
                "label_start": _at(entry, LABEL_OPEN_TIME.hour, LABEL_OPEN_TIME.minute)
                if entry_expected
                else pd.NaT,
                "label_end": _at(
                    exit_day, LABEL_CLOSE_TIME.hour, LABEL_CLOSE_TIME.minute
                )
                if not beyond
                else pd.NaT,
                "entry_session": entry,
                "exit_session": exit_day,
                "horizon_beyond_material": beyond,
                "entry_price_missing": bool(missing_entry),
                "post_entry_price_missing": bool(missing_post),
                "benchmark_missing": bool(missing_benchmark),
                "asset_return_proxy": asset_return,
                "benchmark_return_proxy": benchmark_return,
                "excess_return_proxy": asset_return - benchmark_return
                if pair_valid
                else np.nan,
                "pair_valid": pair_valid,
            }
        )
    frame = pd.DataFrame(labels)
    for column in ("label_start", "label_end"):
        frame[column] = pd.to_datetime(frame[column], utc=True)
    return frame


def _split_membership(
    features: pd.DataFrame,
    labels: pd.DataFrame,
    train_end: date,
    validation_end: date,
) -> pd.DataFrame:
    result = features[KEYS + ["decision_at"]].merge(
        labels[KEYS + ["label_end"]], on=KEYS, validate="one_to_one"
    )
    result["split"] = result["signal_session"].map(
        lambda day: (
            "train"
            if day <= train_end
            else "validation"
            if day <= validation_end
            else "test"
        )
    )
    result["purged"] = False
    result["purge_reason"] = ""
    for previous, following in (("train", "validation"), ("validation", "test")):
        next_decision = result.loc[result["split"] == following, "decision_at"].min()
        if pd.isna(next_decision):
            continue
        purge = (result["split"] == previous) & (
            result["label_end"].isna() | (result["label_end"] >= next_decision)
        )
        result.loc[purge, "purged"] = True
        result.loc[purge, "purge_reason"] = "label_end_not_before_next_split"
    return result


def prepare(
    material: Any,
    *,
    dataset_id: str,
    asset_ids: Sequence[str],
    start: str | date,
    end: str | date,
    benchmark_id: str,
    time_policy: str,
    train_end: str | date | None = None,
    validation_end: str | date | None = None,
    horizon: int = 5,
    output_dir: str | Path | None = None,
) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame | None, dict[str, Any]]:
    """Return features, labels, split membership (or None when train_end/validation_end are omitted), and provenance."""
    dataset_id, benchmark_id = str(UUID(dataset_id)), str(UUID(benchmark_id))
    asset_ids = [str(UUID(asset)) for asset in asset_ids]
    if not asset_ids or len(asset_ids) != len(set(asset_ids)):
        raise ValueError("Choose unique asset UUIDs")
    _policy(time_policy)
    if horizon not in {1, 5}:
        raise ValueError("Choose H=1 or H=5")
    start_d, end_d = _day(start), _day(end)
    if start_d > end_d:
        raise ValueError("Require start <= end")
    has_splits = train_end is not None or validation_end is not None
    train_d: date | None = None
    val_d: date | None = None
    if has_splits:
        if train_end is None or validation_end is None:
            raise ValueError("Provide both train_end and validation_end, or neither")
        train_d, val_d = _day(train_end), _day(validation_end)
        if not start_d <= train_d < val_d < end_d:
            raise ValueError("Require start <= train_end < validation_end < end")
    if not isinstance(material, Mapping):
        material = material_from_version(material, dataset_id, asset_ids, benchmark_id)
    manifest = material["manifest"]
    digest = material["manifest_sha256"]
    if (
        manifest["dataset_id"] != dataset_id
        or len(digest) != 64
        or any(c not in "0123456789abcdef" for c in digest)
    ):
        raise ValueError("Require the original frozen manifest and its SHA-256")
    calendar = list(map(_day, material["calendar"]))
    if not calendar or calendar != sorted(set(calendar)):
        raise ValueError("Frozen calendar must contain unique ordered session dates")
    universe = material["universe"]
    known = set(
        universe["asset_id"]
        if isinstance(universe, pd.DataFrame)
        else [row["asset_id"] for row in universe]
    )
    if not {*asset_ids, benchmark_id}.issubset(known):
        raise ValueError("A selected security is outside the frozen universe")
    signals = [day for day in calendar if start_d <= day <= end_d]
    if not signals:
        raise ValueError("No frozen signal sessions in [start, end]")
    if (
        has_splits
        and train_d is not None
        and val_d is not None
        and (
            not any(day <= train_d for day in signals)
            or not any(train_d < day <= val_d for day in signals)
            or not any(day > val_d for day in signals)
        )
    ):
        raise ValueError("Each split must contain at least one frozen signal session")
    raw, adjusted = (
        _prices(material["raw"], calendar),
        _prices(material["all"], calendar),
    )
    zones = manifest.get("source_timezones", {})
    features, events = _feature_rows(
        calendar,
        signals,
        asset_ids,
        raw,
        adjusted,
        material["event_observations"],
        material["source_checks"],
        time_policy,
        zones,
        material.get("news_versions"),
        _rank_population(universe, [benchmark_id]),
    )
    labels = _label_rows(
        features,
        calendar,
        adjusted,
        benchmark_id,
        horizon,
        _day(manifest["cutoff_date"]),
    )
    splits = (
        _split_membership(features, labels, train_d, val_d)
        if has_splits and train_d is not None and val_d is not None
        else None
    )
    masks = [
        "horizon_beyond_material",
        "entry_price_missing",
        "post_entry_price_missing",
        "benchmark_missing",
    ]
    parameters: dict[str, Any] = {
        "asset_ids": asset_ids,
        "benchmark_id": benchmark_id,
        "start": str(start_d),
        "end": str(end_d),
        **_time_parameters(time_policy),
        "horizon": horizon,
    }
    if has_splits and train_d is not None and val_d is not None:
        parameters["train_end"] = str(train_d)
        parameters["validation_end"] = str(val_d)
    counts: dict[str, int] = {
        "candidates": len(features),
        "pair_valid": int(labels["pair_valid"].sum()),
    }
    if splits is not None:
        counts["purged"] = int(splits["purged"].sum())
    run = {
        "dataset_id": dataset_id,
        "manifest_sha256": digest,
        "package_version": __version__,
        "code_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "environment": {
            "python": platform.python_version(),
            "numpy": np.__version__,
            "pandas": pd.__version__,
            "pyarrow": pyarrow.__version__,
        },
        "parameters": parameters,
        "counts": counts,
        "masks": {name: int(labels[name].sum()) for name in masks},
        **_feature_provenance(features, events),
        "limitations": LIMITATIONS + list(manifest.get("limitations", [])),
    }
    if output_dir is not None:
        destination = Path(output_dir)
        destination.mkdir(parents=True, exist_ok=True)
        frames: list[tuple[str, pd.DataFrame]] = [
            ("features", features),
            ("labels", labels),
        ]
        if splits is not None:
            frames.append(("split_membership", splits))
        for name, frame in frames:
            frame.to_parquet(
                destination / f"{name}.parquet", index=False, engine="pyarrow"
            )
        (destination / "run.json").write_text(json.dumps(run, indent=2) + "\n")
    return features, labels, splits, run


def prepare_fundamental_features(
    version_or_material: Any,
    samples: pd.DataFrame,
    *,
    metrics: Mapping[str, str],
    period_kind: str = "quarter",
    time_policy: str,
) -> pd.DataFrame:
    """Join explicit-unit SEC facts to frozen candidate UUIDs without dropping rows.

    A fact is available at or before the decision: public_reconstructed uses its public
    clock (SEC filing-date rule), observed_content also needs its capture by the
    decision plus CAPTURE_GRACE.
    """
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
    _policy(time_policy)
    if not set(KEYS + ["decision_at"]).issubset(samples.columns):
        raise ValueError("Samples require candidate keys and decision_at")
    if isinstance(version_or_material, Mapping):
        manifest = version_or_material["manifest"]
        universe = version_or_material["universe"]
        facts = version_or_material["fundamentals"]
    else:
        manifest, universe = version_or_material.manifest, version_or_material.universe
        records = (
            universe.to_dict("records")
            if isinstance(universe, pd.DataFrame)
            else universe
        )
        requested = set(samples["asset_id"])
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
        universe.to_dict("records") if isinstance(universe, pd.DataFrame) else universe
    )
    frozen = {row["asset_id"]: row for row in universe}
    if len(frozen) != len(universe):
        raise ValueError("Frozen universe contains duplicate security UUIDs")
    zones, chains = manifest.get("source_timezones", {}), {}
    for source_row in facts.to_dict("records"):
        row = {**source_row, "source": source_row.get("source", "sec")}
        sequence = row.get("observation_sequence")
        if (
            not isinstance(sequence, (int, np.integer))
            or isinstance(sequence, bool)
            or sequence < 0
        ):
            raise ValueError("Facts require a nonnegative observation_sequence")
        public, observed = _public_clock(row, zones), _clock(row.get("observed_at"))
        declared_invalid = (
            row.get("public_time_precision") in {"second", "date"} and public is None
        )
        available = public
        if time_policy == "observed_content":
            captured = None if observed is None else observed - CAPTURE_GRACE
            available = (
                max(captured, public)
                if captured is not None and public is not None
                else captured
            )
            if declared_invalid:
                available = None
        period_end_raw = row.get("period_end")
        period_end_day = _day(period_end_raw) if period_end_raw else None
        row.update(
            _public=public,
            _observed=observed,
            _available=available,
            _period_end_day=period_end_day,
        )
        chains.setdefault(
            (str(row.get("cik", "")).zfill(10), row.get("metric"), row["fact_id"]), []
        ).append(row)
    grouped: dict[tuple[str, Any], list[list[dict[str, Any]]]] = {}
    for (cik, metric, _), versions in chains.items():
        versions.sort(key=lambda row: row["observation_sequence"])
        if len({row["observation_sequence"] for row in versions}) != len(versions):
            raise ValueError("Duplicate observation_sequence for one fact")
        if time_policy == "public_reconstructed":
            first_by_clock: dict[pd.Timestamp, dict[str, Any]] = {}
            unknown_v: list[dict[str, Any]] = []
            for row in versions:
                if row["_public"] is not None:
                    first_by_clock.setdefault(row["_public"], row)
                elif not row.get("is_retracted", False):
                    unknown_v.append(row)
            versions = unknown_v + sorted(
                first_by_clock.values(), key=lambda row: row["_public"]
            )
        grouped.setdefault((cik, metric), []).append(versions)

    provenance = (
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

    # Memoize per (cik, metric, unit, decision, report_limit) so dual-class securities
    # (e.g. GOOG/GOOGL, BRK.A/BRK.B) and repeated evaluation keys share identical results.
    eval_cache: dict[
        tuple[str, str, str, pd.Timestamp | None, date | None], dict[str, Any]
    ] = {}

    def _eval_metric(
        cik_padded: str,
        verified: bool,
        metric: str,
        unit: str,
        decision: pd.Timestamp | None,
        report_limit: date | None,
    ) -> dict[str, Any]:
        cache_key = (
            cik_padded if verified else "",
            metric,
            unit,
            decision,
            report_limit,
        )
        cached = eval_cache.get(cache_key)
        if cached is not None:
            return cached
        feature: dict[str, Any] = {
            "value": np.nan,
            "status": "metric_missing",
            "raw_value": None,
            "available_at": pd.NaT,
            "public_clock_missing": False,
            "availability_basis": "",
        }
        feature.update({name: None for name in provenance})
        if not verified:
            feature["status"] = "mapping_missing"
        elif decision is None:
            feature["status"] = "clock_unknown"
        else:
            selected, unknown, retracted = [], [], False
            for versions in grouped.get((cik_padded, metric), []):
                eligible = [
                    row
                    for row in versions
                    if row["_available"] is not None and row["_available"] <= decision
                ]
                chosen = eligible[-1] if eligible else None
                if time_policy == "observed_content":
                    unknown.extend(
                        row
                        for row in versions
                        if row["_available"] is None
                        and (
                            row["_observed"] is None
                            or row["_observed"] - CAPTURE_GRACE <= decision
                        )
                        and (
                            chosen is None
                            or row["observation_sequence"]
                            > chosen["observation_sequence"]
                        )
                    )
                elif chosen is None:
                    unknown.extend(row for row in versions if row["_public"] is None)
                if chosen is not None:
                    retracted |= bool(chosen.get("is_retracted", False))
                    if not chosen.get("is_retracted", False):
                        selected.append(chosen)
            possible = selected + unknown
            matching_unit = [row for row in possible if row.get("unit") == unit]
            matching_period = [
                row for row in matching_unit if row.get("period_kind") == period_kind
            ]
            dated = [
                row
                for row in matching_period
                if row["_period_end_day"] is not None
                and report_limit is not None
                and row["_period_end_day"] <= report_limit
            ]
            if not possible:
                feature["status"] = (
                    "retracted"
                    if retracted
                    else "not_yet_available"
                    if (cik_padded, metric) in grouped
                    else "metric_missing"
                )
            elif not matching_unit:
                feature["status"] = "unit_unavailable"
            elif not matching_period or not dated:
                feature["status"] = "period_unavailable"
            else:
                latest_period = max(row["_period_end_day"] for row in dated)
                candidates = [
                    row for row in dated if row["_period_end_day"] == latest_period
                ]
                if any(row["_available"] is None for row in candidates):
                    feature["status"] = "clock_unknown"
                else:
                    report_at = max(
                        row["_public"]
                        if row["_public"] is not None
                        else row["_observed"]
                        for row in candidates
                    )
                    candidates = [
                        row
                        for row in candidates
                        if (
                            row["_public"]
                            if row["_public"] is not None
                            else row["_observed"]
                        )
                        == report_at
                    ]
                    try:
                        values = (
                            {Decimal(row["value"]) for row in candidates}
                            if all(
                                isinstance(row.get("value"), str) for row in candidates
                            )
                            else set()
                        )
                    except (InvalidOperation, TypeError, ValueError):
                        values = set()
                    if not values or any(not value.is_finite() for value in values):
                        feature["status"] = "invalid_value"
                    elif (
                        len(values) != 1
                        or len({row.get("period_start") for row in candidates}) != 1
                    ):
                        feature["status"] = "ambiguous"
                    else:
                        chosen = min(
                            candidates,
                            key=lambda row: (
                                row.get("tag_priority", 0),
                                row["fact_id"],
                            ),
                        )
                        feature.update({name: chosen.get(name) for name in provenance})
                        number = float(next(iter(values)))
                        feature.update(
                            raw_value=chosen["value"],
                            available_at=chosen["_available"],
                            public_clock_missing=chosen["_public"] is None,
                            availability_basis="observed_only"
                            if chosen["_public"] is None
                            else time_policy,
                        )
                        feature["status"] = (
                            "ok_observed_only" if chosen["_public"] is None else "ok"
                        )
                        if np.isfinite(number):
                            feature["value"] = number
                        else:
                            feature["status"] = "nonfinite_model_value"
        prefixed = {f"{metric}_{name}": value for name, value in feature.items()}
        eval_cache[cache_key] = prefixed
        return prefixed

    results = []
    for sample in samples.to_dict("records"):
        identity = frozen.get(sample["asset_id"], {})
        cik = str(identity.get("cik", ""))
        verified = (
            identity.get("issuer_mapping_status") == "verified"
            and cik.isdigit()
            and len(cik) <= 10
            and int(cik) > 0
        )
        cik_padded = cik.zfill(10) if verified else ""
        decision, signal = _clock(sample["decision_at"]), _day(sample["signal_session"])
        report_limit = sample.get("report_period_end", signal)
        report_limit = (
            None
            if report_limit is None or pd.isna(report_limit) or report_limit == ""
            else min(signal, _day(report_limit))
        )
        features: dict[str, Any] = {}
        for metric, unit in metrics.items():
            features.update(
                _eval_metric(cik_padded, verified, metric, unit, decision, report_limit)
            )
        results.append(features)
    columns = [
        f"{metric}_{name}"
        for metric in metrics
        for name in (
            "value",
            "status",
            "raw_value",
            "available_at",
            "public_clock_missing",
            "availability_basis",
            *provenance,
        )
    ]
    result = pd.concat(
        [
            samples[KEYS].copy(),
            pd.DataFrame(results, index=samples.index, columns=columns),
        ],
        axis=1,
    )
    for metric in metrics:
        result[f"{metric}_available_at"] = pd.to_datetime(
            result[f"{metric}_available_at"], utc=True
        )
    result.attrs["parameters"] = {
        "metrics": dict(metrics),
        "period_kind": period_kind,
        "time_policy": time_policy,
    }
    result.attrs["limitations"] = list(manifest.get("limitations", [])) + [
        "Frozen verified issuer mappings are static; share classes retain separate candidate UUIDs.",
        "Public reconstruction keeps first saved states per fact/public clock; unknown public withdrawals are ignored.",
        "SEC as-filed facts are not a restatement-complete PIT ledger; no FX, EPS or YTD-to-quarter derivation is performed.",
    ]
    return result


def prepare_fundamental_ratios(
    version_or_material: Any,
    samples: pd.DataFrame,
    *,
    currency: str = "USD",
    period_kind: str = "quarter",
    time_policy: str,
) -> pd.DataFrame:
    """Six derived financial features with explicit source and comparison bases."""
    metrics = (
        "revenue",
        "gross_profit",
        "operating_income",
        "net_income",
        "operating_cash_flow",
        "capex",
    )
    current = prepare_fundamental_features(
        version_or_material,
        samples,
        metrics={name: currency for name in metrics},
        period_kind=period_kind,
        time_policy=time_policy,
    )

    def previous_year(value: Any) -> date | None:
        if value is None or pd.isna(value) or value == "":
            return None
        day = _day(value)
        try:
            return day.replace(year=day.year - 1)
        except ValueError:
            return day.replace(year=day.year - 1, day=28)

    prior_samples = samples.copy()
    prior_samples["report_period_end"] = [
        previous_year(value) for value in current["revenue_period_end"]
    ]
    prior = prepare_fundamental_features(
        version_or_material,
        prior_samples,
        metrics={"revenue": currency},
        period_kind=period_kind,
        time_policy=time_policy,
    )
    result = samples[KEYS].copy()
    references = (
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
    for prefix, panel_df, names in (
        ("source", current, metrics),
        ("prior", prior, ("revenue",)),
    ):
        for metric in names:
            for field in references:
                result[f"{prefix}_{metric}_{field}"] = panel_df[
                    f"{metric}_{field}"
                ].array

    def input_status(row: Mapping[str, Any], names: Sequence[str]) -> str:
        if any(
            row[f"{name}_status"] not in {"ok", "ok_observed_only"}
            or not np.isfinite(row[f"{name}_value"])
            for name in names
        ):
            return "input_unavailable"
        fields = ("cik", "period_start", "period_end", "unit", "currency", "accession")
        if any(not row[f"{name}_{field}"] for name in names for field in fields):
            return "basis_missing"
        if any(
            row[f"{name}_unit"] != currency or row[f"{name}_currency"] != currency
            for name in names
        ):
            return "unit_mismatch"
        for field, status in (
            ("cik", "issuer_mismatch"),
            ("period_start", "period_mismatch"),
            ("period_end", "period_mismatch"),
            ("accession", "accession_mismatch"),
        ):
            if len({row[f"{name}_{field}"] for name in names}) != 1:
                return status
        return (
            "ok_observed_only"
            if any(row[f"{name}_status"] == "ok_observed_only" for name in names)
            else "ok"
        )

    derived = []
    for row, previous in zip(current.to_dict("records"), prior.to_dict("records")):
        values: dict[str, Any] = {}
        definitions = (
            ("gross_margin", ("gross_profit", "revenue")),
            ("operating_margin", ("operating_income", "revenue")),
            ("net_margin", ("net_income", "revenue")),
            ("free_cash_flow", ("operating_cash_flow", "capex")),
            ("free_cash_flow_margin", ("operating_cash_flow", "capex", "revenue")),
        )
        for name, inputs in definitions:
            status, value = input_status(row, inputs), np.nan
            if status in {"ok", "ok_observed_only"}:
                numerator = row[f"{inputs[0]}_value"]
                if name.startswith("free_cash_flow"):
                    numerator -= row["capex_value"]
                if name == "free_cash_flow":
                    value = numerator
                elif row["revenue_value"] == 0:
                    status = "zero_revenue"
                else:
                    value = numerator / row["revenue_value"]
            if not np.isfinite(value) and status in {"ok", "ok_observed_only"}:
                status, value = "nonfinite_result", np.nan
            values.update({f"{name}_value": value, f"{name}_status": status})
        status, growth = input_status(row, ("revenue",)), np.nan
        if status in {"ok", "ok_observed_only"}:
            if previous["revenue_status"] not in {"ok", "ok_observed_only"}:
                status = "prior_unavailable"
            elif any(
                previous[f"revenue_{field}"] != row[f"revenue_{field}"]
                for field in ("cik", "unit", "currency")
            ):
                status = "prior_basis_mismatch"
            elif any(
                not previous[f"revenue_period_{field}"]
                or _day(previous[f"revenue_period_{field}"])
                != previous_year(row[f"revenue_period_{field}"])
                for field in ("start", "end")
            ):
                status = "unverified_prior_period"
            elif previous["revenue_value"] == 0:
                status = "zero_prior_revenue"
            else:
                growth = row["revenue_value"] / previous["revenue_value"] - 1
                status = (
                    "ok_observed_only"
                    if "ok_observed_only" in {status, previous["revenue_status"]}
                    else "ok"
                )
                if not np.isfinite(growth):
                    status, growth = "nonfinite_result", np.nan
        values.update(revenue_yoy_value=growth, revenue_yoy_status=status)
        derived.append(values)
    columns = [
        f"{metric}_{field}" for metric in RATIO_METRICS for field in ("value", "status")
    ]
    result = pd.concat(
        [result, pd.DataFrame(derived, index=samples.index, columns=columns)], axis=1
    )
    result.attrs["parameters"] = {
        "currency": currency,
        "period_kind": period_kind,
        "time_policy": time_policy,
    }
    result.attrs["limitations"] = current.attrs["limitations"] + [
        "YoY requires exact one-calendar-year-shifted actual periods, with February 29 clamped; unverified 52/53-week comparisons stay missing.",
    ]
    return result


# ---------------------------------------------------------------------------
# High-level split-free pandas DataFrame builders (Layer 2)
# ---------------------------------------------------------------------------


def build_candidates(
    version: Any,
    symbols: str | Sequence[str] | None = None,
    *,
    start: str | date | None = None,
    end: str | date | None = None,
) -> pd.DataFrame:
    """Return a candidate ``(asset_id, symbol, signal_session, previous_decision_at, decision_at)`` DataFrame."""
    asset_ids = version.resolve(symbols)
    calendar = list(map(_day, version.calendar))
    start_d = _day(start) if start is not None else calendar[0]
    end_d = _day(end) if end is not None else calendar[-1]
    if start_d > end_d:
        raise ValueError("Require start <= end")
    signals = [day for day in calendar if start_d <= day <= end_d]
    if not signals:
        raise ValueError("No frozen signal sessions in [start, end]")
    cal_index = {day: idx for idx, day in enumerate(calendar)}
    univ = version.universe
    symbol_map = (
        dict(zip(univ["asset_id"], univ["symbol"]))
        if isinstance(univ, pd.DataFrame) and "symbol" in univ.columns
        else {}
    )
    rows = []
    for asset_id in asset_ids:
        sym = symbol_map.get(asset_id, "")
        for signal in signals:
            idx = cal_index[signal]
            decision = (
                _decision_at(calendar[idx + 1]) if idx + 1 < len(calendar) else pd.NaT
            )
            previous = _decision_at(signal)
            rows.append(
                {
                    "asset_id": asset_id,
                    "symbol": sym,
                    "signal_session": signal,
                    "previous_decision_at": previous,
                    "decision_at": decision,
                }
            )
    frame = pd.DataFrame(rows)
    frame.attrs["parameters"] = {
        "asset_ids": asset_ids,
        "start": str(start_d),
        "end": str(end_d),
    }
    return frame


def daily_features(
    version: Any,
    symbols: str | Sequence[str] | None = None,
    *,
    time_policy: str,
    start: str | date | None = None,
    end: str | date | None = None,
    benchmark: str | None = None,
) -> pd.DataFrame:
    """Return daily price/volume/event-count PIT features as a ``pd.DataFrame`` (no split boundaries needed).

    ``{source}_events_rank_21d`` ranks the universe's non-benchmark securities (flagged
    ones and ``benchmark``); it stays missing unless the selection holds all of them.
    """
    _policy(time_policy)
    asset_ids = version.resolve(symbols)
    benchmark_ids = version.resolve(benchmark) if benchmark is not None else []
    calendar = list(map(_day, version.calendar))
    start_d = _day(start) if start is not None else calendar[0]
    end_d = _day(end) if end is not None else calendar[-1]
    if start_d > end_d:
        raise ValueError("Require start <= end")
    signals = [day for day in calendar if start_d <= day <= end_d]
    if not signals:
        raise ValueError("No frozen signal sessions in [start, end]")
    raw = _prices(version.prices(asset_ids, adjusted=False), calendar)
    adjusted = _prices(version.prices(asset_ids, adjusted=True), calendar)
    observations = version.event_observations()
    checks = version.source_checks(asset_ids)
    zones = version.manifest.get("source_timezones", {})
    features, events = _feature_rows(
        calendar,
        signals,
        asset_ids,
        raw,
        adjusted,
        observations,
        checks,
        time_policy,
        zones,
        _news_versions(version),
        _rank_population(version.universe, benchmark_ids),
    )
    features.attrs["provenance"] = {
        "dataset_id": str(version.id),
        "manifest_sha256": version.manifest_sha256,
        "package_version": __version__,
        "parameters": {
            "asset_ids": asset_ids,
            "start": str(start_d),
            "end": str(end_d),
            "benchmark_ids": benchmark_ids,
            **_time_parameters(time_policy),
        },
        "counts": {"candidates": len(features)},
        **_feature_provenance(features, events),
    }
    return features


def _ensure_samples(
    version: Any,
    candidates_or_symbols: pd.DataFrame | str | Sequence[str] | None,
    *,
    start: str | date | None = None,
    end: str | date | None = None,
) -> pd.DataFrame:
    if isinstance(candidates_or_symbols, pd.DataFrame):
        if not set(KEYS).issubset(candidates_or_symbols.columns):
            raise ValueError("Samples require asset_id and signal_session")
        return candidates_or_symbols.reset_index(drop=True)
    return build_candidates(version, candidates_or_symbols, start=start, end=end)


def _default_metrics_for_period(period_kind: str) -> dict[str, str]:
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


def fundamental_features(
    version: Any,
    candidates_or_symbols: pd.DataFrame | str | Sequence[str] | None = None,
    *,
    time_policy: str,
    start: str | date | None = None,
    end: str | date | None = None,
    metrics: Mapping[str, str] | Sequence[str] | None = None,
    period_kind: str | Sequence[str] = "quarter",
) -> pd.DataFrame:
    """Return PIT-aligned fundamental features as a ``pd.DataFrame``.

    - ``metrics`` may be ``None`` (standard duration or instant metrics for ``period_kind``;
      quarterly defaults omit the year-to-date cash-flow metrics),
      a sequence of metric names (auto-mapped via ``ALL_METRICS``), or an explicit ``{metric: unit}`` mapping.
    - ``period_kind`` may be ``"quarter"``, ``"annual"``, ``"instant"``, ``"all"``, or a sequence of period kinds.
      When multiple period kinds are requested, columns are prefixed with ``{period_kind}_``.
    """
    samples = _ensure_samples(version, candidates_or_symbols, start=start, end=end)
    if period_kind == "all":
        periods: list[str] = ["quarter", "annual", "instant"]
    elif isinstance(period_kind, str):
        periods = [period_kind]
    else:
        periods = list(period_kind)

    def resolve_metrics(pk: str) -> dict[str, str]:
        if metrics is None:
            return _default_metrics_for_period(pk)
        if isinstance(metrics, Mapping):
            return dict(metrics)
        return {name: ALL_METRICS.get(name, "USD") for name in metrics}

    if len(periods) == 1:
        pk = periods[0]
        return prepare_fundamental_features(
            version,
            samples,
            metrics=resolve_metrics(pk),
            period_kind=pk,
            time_policy=time_policy,
        )

    merged = samples[KEYS].copy()
    for pk in periods:
        part = prepare_fundamental_features(
            version,
            samples,
            metrics=resolve_metrics(pk),
            period_kind=pk,
            time_policy=time_policy,
        )
        value_cols = [col for col in part.columns if col not in KEYS]
        renamed = {col: f"{pk}_{col}" for col in value_cols}
        merged = pd.concat([merged, part[value_cols].rename(columns=renamed)], axis=1)
    merged.attrs["parameters"] = {
        "period_kinds": periods,
        "time_policy": time_policy,
    }
    return merged


def fundamental_ratios(
    version: Any,
    candidates_or_symbols: pd.DataFrame | str | Sequence[str] | None = None,
    *,
    time_policy: str,
    start: str | date | None = None,
    end: str | date | None = None,
    currency: str = "USD",
    period_kind: str | Sequence[str] = "quarter",
) -> pd.DataFrame:
    """Return PIT-aligned fundamental ratios as a ``pd.DataFrame``.

    ``period_kind`` may be ``"quarter"``, ``"annual"``, or ``("quarter", "annual")``.
    """
    samples = _ensure_samples(version, candidates_or_symbols, start=start, end=end)
    periods = [period_kind] if isinstance(period_kind, str) else list(period_kind)
    if len(periods) == 1:
        return prepare_fundamental_ratios(
            version,
            samples,
            currency=currency,
            period_kind=periods[0],
            time_policy=time_policy,
        )
    merged = samples[KEYS].copy()
    for pk in periods:
        part = prepare_fundamental_ratios(
            version,
            samples,
            currency=currency,
            period_kind=pk,
            time_policy=time_policy,
        )
        value_cols = [col for col in part.columns if col not in KEYS]
        renamed = {col: f"{pk}_{col}" for col in value_cols}
        merged = pd.concat([merged, part[value_cols].rename(columns=renamed)], axis=1)
    merged.attrs["parameters"] = {
        "currency": currency,
        "period_kinds": periods,
        "time_policy": time_policy,
    }
    return merged


def forward_returns(
    version: Any,
    candidates_or_symbols: pd.DataFrame | str | Sequence[str] | None = None,
    *,
    start: str | date | None = None,
    end: str | date | None = None,
    benchmark: str = "SPY",
    horizons: int | Iterable[int] = (1, 5),
) -> pd.DataFrame:
    """Return forward return labels as a ``pd.DataFrame`` without requiring split boundaries.

    If ``horizons`` is a single ``int`` (e.g. ``5``), returns the standard label columns.
    If ``horizons`` is an iterable of horizons (e.g. ``(1, 5)``), prefixes each horizon's
    label columns with ``h{H}_`` (and includes convenient ``excess_return_{H}d`` aliases).
    """
    samples = _ensure_samples(version, candidates_or_symbols, start=start, end=end)
    single_horizon = isinstance(horizons, int)
    horizon_list = [horizons] if single_horizon else list(horizons)
    if not horizon_list or any(h < 1 for h in horizon_list):
        raise ValueError("horizons must be positive integers")

    asset_ids = list(dict.fromkeys(samples["asset_id"].astype(str)))
    benchmark_id = version.resolve(benchmark)[0]
    calendar = list(map(_day, version.calendar))
    all_ids = list(dict.fromkeys([*asset_ids, benchmark_id]))
    adjusted = _prices(version.prices(all_ids, adjusted=True), calendar)
    cutoff_day = _day(version.manifest["cutoff_date"])

    if single_horizon:
        labels = _label_rows(
            samples, calendar, adjusted, benchmark_id, horizon_list[0], cutoff_day
        )
        labels.attrs["parameters"] = {
            "benchmark_id": benchmark_id,
            "horizon": horizon_list[0],
        }
        return labels

    merged = samples[KEYS].copy()
    for h in horizon_list:
        part = _label_rows(samples, calendar, adjusted, benchmark_id, h, cutoff_day)
        value_cols = [col for col in part.columns if col not in KEYS]
        renamed = {col: f"h{h}_{col}" for col in value_cols}
        merged = pd.concat([merged, part[value_cols].rename(columns=renamed)], axis=1)
        merged[f"forward_excess_return_{h}d"] = part["excess_return_proxy"].array
        merged[f"trainable_{h}d"] = part["pair_valid"].array
    merged.attrs["parameters"] = {
        "benchmark_id": benchmark_id,
        "horizons": horizon_list,
    }
    return merged


def panel(
    version: Any,
    symbols: str | Sequence[str] | None = None,
    *,
    time_policy: str,
    start: str | date | None = None,
    end: str | date | None = None,
    benchmark: str = "SPY",
    horizons: int | Iterable[int] = (1, 5),
    fundamental_time_policy: str | None = None,
    include_fundamentals: bool = True,
    include_ratios: bool = True,
    output_dir: str | Path | None = None,
) -> pd.DataFrame:
    """Build a unified PIT research ``pd.DataFrame`` combining daily features, fundamentals, ratios, and forward returns.

    Default quarterly columns omit operating cash flow, capex and free cash flow (10-Q
    cash flows are year-to-date); request them explicitly through ``fundamental_features``.
    """
    _policy(time_policy)
    fund_policy = _policy(fundamental_time_policy or time_policy)
    daily = daily_features(
        version,
        symbols,
        start=start,
        end=end,
        time_policy=time_policy,
        benchmark=benchmark,
    )
    univ = version.universe
    if isinstance(univ, pd.DataFrame) and "symbol" in univ.columns:
        symbol_map = dict(zip(univ["asset_id"], univ["symbol"]))
        daily.insert(1, "symbol", daily["asset_id"].map(symbol_map))

    parts: list[pd.DataFrame] = [daily]
    candidates = daily[KEYS + ["decision_at"]].copy()

    if include_fundamentals:
        fund = fundamental_features(
            version,
            candidates,
            period_kind=("quarter", "annual", "instant"),
            time_policy=fund_policy,
        )
        parts.append(fund.drop(columns=KEYS))

    if include_ratios:
        ratios = fundamental_ratios(
            version,
            candidates,
            period_kind=("quarter", "annual"),
            time_policy=fund_policy,
        )
        stale = tuple(
            [f"quarter_{name}_" for name in QUARTER_DEFAULT_EXCLUDED_RATIOS]
            + [f"quarter_source_{name}_" for name in QUARTER_DEFAULT_EXCLUDED_METRICS]
        )
        parts.append(
            ratios.drop(
                columns=KEYS
                + [column for column in ratios.columns if column.startswith(stale)]
            )
        )

    labels = forward_returns(
        version,
        candidates,
        benchmark=benchmark,
        horizons=horizons,
    )
    parts.append(labels.drop(columns=KEYS))

    combined = pd.concat(parts, axis=1)
    daily_provenance = daily.attrs.get("provenance", {})
    provenance = {
        "dataset_id": str(version.id),
        "manifest_sha256": version.manifest_sha256,
        "package_version": __version__,
        "parameters": {
            "symbols": symbols,
            "start": str(start)
            if start is not None
            else str(daily["signal_session"].min()),
            "end": str(end) if end is not None else str(daily["signal_session"].max()),
            "benchmark": benchmark,
            "horizons": [horizons] if isinstance(horizons, int) else list(horizons),
            **_time_parameters(time_policy),
            "fundamental_time_policy": fund_policy,
            "include_fundamentals": include_fundamentals,
            "include_ratios": include_ratios,
        },
        "rows": len(combined),
        "columns": len(combined.columns),
        **{
            name: daily_provenance.get(name, {})
            for name in (
                "source_coverage",
                "skipped_sources",
                "undatable_events",
                "rank_population",
            )
        },
        "limitations": LIMITATIONS + list(version.manifest.get("limitations", [])),
    }
    combined.attrs["provenance"] = provenance
    if output_dir is not None:
        destination = Path(output_dir)
        destination.mkdir(parents=True, exist_ok=True)
        combined.to_parquet(
            destination / "panel.parquet", index=False, engine="pyarrow"
        )
        (destination / "provenance.json").write_text(
            json.dumps(provenance, indent=2) + "\n"
        )
    return combined

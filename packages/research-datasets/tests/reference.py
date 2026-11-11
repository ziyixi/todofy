"""Plain-loop reference of the 2.0 event and coverage semantics (test oracle).

Deliberately simple: one security, source and decision at a time. The vectorized
``research_datasets.events`` must reproduce it exactly on randomized material.
"""

from __future__ import annotations

from bisect import bisect_right
from collections.abc import Iterable, Mapping, Sequence
from datetime import date, datetime, time, timedelta
from decimal import Decimal, InvalidOperation
from typing import Any

import numpy as np
import pandas as pd

from research_datasets import clocks
from research_datasets.concepts import LEGACY_TAG_ORDER, PERIODIC_ANNUAL_FORMS
from research_datasets.constants import (
    CAPTURE_GRACE,
    KEYS,
    NOT_LISTED_CODES,
    RATIO_METRICS,
    SOURCE_CONTRACTS,
    STORY_WINDOW,
    VETO_CODES,
)
from research_datasets.events import EventSpec, default_specs
from research_datasets.fundamentals import LEGACY_STALE_AFTER_DAYS


def story_keys(news_versions: pd.DataFrame | None) -> dict[tuple[str, str], str]:
    """(source, event_id) -> story key of the article's earliest saved text version."""
    if news_versions is None or news_versions.empty:
        return {}
    frame = news_versions.sort_values(
        ["provider_updated_at", "story_key"], kind="stable", na_position="last"
    )
    keys: dict[tuple[str, str], str] = {}
    for row in frame.to_dict("records"):
        story, event_id, source = row["story_key"], row["event_id"], row.get("source")
        if isinstance(story, str) and story and event_id is not None:
            name = source if isinstance(source, str) and source else "alpaca_news"
            keys.setdefault((name, str(event_id)), story)
    return keys


def _story(row: Mapping[str, Any], stories: Mapping[tuple[str, str], str]) -> Any:
    value = row.get("story_key")
    if isinstance(value, str) and value:
        return value
    event_id = row.get("event_id")
    if isinstance(event_id, str) and event_id:
        return stories.get((row["source"], event_id))
    return None


def first_of_story(entries: list[tuple[Any, Any, Any]]) -> list[tuple[Any, Any]]:
    """Keep one entry per story key and STORY_WINDOW, anchored at the first entry."""
    entries = sorted(entries, key=lambda entry: (entry[0], str(entry[2])))
    anchors: dict[str, Any] = {}
    kept = []
    for instant, story, uid in entries:
        if story:
            anchor = anchors.get(story)
            if anchor is not None and instant < anchor + STORY_WINDOW:
                continue
            anchors[story] = instant
        kept.append((instant, uid))
    return kept


def _counts(versions: list[dict[str, Any]], spec: EventSpec) -> None:
    """Each version passes the spec by its own values, or by its chain's latest earlier
    value of a filtered column it lacks; a column absent from the rows is not filtered."""
    current: dict[str, str] = {}
    for version in versions:
        row = version["row"]
        for column in spec.columns():
            value = row.get(column)
            if isinstance(value, str) and value:
                current[column] = value
        counts = True
        for column, allowed in spec.where.items():
            value = current.get(column)
            if column == "form" and value is not None:
                value = value.removesuffix("/A")
            counts &= column not in row or value in allowed
        if spec.items_any and "items" in row:
            items = current.get("items", "")
            counts &= any(item.strip() in spec.items_any for item in items.split(","))
        version["counts"] = counts


class EventIndex:
    """Count-source event chains reduced for one policy."""

    def __init__(
        self,
        observations: pd.DataFrame,
        assets: set[str],
        selected: set[str],
        policy: str,
        zones: Mapping[str, str],
        stories: Mapping[tuple[str, str], str],
        specs: Sequence[EventSpec],
    ) -> None:
        self.policy = policy
        self.selected = selected
        self.placed: dict[tuple[str, str], list[Any]] = {}
        self.missing: dict[tuple[str, str], list[tuple[Any, Any]]] = {}
        self.histories: dict[tuple[str, str], list[Any]] = {}
        self.first_known: dict[tuple[str, str, Any], Any] = {}
        self.skipped: dict[str, int] = {}
        self.undatable: dict[str, int] = {}
        chains: dict[tuple[str, Any], list[dict[str, Any]]] = {}
        for row in observations.to_dict("records"):
            source = row.get("source")
            contract = SOURCE_CONTRACTS.get(source) if isinstance(source, str) else None
            if contract is None:
                name = source if isinstance(source, str) and source else "(missing)"
                self.skipped[name] = self.skipped.get(name, 0) + 1
                continue
            if not contract.counts:
                continue
            links = row.get("asset_ids")
            chains.setdefault((source, row["event_uid"]), []).append(
                {
                    "row": row,
                    "sequence": int(row["observation_sequence"]),
                    "public": clocks.public_clock(row, zones),
                    "links": [] if links is None else [str(asset) for asset in links],
                }
            )
        placed: dict[tuple[str, str], list[Any]] = {}
        for spec in specs:
            for (source, uid), versions in chains.items():
                if source != spec.source:
                    continue
                versions.sort(key=lambda version: version["sequence"])
                _counts(versions, spec)
                if not (
                    versions[-1]["counts"]
                    if policy == "public_reconstructed"
                    else any(version["counts"] for version in versions)
                ):
                    continue
                story = _story(versions[-1]["row"], stories)
                if policy == "public_reconstructed":
                    zone = clocks.source_zone(source, zones)
                    self._reconstruct(
                        placed, spec.name, uid, versions, assets, story, zone
                    )
                else:
                    self._observe(spec.name, uid, versions, assets, story)
        for key, entries in placed.items():
            self.placed[key] = [instant for instant, _ in first_of_story(entries)]

    def _reconstruct(self, placed, source, uid, versions, assets, story, zone) -> None:
        """``source`` is the spec name the counts are kept under."""
        links = [
            asset for asset in dict.fromkeys(versions[-1]["links"]) if asset in assets
        ]
        if not links:
            return
        publics = [
            version["public"] for version in versions if version["public"] is not None
        ]
        if publics:
            for asset in links:
                placed.setdefault((asset, source), []).append(
                    (min(publics), story, uid)
                )
            return
        day = clocks.date_field(versions[-1]["row"], "event_date", "filing_date")
        if day is None:
            if self.selected.intersection(links):
                self.undatable[source] = self.undatable.get(source, 0) + 1
            return
        start = pd.Timestamp(datetime.combine(day, time(), zone)).tz_convert("UTC")
        end = pd.Timestamp(
            datetime.combine(day + timedelta(days=1), time(), zone)
        ).tz_convert("UTC")
        for asset in links:
            self.missing.setdefault((asset, source), []).append((start, end))

    def _observe(self, source, uid, versions, assets, story) -> None:
        history = []
        for version in versions:
            row, public = version["row"], version["public"]
            content = clocks.clock(row.get("content_first_seen_at"))
            recorded = clocks.clock(row.get("observation_recorded_at"))
            invalid = (
                row.get("public_time_precision") in {"second", "date"}
                and public is None
            )
            available = None
            if content is not None and recorded is not None and not invalid:
                available = max(
                    clock
                    for clock in (
                        public,
                        content - CAPTURE_GRACE,
                        recorded - CAPTURE_GRACE,
                    )
                    if clock is not None
                )
            associations = clocks.mapping(row.get("asset_first_seen_at"))
            linked = {}
            for asset in set(version["links"]).intersection(assets):
                association = clocks.clock(associations.get(asset))
                linked[asset] = (
                    max(available, association - CAPTURE_GRACE)
                    if available is not None and association is not None
                    else None
                )
            history.append(
                {
                    "sequence": version["sequence"],
                    "available": available,
                    "recorded": recorded,
                    "assets": linked,
                    "public_missing": public is None,
                    "counts": version.get("counts", True),
                }
            )
        for version in history:
            for asset, available in version["assets"].items():
                key = (asset, source, uid)
                if available is not None and (
                    key not in self.first_known or available < self.first_known[key]
                ):
                    self.first_known[key] = available
        for asset in set().union(*(version["assets"] for version in history)):
            self.histories.setdefault((asset, source), []).append((uid, history, story))

    def window(self, asset: str, source: str, previous: Any, decision: Any) -> tuple:
        """(count, clock missing, public clock missing) of the window (previous, decision]."""
        if pd.isna(decision):
            return 0, False, False
        key = (asset, source)
        if self.policy == "public_reconstructed":
            instants = self.placed.get(key, [])
            count = bisect_right(instants, decision) - bisect_right(instants, previous)
            missing = any(
                start <= decision and previous < end
                for start, end in self.missing.get(key, [])
            )
            return count, missing, False
        clock_missing = public_missing = False
        linked = []
        for uid, versions, story in self.histories.get(key, []):
            selected = next(
                (
                    version
                    for version in reversed(versions)
                    if version["available"] is not None
                    and version["available"] <= decision
                ),
                None,
            )
            sequence = selected["sequence"] if selected is not None else -1
            clock_missing |= any(
                version["available"] is None
                and version["sequence"] > sequence
                and (
                    version["recorded"] is None
                    or version["recorded"] - CAPTURE_GRACE <= decision
                )
                for version in versions
            )
            if (
                selected is None
                or not selected["counts"]
                or asset not in selected["assets"]
            ):
                continue
            available = selected["assets"][asset]
            if available is None:
                clock_missing = True
                continue
            if available > decision:
                continue
            public_missing |= selected["public_missing"]
            linked.append((self.first_known[(asset, source, uid)], story, uid))
        count = sum(
            previous < initial <= decision for initial, _ in first_of_story(linked)
        )
        return count, clock_missing, public_missing


def classify(status: str, code: str, source: str) -> tuple[str, str]:
    contract = SOURCE_CONTRACTS[source]
    if code in VETO_CODES:
        return "veto", "mapping_missing"
    if code in NOT_LISTED_CODES:
        return "na", "not_listed"
    plain = status in {"checked", "empty", "not_changed"}
    if plain and not code:
        return "countable", "empty" if status == "empty" else "checked"
    if status == "partial" or plain:
        if code in contract.read_complete_codes:
            return "countable", "read_complete"
        if code in contract.countable_partial:
            return "countable", "checked"
        return "soft", "partial"
    return ("error" if status == "error" else "soft"), status or "unknown"


def parse_checks(rows: Iterable[Mapping[str, Any]]) -> list[tuple]:
    parsed = []
    for row in rows:
        checked = clocks.clock(row.get("checked_at"))
        if checked is None:
            continue
        status = row.get("status") if isinstance(row.get("status"), str) else "unknown"
        code = row.get("error_code") if isinstance(row.get("error_code"), str) else ""
        if not row.get("checked_start") or not row.get("checked_end"):
            parsed.append((checked, None, None, status, code))
        else:
            start, end = (
                clocks.day(row["checked_start"]),
                clocks.day(row["checked_end"]),
            )
            if start <= end:  # an inverted window is malformed and ignored
                parsed.append((checked, start, end, status, code))
    parsed.sort(key=lambda item: item[0])
    return parsed


def coverage(checks, source, previous, decision, zone, policy) -> tuple[str, str]:
    """Window label and basis ('' unless every day of (previous, decision] is countable)."""
    if pd.isna(decision):
        return "unknown", ""
    first, last = previous.tz_convert(zone).date(), decision.tz_convert(zone).date()
    days = [first + timedelta(days=offset) for offset in range((last - first).days + 1)]
    deadline = decision + CAPTURE_GRACE
    states: dict[date, tuple] = {}
    if policy == "observed_content":
        visible = [check for check in checks if check[0] <= deadline]
        windowed = [
            check
            for check in visible
            if check[1] is not None and check[1] <= last and check[2] >= first
        ]
        unbounded = [check for check in visible if check[1] is None]
        newest = max(unbounded, key=lambda check: check[0]) if unbounded else None
        if not windowed:
            if newest is None:
                return "unknown", ""
            kind, label = classify(newest[3], newest[4], source)
            return label, "observed" if kind == "countable" else ""
        if (
            newest is not None
            and newest[0] >= max(check[0] for check in windowed)
            and newest[3] not in {"checked", "empty"}
        ):
            return newest[3], ""
        for day in days:
            covering = [check for check in windowed if check[1] <= day <= check[2]]
            if covering:
                checked, _, _, status, code = max(covering, key=lambda check: check[0])
                states[day] = (*classify(status, code, source), checked)
    else:
        for checked, start, end, status, code in checks:
            if start is None:
                continue
            kind, label = classify(status, code, source)
            for day in days:
                if not start <= day <= end:
                    continue
                current = states.get(day)
                if kind in {"countable", "veto", "na"}:
                    first_ok = None
                    if kind == "countable":
                        countable = current is not None and current[0] == "countable"
                        first_ok = current[2] if countable else checked
                    states[day] = (kind, label, first_ok)
                elif current is None or current[0] != "countable":
                    states[day] = (kind, label, None)
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
    observed = all(states[day][2] <= deadline for day in days)
    return label, "observed" if observed else "reconstructed"


def features(
    material: Mapping[str, Any],
    *,
    asset_ids: Sequence[str],
    population: Sequence[str],
    start: str,
    end: str,
    policy: str,
    specs: Sequence[EventSpec] | None = None,
) -> tuple[pd.DataFrame, dict[str, Any]]:
    """Event columns of (asset, signal) rows plus skipped and undatable counts."""
    specs = list(default_specs() if specs is None else specs)
    sources = list(dict.fromkeys(spec.source for spec in specs))
    calendar = [clocks.day(value) for value in material["calendar"]]
    zones = material["manifest"].get("source_timezones", {})
    computed = list(dict.fromkeys([*asset_ids, *population]))
    index = EventIndex(
        material["event_observations"],
        set(computed),
        set(asset_ids),
        policy,
        zones,
        story_keys(material.get("news_versions")),
        specs,
    )
    grouped: dict[tuple[str, str], list] = {}
    for row in material["source_checks"].to_dict("records"):
        grouped.setdefault((str(row["asset_id"]), row["source"]), []).append(row)
    first = calendar.index(clocks.day(start))
    last = calendar.index(clocks.day(end))
    rows = []
    for asset in computed:
        for position in range(max(0, first - 62), last + 1):
            previous = clocks.decision_at(calendar[position])
            decision = (
                clocks.decision_at(calendar[position + 1])
                if position + 1 < len(calendar)
                else pd.NaT
            )
            row: dict[str, Any] = {
                "asset_id": asset,
                "signal_session": calendar[position],
            }
            covered = {
                source: coverage(
                    parse_checks(grouped.get((asset, source), [])),
                    source,
                    previous,
                    decision,
                    clocks.source_zone(source, zones),
                    policy,
                )
                for source in sources
            }
            for spec in specs:
                name = spec.name
                count, clock_missing, public_missing = index.window(
                    asset, name, previous, decision
                )
                label, basis = covered[spec.source]
                complete = basis and not clock_missing
                row[f"{name}_events_1d"] = count if complete else pd.NA
                row[f"{name}_observed_events_1d"] = count
                row[f"{name}_coverage"] = label
                row[f"{name}_coverage_basis"] = basis
                row[f"{name}_clock_missing"] = clock_missing
                row[f"{name}_public_clock_missing"] = public_missing
            bases = {basis for _, basis in covered.values()}
            row["info_regime"] = (
                "mixed"
                if {"observed", "reconstructed"} <= bases
                else "observed"
                if "observed" in bases
                else "reconstructed"
                if "reconstructed" in bases
                else ""
            )
            rows.append(row)
    frame = pd.DataFrame(rows)
    for spec in specs:
        name = spec.name
        values = frame[f"{name}_events_1d"].astype("Float64").astype("float64")
        frame[f"{name}_events_1d"] = frame[f"{name}_events_1d"].astype("Int64")
        for size in (5, 21, 63):
            total = values.groupby(frame["asset_id"], sort=False).transform(
                lambda series, size=size: series.rolling(size, min_periods=size).sum()
            )
            frame[f"{name}_events_{size}d"] = total
        frame[f"{name}_events_rank_21d"] = (
            frame[f"{name}_events_21d"]
            .where(frame["asset_id"].isin(population))
            .groupby(frame["signal_session"])
            .rank(pct=True)
        )
    frame = frame[
        frame["asset_id"].isin(asset_ids) & (frame["signal_session"] >= calendar[first])
    ].reset_index(drop=True)
    summary = {
        "skipped_sources": dict(sorted(index.skipped.items())),
        "undatable_events": dict(sorted(index.undatable.items())),
    }
    return frame, summary


# --- labels ------------------------------------------------------------------------

FLAT = {"cash": "cash", "worthless": "worthless", "last_close_proxy": "cash_proxy"}
STOCK = {"acquirer_close": "successor", "cash_and_acquirer_close": "cash_and_successor"}


def _positive(value: Any) -> bool:
    return value is not None and pd.notna(value) and value > 0


def reference_labels(
    days: Sequence[date],
    cutoff: date,
    samples: Iterable[tuple[str, date]],
    horizon: int,
    benchmark: str,
    *,
    daily: pd.DataFrame | None = None,
    prices: pd.DataFrame | None = None,
    delistings: pd.DataFrame | None = None,
    policy: Mapping[str, Any],
) -> list[dict[str, Any]]:
    """One label per (asset, signal): total return from ``daily`` rows (terminal rows
    end the asset leg) or vendor-adjusted ``prices``; one plain loop per row."""
    index = {value: position for position, value in enumerate(days)}
    opens: dict[tuple[str, int], float] = {}
    closes: dict[tuple[str, int], float] = {}
    status: dict[tuple[str, int], str] = {}
    raw: dict[tuple[str, int], float] = {}
    exits: dict[str, dict[str, Any]] = {}
    if daily is not None:
        for row in daily.to_dict("records"):
            day = clocks.day(row["date"])
            if day not in index:
                continue
            key = (row["asset_id"], index[day])
            if row["row_kind"] == "terminal":
                exits[row["asset_id"]] = {"at": index[day], **row}
                continue
            status[key], raw[key] = row["tr_status"], row["close_raw"]
            if _positive(row["tr_index"]) and _positive(row["close_raw"]):
                closes[key] = row["tr_index"]
                if _positive(row["open_raw"]):
                    opens[key] = row["tr_index"] * row["open_raw"] / row["close_raw"]
    else:
        for row in prices.to_dict("records"):
            key = (row["asset_id"], index[clocks.day(row["date"])])
            if _positive(row["open"]):
                opens[key] = row["open"]
            if _positive(row["close"]):
                closes[key] = row["close"]
    latest: dict[str, dict[str, Any]] = {}
    for row in (
        []
        if delistings is None
        else delistings.sort_values("observation_sequence").to_dict("records")
    ):
        latest[row["asset_id"]] = row
    last = max(position for position, value in enumerate(days) if value <= cutoff)
    result = []
    for asset, signal in samples:
        i = index[signal]
        t, e = i + 1, i + horizon
        beyond, entry_known = e > last, t <= last
        start = opens.get((asset, t)) if entry_known else None
        entry_ok = entry_known and _positive(start)
        level = closes.get((asset, e))
        exit_ok = _positive(level)
        info = exits.get(asset)
        x = info["at"] if info else -1
        delisted = not beyond and info is not None and t < x <= e
        terminal, post, unknown, heir = "", "", False, ""
        if delisted:
            basis = info["terminal_basis"] or "unknown"
            value = info["tr_index"]
            terminal = basis
            kind = (latest.get(asset) or {}).get("exit_type") or ""
            heir = (latest.get(asset) or {}).get("successor_asset_id") or ""
            if pd.notna(value) and value >= 0 and basis in FLAT:
                level, post = value, FLAT[basis]
            elif pd.notna(value) and value >= 0 and basis in STOCK:
                share = 0.0
                if basis != "acquirer_close":
                    previous, close_raw = (
                        closes.get((asset, x - 1)),
                        raw.get((asset, x - 1)),
                    )
                    worth = (
                        value / previous * close_raw
                        if _positive(previous) and close_raw is not None
                        else float("nan")
                    )
                    cash = info["cash_amount"]
                    share = (
                        cash / worth
                        if pd.notna(cash) and pd.notna(worth) and worth > 0
                        else float("nan")
                    )
                    if not 0 < share < 1:  # a mixed consideration has both parts
                        share = float("nan")
                a, b = closes.get((heir, x)), closes.get((heir, e))
                if _positive(a) and _positive(b) and pd.notna(share):
                    level, post = value * (share + (1 - share) * b / a), STOCK[basis]
                else:
                    level, post = value, "cash_proxy"
            else:
                rate = policy.get(kind, policy.get("unknown"))
                previous = closes.get((asset, x - 1))
                if rate is not None and _positive(previous):
                    level, terminal, post = (
                        previous * (1 + rate),
                        "policy",
                        "cash_proxy",
                    )
                else:
                    unknown = True
        asset_ok = entry_ok and not beyond and (not unknown if delisted else exit_ok)
        exit_missing = not beyond and not delisted and not exit_ok
        b0, b1 = opens.get((benchmark, t)), closes.get((benchmark, e))
        bench_ok = _positive(b0) and _positive(b1)
        bench_missing = not beyond and not bench_ok
        pair = not beyond and entry_ok and not exit_missing and not bench_missing
        pair = pair and not unknown
        asset_return = level / start - 1 if asset_ok else float("nan")
        bench_return = b1 / b0 - 1 if not beyond and bench_ok else float("nan")
        stop = x if delisted else e
        interior = sum((asset, k) not in closes for k in range(t, stop))
        # Every leg: the asset to its exit, the successor it follows, the benchmark.
        legs = [(asset, t, stop)]
        if post in ("successor", "cash_and_successor"):
            legs.append((heir, x, e))
        if asset != benchmark:
            legs.append((benchmark, t, e))
        disputed, vendor = (
            sum(
                status.get((who, k)) == state
                for who, first, final in legs
                for k in range(first + 1, final + 1)
            )
            for state in ("disputed", "vendor")
        )
        state = (
            ""
            if beyond or daily is None
            else "disputed"
            if disputed
            else "vendor"
            if vendor
            else "ok"
        )
        result.append(
            {
                "asset_id": asset,
                "signal_session": signal,
                "asset_return": asset_return,
                "benchmark_return": bench_return,
                "excess_return": asset_return - bench_return if pair else float("nan"),
                "pair_valid": pair,
                "horizon_beyond_material": beyond,
                "entry_price_missing": entry_known and not entry_ok,
                "exit_price_missing": exit_missing,
                "benchmark_missing": bench_missing,
                "interior_missing_sessions": None if beyond else interior,
                "disputed_sessions": None if beyond else disputed,
                "return_status": state,
                "delisted_in_window": delisted,
                "terminal_basis": terminal,
                "terminal_unknown": unknown,
                "post_exit_basis": post,
                "post_exit_sessions": e - x if delisted else 0,
            }
        )
    return result


# --- fundamentals (SDK 2.0.0rc1 scalar code, moved here as the oracle) -------------


def reference_fundamental_features(
    version_or_material: Any,
    samples: pd.DataFrame,
    *,
    metrics: Mapping[str, str],
    period_kind: str = "quarter",
    time_policy: str,
) -> pd.DataFrame:
    """Scalar fact join of SDK 2.0.0rc1 (one scan of the issuer's facts per sample).

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
    clocks.policy(time_policy)
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
        public, observed = (
            clocks.public_clock(row, zones),
            clocks.clock(row.get("observed_at")),
        )
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
        period_end_day = clocks.day(period_end_raw) if period_end_raw else None
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
        tuple[str, str, str, pd.Timestamp | None, date | None, date], dict[str, Any]
    ] = {}

    def _tag_rank_key(metric_name: str, row: Mapping[str, Any]) -> tuple[int, int, str]:
        t_val = row.get("tag")
        t_str = t_val if isinstance(t_val, str) else ""
        order = LEGACY_TAG_ORDER.get(metric_name, ())
        if t_str and t_str in order:
            return (0, order.index(t_str), t_str)
        prio = row.get("tag_priority", 0)
        prio_int = (
            int(prio)
            if isinstance(prio, (int, np.integer)) and not isinstance(prio, bool)
            else 0
        )
        return (1, prio_int, t_str)

    def _eval_metric(
        cik_padded: str,
        verified: bool,
        metric: str,
        unit: str,
        decision: pd.Timestamp | None,
        report_limit: date | None,
        signal_day: date,
    ) -> dict[str, Any]:
        cache_key = (
            cik_padded if verified else "",
            metric,
            unit,
            decision,
            report_limit,
            signal_day,
        )
        cached = eval_cache.get(cache_key)
        if cached is not None:
            return cached
        feature: dict[str, Any] = {
            "value": np.nan,
            "status": "metric_missing",
            "age_days": np.nan,
            "alternative_values": 0,
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
                row
                for row in matching_unit
                if row.get("period_kind") == period_kind
                and (
                    period_kind != "annual"
                    or not (isinstance(row.get("form"), str) and row.get("form"))
                    or row["form"].removesuffix("/A") in PERIODIC_ANNUAL_FORMS
                )
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
                    best_tag = min(_tag_rank_key(metric, row) for row in candidates)
                    tag_candidates = [
                        row
                        for row in candidates
                        if _tag_rank_key(metric, row) == best_tag
                    ]
                    try:
                        values = (
                            {Decimal(row["value"]) for row in tag_candidates}
                            if all(
                                isinstance(row.get("value"), str)
                                for row in tag_candidates
                            )
                            else set()
                        )
                    except (InvalidOperation, TypeError, ValueError):
                        values = set()
                    if not values or any(not value.is_finite() for value in values):
                        feature["status"] = "invalid_value"
                    elif (
                        len(values) != 1
                        or len({row.get("period_start") for row in tag_candidates}) != 1
                    ):
                        feature["status"] = "ambiguous"
                    else:
                        win_dec = next(iter(values))
                        chosen = min(
                            tag_candidates,
                            key=lambda row: (
                                row.get("tag_priority", 0),
                                row["fact_id"],
                            ),
                        )
                        alt_decimals: set[Decimal] = set()
                        tag_ids = {id(r) for r in tag_candidates}
                        for row in candidates:
                            if id(row) in tag_ids:
                                continue
                            txt = row.get("value")
                            if not isinstance(txt, str):
                                continue
                            try:
                                other_dec = Decimal(txt)
                            except (InvalidOperation, TypeError, ValueError):
                                continue
                            if other_dec.is_finite() and other_dec != win_dec:
                                alt_decimals.add(other_dec)
                        feature.update({name: chosen.get(name) for name in provenance})
                        number = float(win_dec)
                        age_val = float((signal_day - chosen["_period_end_day"]).days)
                        feature.update(
                            age_days=age_val,
                            alternative_values=len(alt_decimals),
                            raw_value=chosen["value"],
                            available_at=chosen["_available"],
                            public_clock_missing=chosen["_public"] is None,
                            availability_basis="observed_only"
                            if chosen["_public"] is None
                            else time_policy,
                        )
                        stale_limit = LEGACY_STALE_AFTER_DAYS.get(period_kind, 200)
                        if not np.isfinite(number):
                            feature["status"] = "nonfinite_model_value"
                        else:
                            feature["value"] = number
                            if age_val > stale_limit:
                                feature["status"] = "stale"
                            else:
                                feature["status"] = (
                                    "ok_observed_only"
                                    if chosen["_public"] is None
                                    else "ok"
                                )
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
        decision, signal = (
            clocks.clock(sample["decision_at"]),
            clocks.day(sample["signal_session"]),
        )
        report_limit = sample.get("report_period_end", signal)
        report_limit = (
            None
            if report_limit is None or pd.isna(report_limit) or report_limit == ""
            else min(signal, clocks.day(report_limit))
        )
        features: dict[str, Any] = {}
        for metric, unit in metrics.items():
            features.update(
                _eval_metric(
                    cik_padded, verified, metric, unit, decision, report_limit, signal
                )
            )
        results.append(features)
    columns = [
        f"{metric}_{name}"
        for metric in metrics
        for name in (
            "value",
            "status",
            "age_days",
            "alternative_values",
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


def reference_fundamental_ratios(
    version_or_material: Any,
    samples: pd.DataFrame,
    *,
    currency: str = "USD",
    period_kind: str = "quarter",
    time_policy: str,
) -> pd.DataFrame:
    """Ratios of SDK 2.0.0rc1 (a loop over samples)."""
    metrics = (
        "revenue",
        "gross_profit",
        "operating_income",
        "net_income",
        "operating_cash_flow",
        "capex",
    )
    current = reference_fundamental_features(
        version_or_material,
        samples,
        metrics={name: currency for name in metrics},
        period_kind=period_kind,
        time_policy=time_policy,
    )

    def previous_year(value: Any) -> date | None:
        if value is None or pd.isna(value) or value == "":
            return None
        day = clocks.day(value)
        try:
            return day.replace(year=day.year - 1)
        except ValueError:
            return day.replace(year=day.year - 1, day=28)

    prior_samples = samples.copy()
    prior_samples["report_period_end"] = [
        None if (py := previous_year(value)) is None else py + timedelta(days=7)
        for value in current["revenue_period_end"]
    ]
    prior = reference_fundamental_features(
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

    usable_statuses = {"ok", "ok_observed_only", "stale"}

    def input_status(row: Mapping[str, Any], names: Sequence[str]) -> str:
        if any(
            row[f"{name}_status"] not in usable_statuses
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
            if any(
                row[f"{name}_availability_basis"] == "observed_only" for name in names
            )
            else "ok"
        )

    def _prior_unverified(row: Mapping[str, Any], previous: Mapping[str, Any]) -> bool:
        for field in ("start", "end"):
            if (
                not row[f"revenue_period_{field}"]
                or not previous[f"revenue_period_{field}"]
            ):
                return True
        cur_s = clocks.day(row["revenue_period_start"])
        cur_e = clocks.day(row["revenue_period_end"])
        pri_s = clocks.day(previous["revenue_period_start"])
        pri_e = clocks.day(previous["revenue_period_end"])
        exp_e = previous_year(cur_e)
        if exp_e is None or cur_s > cur_e or pri_s > pri_e:
            return True
        if abs((pri_e - exp_e).days) > 7:
            return True
        return abs((pri_e - pri_s).days - (cur_e - cur_s).days) > 7

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
            if previous["revenue_status"] not in usable_statuses:
                status = "prior_unavailable"
            elif any(
                previous[f"revenue_{field}"] != row[f"revenue_{field}"]
                for field in ("cik", "unit", "currency")
            ):
                status = "prior_basis_mismatch"
            elif _prior_unverified(row, previous):
                status = "unverified_prior_period"
            elif previous["revenue_value"] == 0:
                status = "zero_prior_revenue"
            else:
                growth = row["revenue_value"] / previous["revenue_value"] - 1
                status = (
                    "ok_observed_only"
                    if "observed_only"
                    in {
                        row["revenue_availability_basis"],
                        previous["revenue_availability_basis"],
                    }
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

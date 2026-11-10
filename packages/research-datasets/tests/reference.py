"""Plain-loop reference of the 2.0 event and coverage semantics (test oracle).

Deliberately simple: one security, source and decision at a time. The vectorized
``research_datasets.events`` must reproduce it exactly on randomized material.
"""

from __future__ import annotations

from bisect import bisect_right
from collections.abc import Iterable, Mapping, Sequence
from datetime import date, datetime, time, timedelta
from typing import Any

import pandas as pd

from research_datasets import clocks
from research_datasets.constants import (
    CAPTURE_GRACE,
    NOT_LISTED_CODES,
    SOURCE_CONTRACTS,
    STORY_WINDOW,
    VETO_CODES,
)
from research_datasets.events import EventSpec, default_specs


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

"""Point-in-time (PIT) pandas DataFrame panel builders for frozen research datasets.

Every high-level function returns a ``pandas.DataFrame`` directly without requiring
preset train/validation/test split boundaries, while preserving full backward
compatibility with ``prepare()``, ``prepare_fundamental_features()``, and
``prepare_fundamental_ratios()``.
"""

from __future__ import annotations

import hashlib
import json
import platform
from collections.abc import Iterable, Mapping, Sequence
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
    DURATION_METRICS,
    INSTANT_METRICS,
    KEYS,
    RATIO_METRICS,
    SOURCES,
)

NEW_YORK = ZoneInfo("America/New_York")
LIMITATIONS = [
    "Vendor-adjusted prices can be revised; this is not a strict price-PIT dataset.",
    "The frozen research universe is not a historical eligibility universe.",
    "Adjusted open-to-close ratios are analytical proxies, not fills or net PnL.",
    "A date-only calendar uses 16:00 New York label ends, conservatively including early-close days.",
    "Source coverage describes saved source checks, not guaranteed publication completeness.",
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


def _mapping(value: Any) -> dict[str, Any]:
    if isinstance(value, Mapping):
        return dict(value)
    if isinstance(value, (list, tuple, np.ndarray)):
        return dict(
            (item["key"], item["value"]) if isinstance(item, Mapping) else item
            for item in value
        )
    return {}


def _public_clock(
    row: Mapping[str, Any], source_timezones: Mapping[str, str]
) -> pd.Timestamp | None:
    precision = row.get("public_time_precision")
    if not isinstance(precision, str):
        return None
    if precision == "second":
        return _clock(row.get("public_at"))
    if precision != "date":
        return None
    public_date = row.get("public_date")
    if public_date is None or pd.isna(public_date) or public_date == "":
        return None
    zone = source_timezones.get(str(row.get("source", "")))
    if not zone:
        return None
    try:
        next_day = _day(public_date) + timedelta(days=1)
        return pd.Timestamp(
            datetime.combine(next_day, time(), ZoneInfo(zone))
        ).tz_convert("UTC")
    except (ValueError, KeyError):
        return None


def _event_clocks(
    observations: pd.DataFrame,
    asset_ids: set[str],
    policy: str,
    source_timezones: Mapping[str, str],
) -> tuple[
    dict[tuple[str, str], list[tuple[str, list[dict[str, Any]]]]],
    dict[tuple[str, str, str], pd.Timestamp],
]:
    """Keep complete version chains and independent first-known event identities."""
    histories: dict[tuple[str, str], list[dict[str, Any]]] = {}
    first_known: dict[tuple[str, str, str], pd.Timestamp] = {}
    for row in observations.to_dict("records"):
        source, event_uid = row.get("source"), row.get("event_uid")
        if source not in SOURCES or not event_uid:
            raise ValueError(
                "Observation requires a supported source and logical event_uid"
            )
        sequence = row.get("observation_sequence")
        if (
            not isinstance(sequence, (int, np.integer))
            or isinstance(sequence, bool)
            or sequence < 0
        ):
            raise ValueError("Observation requires a nonnegative observation_sequence")
        links = _mapping(row.get("asset_first_seen_at"))
        public = _public_clock(row, source_timezones)
        content = _clock(row.get("content_first_seen_at"))
        recorded = _clock(row.get("observation_recorded_at"))
        available = public
        if policy == "observed_content":
            invalid_public = (
                row.get("public_time_precision") in {"second", "date"}
                and public is None
            )
            known = [
                clock for clock in (content, public, recorded) if clock is not None
            ]
            available = (
                max(known)
                if content is not None and recorded is not None and not invalid_public
                else None
            )
        linked = row.get("asset_ids")
        linked = [] if linked is None else linked
        assets: dict[str, pd.Timestamp | None] = {}
        for asset_id in set(linked).intersection(asset_ids):
            association = _clock(links.get(asset_id))
            asset_available = available
            if policy == "observed_content" and available is not None:
                asset_available = (
                    max(available, association) if association is not None else None
                )
            assets[asset_id] = asset_available
        histories.setdefault((source, event_uid), []).append(
            {
                "sequence": int(sequence),
                "available": available,
                "recorded": recorded,
                "assets": assets,
                "public_missing": public is None,
            }
        )
    by_asset_source: dict[tuple[str, str], list[tuple[str, list[dict[str, Any]]]]] = {}
    for (source, event_uid), versions in histories.items():
        versions.sort(key=lambda version: version["sequence"])
        if len({version["sequence"] for version in versions}) != len(versions):
            raise ValueError("Duplicate observation_sequence for one logical event")
        if policy == "public_reconstructed":
            first_by_clock: dict[pd.Timestamp, dict[str, Any]] = {}
            unknown: list[dict[str, Any]] = []
            for version in versions:
                if version["available"] is None:
                    unknown.append(version)
                else:
                    first_by_clock.setdefault(version["available"], version)
            versions = unknown + sorted(
                first_by_clock.values(), key=lambda version: version["available"]
            )
        for version in versions:
            for asset, available in version["assets"].items():
                key = (asset, source, event_uid)
                if available is not None and (
                    key not in first_known or available < first_known[key]
                ):
                    first_known[key] = available
        linked_assets: set[str] = set().union(
            *(version["assets"] for version in versions)
        )
        for asset in linked_assets:
            by_asset_source.setdefault((asset, source), []).append(
                (event_uid, versions)
            )
    return by_asset_source, first_known


def _event_counts(
    histories: Mapping[tuple[str, str], list[tuple[str, list[dict[str, Any]]]]],
    first_known: Mapping[tuple[str, str, str], pd.Timestamp],
    asset_id: str,
    source: str,
    previous: pd.Timestamp,
    decision: pd.Timestamp,
) -> tuple[int, bool, bool]:
    count, clock_missing, public_missing = 0, False, False
    if pd.isna(decision):
        return count, clock_missing, public_missing
    for event_uid, versions in histories.get((asset_id, source), []):
        selected = next(
            (
                version
                for version in reversed(versions)
                if version["available"] is not None and version["available"] < decision
            ),
            None,
        )
        selected_sequence = selected["sequence"] if selected is not None else -1
        clock_missing |= any(
            version["available"] is None
            and version["sequence"] > selected_sequence
            and (version["recorded"] is None or version["recorded"] < decision)
            for version in versions
        )
        if selected is None or asset_id not in selected["assets"]:
            continue
        available = selected["assets"][asset_id]
        if available is None:
            clock_missing = True
            continue
        if available >= decision:
            continue
        public_missing |= selected["public_missing"]
        initial = first_known[(asset_id, source, event_uid)]
        count += previous <= initial < decision
    return int(count), bool(clock_missing), bool(public_missing)


def _coverage(
    checks: Sequence[Mapping[str, Any]],
    source: str,
    previous: pd.Timestamp,
    decision: pd.Timestamp,
    source_timezones: Mapping[str, str],
) -> str:
    if pd.isna(decision):
        return "unknown"
    zone = ZoneInfo(source_timezones.get(source, "America/New_York"))
    first = previous.tz_convert(zone).date()
    last = (
        decision.tz_convert(zone).to_pydatetime() - timedelta(microseconds=1)
    ).date()
    relevant = []
    unbounded = []
    for row in checks:
        checked = _clock(row.get("checked_at"))
        if checked is None or checked >= decision:
            continue
        if not row.get("checked_start") or not row.get("checked_end"):
            unbounded.append((checked, row.get("status", "unknown")))
            continue
        start, end = _day(row["checked_start"]), _day(row["checked_end"])
        if start <= last and end >= first:
            relevant.append(
                (checked, start, end, row.get("status"), row.get("error_code"))
            )
    if not relevant:
        return max(unbounded)[1] if unbounded else "unknown"
    if unbounded:
        failed_at, failed_state = max(unbounded)
        if failed_at >= max(row[0] for row in relevant) and failed_state not in {
            "checked",
            "empty",
        }:
            return str(failed_state)
    states = []
    for offset in range((last - first).days + 1):
        day = first + timedelta(days=offset)
        covering = [row for row in relevant if row[1] <= day <= row[2]]
        if not covering:
            return "unknown"
        latest = max(covering, key=lambda row: row[0])
        states.append(
            "partial" if latest[4] and latest[3] in {"checked", "empty"} else latest[3]
        )
    if all(state in {"checked", "empty"} for state in states):
        return "empty" if all(state == "empty" for state in states) else "checked"
    return str(next(state for state in states if state not in {"checked", "empty"}))


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
) -> pd.DataFrame:
    histories, first_known = _event_clocks(observations, set(asset_ids), policy, zones)
    checks_by_source: dict[tuple[Any, Any], list[dict[str, Any]]] = {}
    for row in checks.to_dict("records"):
        checks_by_source.setdefault(
            (row.get("asset_id"), row.get("source")), []
        ).append(row)
    cal_index = {day: idx for idx, day in enumerate(calendar)}
    result = []
    for asset_id in asset_ids:
        bars = adjusted.get(asset_id)
        closes = pd.Series(np.nan, index=calendar) if bars is None else bars["close"]
        closes = closes.where(np.isfinite(closes) & (closes > 0))
        returns = closes / closes.shift(1) - 1
        consecutive = closes.rolling(21, min_periods=21).count() == 21
        momentum = (closes / closes.shift(20) - 1).where(consecutive)
        volatility = returns.rolling(20, min_periods=20).std(ddof=1).where(consecutive)
        for signal in signals:
            index = cal_index[signal]
            decision = (
                _at(calendar[index + 1], 9) if index + 1 < len(calendar) else pd.NaT
            )
            previous = _at(signal, 9)
            nominal = raw.get(asset_id)
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
            for source in SOURCES:
                count, clock_missing, public_missing = _event_counts(
                    histories, first_known, asset_id, source, previous, decision
                )
                coverage = _coverage(
                    checks_by_source.get((asset_id, source), []),
                    source,
                    previous,
                    decision,
                    zones,
                )
                feature[f"{source}_new_event_count"] = (
                    count
                    if coverage in {"checked", "empty"} and not clock_missing
                    else np.nan
                )
                feature[f"{source}_observed_new_event_count"] = count
                feature[f"{source}_coverage"] = coverage
                feature[f"{source}_clock_missing"] = clock_missing
                feature[f"{source}_public_clock_missing"] = public_missing
            result.append(feature)
    frame = pd.DataFrame(result)
    for source in SOURCES:
        frame[f"{source}_new_event_count"] = frame[f"{source}_new_event_count"].astype(
            "Int64"
        )
    return frame


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
                "label_start": _at(entry, 9, 30) if entry_expected else pd.NaT,
                "label_end": _at(exit_day, 16) if not beyond else pd.NaT,
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
    time_policy: str = "observed_content",
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
    if time_policy not in {
        "public_reconstructed",
        "observed_content",
    } or horizon not in {1, 5}:
        raise ValueError("Choose an explicit supported time policy and H=1 or H=5")
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
    features = _feature_rows(
        calendar,
        signals,
        asset_ids,
        raw,
        adjusted,
        material["event_observations"],
        material["source_checks"],
        time_policy,
        zones,
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
        "time_policy": time_policy,
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
        "feature_masks": {
            column: int(features[column].sum())
            for column in features
            if column.endswith("_missing")
        },
        "source_coverage_counts": {
            source: features[f"{source}_coverage"].value_counts().to_dict()
            for source in SOURCES
        },
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
    time_policy: str = "observed_content",
) -> pd.DataFrame:
    """Join explicit-unit SEC facts to frozen candidate UUIDs without dropping rows."""
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
    if time_policy not in {"observed_content", "public_reconstructed"}:
        raise ValueError("Choose an explicit supported time policy")
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
            available = (
                max(observed, public)
                if observed is not None and public is not None
                else observed
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
                    if row["_available"] is not None and row["_available"] < decision
                ]
                chosen = eligible[-1] if eligible else None
                if time_policy == "observed_content":
                    unknown.extend(
                        row
                        for row in versions
                        if row["_available"] is None
                        and (row["_observed"] is None or row["_observed"] < decision)
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
    time_policy: str = "observed_content",
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
            decision = _at(calendar[idx + 1], 9) if idx + 1 < len(calendar) else pd.NaT
            previous = _at(signal, 9)
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
    start: str | date | None = None,
    end: str | date | None = None,
    time_policy: str = "observed_content",
) -> pd.DataFrame:
    """Return daily price/volume/event-count PIT features as a ``pd.DataFrame`` (no split boundaries needed)."""
    if time_policy not in {"public_reconstructed", "observed_content"}:
        raise ValueError("Choose an explicit supported time policy")
    asset_ids = version.resolve(symbols)
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
    features = _feature_rows(
        calendar,
        signals,
        asset_ids,
        raw,
        adjusted,
        observations,
        checks,
        time_policy,
        zones,
    )
    features.attrs["provenance"] = {
        "dataset_id": str(version.id),
        "manifest_sha256": version.manifest_sha256,
        "parameters": {
            "asset_ids": asset_ids,
            "start": str(start_d),
            "end": str(end_d),
            "time_policy": time_policy,
        },
        "counts": {"candidates": len(features)},
        "feature_masks": {
            column: int(features[column].sum())
            for column in features
            if column.endswith("_missing")
        },
        "source_coverage_counts": {
            source: features[f"{source}_coverage"].value_counts().to_dict()
            for source in SOURCES
        },
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
    if period_kind in {"quarter", "annual"}:
        return dict(DURATION_METRICS)
    return dict(ALL_METRICS)


def fundamental_features(
    version: Any,
    candidates_or_symbols: pd.DataFrame | str | Sequence[str] | None = None,
    *,
    start: str | date | None = None,
    end: str | date | None = None,
    metrics: Mapping[str, str] | Sequence[str] | None = None,
    period_kind: str | Sequence[str] = "quarter",
    time_policy: str = "observed_content",
) -> pd.DataFrame:
    """Return PIT-aligned fundamental features as a ``pd.DataFrame``.

    - ``metrics`` may be ``None`` (uses standard duration or instant metrics for ``period_kind``),
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
    start: str | date | None = None,
    end: str | date | None = None,
    currency: str = "USD",
    period_kind: str | Sequence[str] = "quarter",
    time_policy: str = "observed_content",
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
    start: str | date | None = None,
    end: str | date | None = None,
    benchmark: str = "SPY",
    horizons: int | Iterable[int] = (1, 5),
    time_policy: str = "observed_content",
    fundamental_time_policy: str | None = None,
    include_fundamentals: bool = True,
    include_ratios: bool = True,
    output_dir: str | Path | None = None,
) -> pd.DataFrame:
    """Build a unified PIT research ``pd.DataFrame`` combining daily features, fundamentals, ratios, and forward returns."""
    fund_policy = fundamental_time_policy or time_policy
    daily = daily_features(
        version,
        symbols,
        start=start,
        end=end,
        time_policy=time_policy,
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
        parts.append(ratios.drop(columns=KEYS))

    labels = forward_returns(
        version,
        candidates,
        benchmark=benchmark,
        horizons=horizons,
    )
    parts.append(labels.drop(columns=KEYS))

    combined = pd.concat(parts, axis=1)
    provenance = {
        "dataset_id": str(version.id),
        "manifest_sha256": version.manifest_sha256,
        "parameters": {
            "symbols": symbols,
            "start": str(start)
            if start is not None
            else str(daily["signal_session"].min()),
            "end": str(end) if end is not None else str(daily["signal_session"].max()),
            "benchmark": benchmark,
            "horizons": [horizons] if isinstance(horizons, int) else list(horizons),
            "time_policy": time_policy,
            "fundamental_time_policy": fund_policy,
            "include_fundamentals": include_fundamentals,
            "include_ratios": include_ratios,
        },
        "rows": len(combined),
        "columns": len(combined.columns),
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

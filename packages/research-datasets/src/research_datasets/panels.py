"""Point-in-time (PIT) pandas DataFrame panel builders for frozen research datasets.

Every high-level function returns a ``pandas.DataFrame`` directly without requiring
preset train/validation/test split boundaries. ``time_policy`` is always explicit.
Clocks live in ``clocks``, event counts and coverage in ``events``, run records in
``provenance``; this module orchestrates them.
"""

from __future__ import annotations

import inspect
import json
from collections.abc import Iterable, Mapping, Sequence
from datetime import date
from pathlib import Path
from typing import Any
from uuid import UUID

import numpy as np
import pandas as pd

from . import candidates as _candidates
from . import clocks
from . import extra_features as _extra_features
from . import fundamentals as _fundamentals
from . import fundamentals_derived as _fundamentals_derived
from . import industry as _industry
from . import labels as _labels
from . import release_features as _release_features
from . import sec_events as _sec_events
from . import valuation as _valuation
from .candidates import build_candidates
from .clocks import CAPTURE_DEADLINE as _CAPTURE_DEADLINE
from .clocks import day as _day
from .clocks import policy as _policy
from .constants import (
    DECISION_TIME,
    DEFAULT_EXTRA_GROUPS,
    DEFAULT_HORIZONS,
    EXTRA_GROUPS,
    KEYS,
    NEW_YORK_ZONE,
    QUARTER_DEFAULT_EXCLUDED_METRICS,
    QUARTER_DEFAULT_EXCLUDED_RATIOS,
    TIME_POLICY_VERSION,
)
from .events import WARMUP_SESSIONS, EventSpec, event_features
from .fundamentals import (
    fundamental_features,
    fundamental_ratios,
    prepare_fundamental_features,
    prepare_fundamental_ratios,
)
from .provenance import run_record

__all__ = [
    "KEYS",
    "LIMITATIONS",
    "build_candidates",
    "daily_features",
    "forward_returns",
    "fundamental_features",
    "fundamental_ratios",
    "material_from_version",
    "panel",
    "prepare",
    "prepare_fundamental_features",
    "prepare_fundamental_ratios",
]

# Columns the event reduction reads; other observation columns are not loaded.
OBSERVATION_COLUMNS = (
    "source",
    "event_uid",
    "event_id",
    "observation_sequence",
    "form",
    "items",
    "filing_date",
    "event_date",
    "asset_ids",
    "asset_first_seen_at",
    "content_first_seen_at",
    "observation_recorded_at",
    "public_time_precision",
    "public_at",
    "public_date",
    "public_time_basis",
    "event_kinds",
    "story_key",
)
LIMITATIONS = [
    "Vendor-adjusted prices can be revised; this is not a strict price-PIT dataset.",
    "Labels are analytical open-to-close returns, not fills or net PnL.",
    "A row is decided at 06:00 New York on its entry session and sees information public at or before then; its event window is (06:00 on the signal session, 06:00 on the entry session].",
    "SEC filings are public at max(acceptance, 06:00 New York on the SEC filing date); observed_content also requires each capture by 09:00 New York on the entry session.",
    "Under public_reconstructed, event links come from each event's latest saved version and coverage comes from saved check windows regardless of when they ran.",
    "Unverified-identity, not-listed and truncated check windows stay missing, never 0; source coverage describes saved checks, not publication completeness.",
    "sec counts keep the 8-K, 10-K, 10-Q, 6-K and 20-F forms; sources without a publication clock produce no count features.",
    "21-session event ranks are percentiles over the universe's non-benchmark securities, whatever the selection.",
    "Quarterly cash-flow facts are year-to-date in 10-Q filings, so default quarterly columns omit operating cash flow, capex and free cash flow.",
]


def _live_limitations(parameters: Mapping[str, Any], carried: int) -> list[str]:
    """Run-record lines for a live session whose month has no frozen membership."""
    if carried:
        month = parameters["membership_carried_from"]
        return [
            (
                "The live session's month has no frozen membership yet: its rows use "
                f"the {month} membership (membership_carried)."
            )
        ]
    if parameters.get("live_membership_unknown"):
        return [
            (
                "The live session's month and the month before it have no frozen "
                "membership: its rows' membership is unknown (dropped unless "
                "keep_non_members)."
            )
        ]
    return []


def _price_frame(frame: pd.DataFrame) -> pd.DataFrame:
    required = {"asset_id", "date", "open", "close", "volume"}
    if not required.issubset(frame.columns):
        raise ValueError(
            f"Price material lacks columns: {sorted(required - set(frame.columns))}"
        )
    result = frame.copy()
    result["asset_id"] = result["asset_id"].astype(str)
    result["date"] = (
        result["date"].dt.date
        if pd.api.types.is_datetime64_any_dtype(result["date"])
        else result["date"].map(_day)
    )
    if result.duplicated(["asset_id", "date"]).any():
        raise ValueError("Duplicate security/session prices")
    for column in ("open", "close", "volume"):
        result[column] = pd.to_numeric(result[column], errors="coerce")
    return result


def _wide(
    frame: pd.DataFrame, calendar: Sequence[date], assets: Sequence[str], column: str
) -> pd.DataFrame:
    """Sessions x securities matrix of one normalized price column."""
    if frame.empty:
        return pd.DataFrame(np.nan, index=list(calendar), columns=list(assets))
    wide = frame.pivot(index="date", columns="asset_id", values=column)
    return wide.reindex(index=list(calendar), columns=list(assets)).astype("float64")


def _news_versions(version: Any) -> pd.DataFrame | None:
    """Story keys of frozen article text versions, when the version has them."""
    if "news_versions" not in _candidates.families(version) or not hasattr(
        version, "family"
    ):
        return None
    return version.family(
        "news_versions", columns=["event_id", "story_key", "provider_updated_at"]
    )


def _observations(
    version: Any, specs: Sequence[EventSpec] | None = None
) -> pd.DataFrame:
    """Frozen observation versions, projected to the columns the reduction and the
    specifications' filters read."""
    reader = version.event_observations
    try:
        projected = "columns" in inspect.signature(reader).parameters
    except (TypeError, ValueError):
        projected = False
    if not projected:
        return reader()
    filters = [column for spec in specs or () for column in spec.columns()]
    return reader(columns=list(dict.fromkeys([*OBSERVATION_COLUMNS, *filters])))


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
    """Read frozen families only; missing capabilities deliberately raise.

    Label inputs (universe_membership, daily_returns with exit successors,
    delistings) are read when the version has them.
    """
    if str(version.id) != dataset_id:
        raise ValueError("Version does not match the explicit dataset UUID")
    ids = list(
        dict.fromkeys(
            [*asset_ids, *([benchmark_id] if benchmark_id is not None else [])]
        )
    )
    # Ranks compare against the whole non-benchmark universe, so its checks are read too.
    population = _rank_population(
        version.universe, [benchmark_id] if benchmark_id is not None else []
    )
    material = {
        "manifest": version.manifest,
        "manifest_sha256": version.manifest_sha256,
        "calendar": version.calendar,
        "universe": version.universe,
        "raw": version.prices(ids, adjusted=False),
        "all": version.prices(ids, adjusted=True),
        "event_observations": _observations(version),
        "source_checks": version.source_checks(sorted(population.union(asset_ids))),
        "news_versions": _news_versions(version),
        "universe_membership": _candidates.read_membership(version, asset_ids),
    }
    if "daily_returns" in _candidates.families(version):
        material.update(_return_inputs(version, ids))
    return material


def _feature_rows(
    calendar: Sequence[date],
    signals: Sequence[date],
    asset_ids: Sequence[str],
    raw: pd.DataFrame,
    adjusted: pd.DataFrame,
    observations: pd.DataFrame,
    checks: pd.DataFrame,
    policy: str,
    zones: Mapping[str, str],
    news_versions: pd.DataFrame | None = None,
    population: frozenset[str] = frozenset(),
    specs: Sequence[EventSpec] | None = None,
    next_session: date | None = None,
    output_positions: np.ndarray | None = None,
) -> tuple[pd.DataFrame, dict[str, Any]]:
    """Daily features for contiguous signal sessions and the event reduction summary.

    ``raw`` and ``adjusted`` are normalized price rows. Event counts and coverage are
    computed for the selection and the rank population, over warm-up sessions that feed
    the rolling counts of the first signals.
    """
    sessions = clocks.Calendar(calendar, next_session=next_session)
    first, last = sessions.index(signals[0]), sessions.index(signals[-1])
    start = max(0, first - WARMUP_SESSIONS)
    output = slice(first, last + 1) if output_positions is None else output_positions
    assets = [*asset_ids, *sorted(population.difference(asset_ids))]
    position = {asset: index for index, asset in enumerate(assets)}
    events, summary = event_features(
        observations,
        checks,
        assets=assets,
        selected=len(asset_ids),
        decisions=sessions.decisions[start : last + 2],
        first_signal=first - start,
        policy=policy,
        zones=zones,
        news_versions=news_versions,
        population=[position[asset] for asset in sorted(population)],
        specs=specs,
        output_windows=None if output_positions is None else output_positions - start,
        signal_days=calendar[first : last + 1],
    )
    closes = _wide(adjusted, calendar, asset_ids, "close")
    closes = closes.where(np.isfinite(closes) & (closes > 0))
    returns = closes / closes.shift(1) - 1
    consecutive = closes.rolling(21, min_periods=21).count() == 21
    momentum = (closes / closes.shift(20) - 1).where(consecutive)
    volatility = returns.rolling(20, min_periods=20).std(ddof=1).where(consecutive)
    close = _wide(raw, calendar, asset_ids, "close")
    volume = _wide(raw, calendar, asset_ids, "volume")
    dollars = (close * volume).where(
        np.isfinite(close) & (close > 0) & np.isfinite(volume) & (volume >= 0)
    )

    def rows(frame: pd.DataFrame) -> np.ndarray:
        return frame.iloc[output].to_numpy().T.ravel()

    output_days = np.asarray(calendar, dtype=object)[output]
    count, length = len(asset_ids), len(output_days)
    decisions = sessions.decisions
    frame = pd.DataFrame(
        {
            "asset_id": np.repeat(np.array(asset_ids, dtype=object), length),
            "signal_session": np.tile(output_days, count),
            "previous_decision_at": clocks.utc(np.tile(decisions[output], count)),
            "decision_at": clocks.utc(
                np.tile(
                    decisions[first + 1 : last + 2]
                    if output_positions is None
                    else decisions[output_positions + 1],
                    count,
                )
            ),
            "momentum20": rows(momentum),
            "volatility20": rows(volatility),
            "price_history_missing": ~rows(consecutive).astype(bool),
            "raw_dollar_volume": rows(dollars),
            "raw_dollar_volume_missing": np.isnan(rows(dollars)),
            **events,
        }
    )
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
            source: _value_counts(features[f"{name}_coverage"])
            for source, name in events["coverage_columns"].items()
        },
        "source_coverage": _coverage_summary(features, events["coverage_columns"]),
        "skipped_sources": dict(events["skipped_sources"]),
        "undatable_events": dict(events["undatable_events"]),
        "rank_population": dict(events["rank_population"]),
    }


def _value_counts(column: pd.Series) -> dict[str, int]:
    counts = column.value_counts()
    return {str(key): int(value) for key, value in counts.items() if value}


def _coverage_summary(
    features: pd.DataFrame, columns: Mapping[str, str]
) -> dict[str, Any]:
    """Per counted source (read from the named spec's columns): window labels, bases
    and the first countable signal session."""
    summary = {}
    for source, name in columns.items():
        basis = features[f"{name}_coverage_basis"]
        covered = features.loc[basis != "", "signal_session"]
        assets = features.loc[basis != "", "asset_id"]
        summary[source] = {
            "states": _value_counts(features[f"{name}_coverage"]),
            "basis": _value_counts(basis[basis != ""]),
            "first_covered_session": str(covered.min()) if len(covered) else None,
            "assets_with_coverage": int(assets.nunique()),
        }
    return summary


def _membership_present(material: Any) -> bool:
    if isinstance(material, Mapping):
        return material.get("universe_membership") is not None
    return "universe_membership" in _candidates.families(material)


def _return_inputs(
    version: Any,
    asset_ids: Sequence[str],
    start: date | None = None,
    end: date | None = None,
) -> dict[str, Any]:
    """Label inputs of the securities: total-return rows (with the successors of their
    exits) and delistings, or vendor-adjusted prices when the version has no
    daily_returns."""
    present = _candidates.families(version)
    ids = list(dict.fromkeys(map(str, asset_ids)))
    if "daily_returns" not in present:
        return {"all": version.prices(ids, adjusted=True)}
    delistings = (
        version.family("delistings", ids, columns=list(_labels.DELISTING_COLUMNS))
        if "delistings" in present
        else None
    )
    known = {str(row["asset_id"]) for row in _candidates.records(version.universe)}
    heirs = [
        heir
        for heir in _labels.successors(delistings).values()
        if heir in known and heir not in ids
    ]
    dates = {
        key: str(value)
        for key, value in (("start", start), ("end", end))
        if value is not None
    }
    daily = version.family(
        "daily_returns",
        [*ids, *dict.fromkeys(heirs)],
        columns=list(_labels.DAILY_RETURN_COLUMNS),
        **dates,
    )
    return {"daily_returns": daily, "delistings": delistings}


def _series(
    inputs: Mapping[str, Any], days: Sequence[date], assets: Sequence[str]
) -> _labels.ReturnSeries:
    daily = inputs.get("daily_returns")
    if daily is None:
        return _labels.vendor_series(_price_frame(inputs["all"]), days, assets)
    delistings = inputs.get("delistings")
    heirs = list(_labels.successors(delistings).values())
    assets = list(dict.fromkeys([*assets, *heirs]))
    return _labels.total_return_series(daily, days, assets, delistings)


def _label_rows(
    samples: pd.DataFrame,
    inputs: Mapping[str, Any],
    cal: clocks.Calendar,
    *,
    horizon_list: Sequence[int],
    single: bool,
    benchmark_id: str,
    cutoff: date,
    policy: Mapping[str, Any],
    membership: pd.DataFrame | None,
    rule: str | None,
    months: Mapping[str, Any],
) -> pd.DataFrame:
    """Label columns for ``samples`` rows with their point-in-time membership."""
    signal = cal.positions(samples["signal_session"])
    if rule is None:
        member = _candidates.unknown(len(samples))
    else:
        member = _candidates.in_universe(
            samples["asset_id"].astype(str),
            _candidates.entry_days(cal, signal),
            membership,
            rule,
            months,
        )
    assets = [*dict.fromkeys(samples["asset_id"].astype(str)), benchmark_id]
    series = _series(inputs, cal.days, list(dict.fromkeys(assets)))
    frame = _labels.label_frame(
        samples,
        series,
        cal,
        horizon_list=horizon_list,
        single=single,
        benchmark_id=benchmark_id,
        cutoff=cutoff,
        policy=policy,
        in_universe=member,
        static=rule is None,
    )
    frame.attrs["return_basis"] = series.basis
    frame.attrs["label_overlap"] = _labels.label_overlap(signal, horizon_list)
    return frame


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
    embargo_sessions: int = 0,
    sampling: str = "daily",
    universe: str = "pit",
    allow_static_universe: bool = False,
    terminal_policy: Mapping[str, Any] | None = None,
    output_dir: str | Path | None = None,
) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame | None, dict[str, Any]]:
    """Return features, labels, split membership (or None when train_end/validation_end
    are omitted), and provenance.

    Rows are the selected securities on the sampled signal sessions; under a
    point-in-time universe only members are kept. A version without membership rows
    needs ``allow_static_universe=True`` (UNIVERSE_NOT_PIT otherwise).
    """
    dataset_id, benchmark_id = str(UUID(dataset_id)), str(UUID(benchmark_id))
    asset_ids = [str(UUID(asset)) for asset in asset_ids]
    if not asset_ids or len(asset_ids) != len(set(asset_ids)):
        raise ValueError("Choose unique asset UUIDs")
    _policy(time_policy)
    if isinstance(horizon, bool) or not isinstance(horizon, int):
        raise TypeError("prepare takes one integer horizon")
    horizon_list, _ = _labels.horizons(horizon)
    policy = _labels.terminal_policy(terminal_policy)
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
    rule = _candidates.membership_rule(_membership_present(material), universe)
    universe_basis = _candidates.require_pit(rule, allow_static_universe)
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
    universe_rows = material["universe"]
    known = {str(row["asset_id"]) for row in _candidates.records(universe_rows)}
    if not {*asset_ids, benchmark_id}.issubset(known):
        raise ValueError("A selected security is outside the frozen universe")
    cal = _candidates.calendar(manifest, calendar)
    positions = _candidates.signal_positions(cal, start_d, end_d, sampling)
    sampled = [calendar[position] for position in positions]
    if (
        has_splits
        and train_d is not None
        and val_d is not None
        and (
            not any(day <= train_d for day in sampled)
            or not any(train_d < day <= val_d for day in sampled)
            or not any(day > val_d for day in sampled)
        )
    ):
        raise ValueError("Each split must contain at least one frozen signal session")
    raw, adjusted = _price_frame(material["raw"]), _price_frame(material["all"])
    zones = manifest.get("source_timezones", {})
    features, events = _feature_rows(
        calendar,
        [sampled[0], sampled[-1]],
        asset_ids,
        raw,
        adjusted,
        material["event_observations"],
        material["source_checks"],
        time_policy,
        zones,
        material.get("news_versions"),
        _rank_population(universe_rows, [benchmark_id]),
    )
    features = features[features["signal_session"].isin(set(sampled))]
    features = features.reset_index(drop=True)
    inputs = {
        "all": material["all"],
        "daily_returns": material.get("daily_returns"),
        "delistings": material.get("delistings"),
    }
    labels = _label_rows(
        features,
        inputs,
        cal,
        horizon_list=horizon_list,
        single=True,
        benchmark_id=benchmark_id,
        cutoff=_day(manifest["cutoff_date"]),
        policy=policy,
        membership=material.get("universe_membership"),
        rule=rule,
        months=_candidates.membership_months(manifest),
    )
    return_basis, overlap = labels.attrs["return_basis"], labels.attrs["label_overlap"]
    grid = len(features)
    if rule is not None:
        keep = labels["in_universe"].fillna(False).to_numpy(dtype=bool)
        features = features[keep].reset_index(drop=True)
        labels = labels[keep].reset_index(drop=True)
        if has_splits and train_d is not None and val_d is not None:
            kept = set(features["signal_session"])
            if (
                not any(day <= train_d for day in kept)
                or not any(train_d < day <= val_d for day in kept)
                or not any(day > val_d for day in kept)
            ):
                raise ValueError(
                    "Each split must contain at least one member row of the "
                    "point-in-time universe"
                )
    splits = (
        _labels.split_membership(
            features[[*KEYS, "decision_at"]].assign(label_end=labels["label_end"]),
            train_end=train_d,
            validation_end=val_d,
            cal=cal,
            embargo_sessions=embargo_sessions,
        )
        if has_splits and train_d is not None and val_d is not None
        else None
    )
    parameters: dict[str, Any] = {
        "asset_ids": asset_ids,
        "benchmark_id": benchmark_id,
        "start": str(start_d),
        "end": str(end_d),
        **_time_parameters(time_policy),
        "horizon": horizon,
        "sampling": sampling,
        "embargo_sessions": embargo_sessions,
        "universe_basis": universe_basis,
        "universe_rule": rule,
        "terminal_policy": policy,
        "return_basis": return_basis,
    }
    if has_splits and train_d is not None and val_d is not None:
        parameters["train_end"] = str(train_d)
        parameters["validation_end"] = str(val_d)
    dropped = grid - len(features)
    masks = _labels.mask_counts(labels, horizon_list, True, rule is None, dropped)
    masks = masks[str(horizon)]
    counts: dict[str, int] = {
        "candidates": len(features),
        "in_universe": int(labels["in_universe"].fillna(rule is None).sum()),
        "not_in_universe_dropped": dropped,
        "pair_valid": masks.pop("pair_valid"),
        "trainable": masks.pop("trainable"),
    }
    if splits is not None:
        counts["purged"] = int(splits["purged"].sum())
    run = run_record(
        dataset_id=dataset_id,
        manifest_sha256=digest,
        parameters=parameters,
        counts=counts,
        masks=masks,
        label_overlap=overlap,
        **_feature_provenance(features, events),
        limitations=[
            *LIMITATIONS,
            *_labels.limitations(universe_basis, return_basis),
            *manifest.get("limitations", []),
        ],
    )
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


# ---------------------------------------------------------------------------
# High-level split-free pandas DataFrame builders (Layer 2)
# ---------------------------------------------------------------------------


def _read_feature_rows(
    version: Any,
    symbols: str | Sequence[str] | None,
    *,
    time_policy: str,
    start: str | date | None,
    end: str | date | None,
    benchmark: str | None,
    specs: Sequence[EventSpec] | None = None,
    sampling: str = "daily",
    next_session: str | date | None,
    output_days: Sequence[date] | None = None,
) -> tuple[pd.DataFrame, dict[str, Any], dict[str, Any]]:
    _policy(time_policy)
    asset_ids = list(dict.fromkeys(map(str, version.resolve(symbols))))
    benchmark_ids = version.resolve(benchmark) if benchmark is not None else []
    calendar = list(map(_day, version.calendar))
    cal = _candidates.calendar(version, calendar, next_session=next_session)
    positions = _candidates.signal_positions(cal, start, end, sampling)
    sampled = [calendar[position] for position in positions]
    raw = _price_frame(version.prices(asset_ids, adjusted=False))
    adjusted = _price_frame(version.prices(asset_ids, adjusted=True))
    population = _rank_population(version.universe, benchmark_ids)
    features, events = _feature_rows(
        calendar,
        [sampled[0], sampled[-1]],
        asset_ids,
        raw,
        adjusted,
        _observations(version, specs),
        version.source_checks(sorted(population.union(asset_ids))),
        time_policy,
        version.manifest.get("source_timezones", {}),
        _news_versions(version),
        population,
        specs,
        next_session=cal.next_session,
        output_positions=None if output_days is None else cal.positions(output_days),
    )
    if sampling != "daily":
        features = features[features["signal_session"].isin(set(sampled))]
        features = features.reset_index(drop=True)
    parameters = {
        "asset_ids": asset_ids,
        "start": str(sampled[0]),
        "end": str(sampled[-1]),
        "benchmark_ids": benchmark_ids,
        **_time_parameters(time_policy),
        "event_specs": events["specs"],
        "sampling": sampling,
        "next_session": None if cal.next_session is None else str(cal.next_session),
    }
    return features, events, parameters


def daily_features(
    version: Any,
    symbols: str | Sequence[str] | None = None,
    *,
    time_policy: str,
    start: str | date | None = None,
    end: str | date | None = None,
    benchmark: str | None = None,
    specs: Sequence[EventSpec] | None = None,
    sampling: str = "daily",
    next_session: str | date | None = None,
) -> pd.DataFrame:
    """Return daily price/volume/event-count PIT features as a ``pd.DataFrame`` (no split boundaries needed).

    ``{name}_events_rank_21d`` ranks among the universe's securities that are neither
    flagged benchmarks nor ``benchmark``, whatever the selection. ``specs`` replaces the
    default one-per-source event specifications. A security selected twice gives one
    set of rows. Features are computed on the daily grid, then ``sampling`` keeps the
    last session of each completed week or month. ``next_session`` gives the last frozen
    session a live decision instant and event window.
    """
    features, events, parameters = _read_feature_rows(
        version,
        symbols,
        time_policy=time_policy,
        start=start,
        end=end,
        benchmark=benchmark,
        specs=specs,
        sampling=sampling,
        next_session=next_session,
    )
    features.attrs["provenance"] = run_record(
        dataset_id=str(version.id),
        manifest_sha256=version.manifest_sha256,
        parameters=parameters,
        counts={"candidates": len(features)},
        **_feature_provenance(features, events),
        limitations=LIMITATIONS + list(version.manifest.get("limitations", [])),
    )
    return features


def forward_returns(
    version: Any,
    candidates_or_symbols: pd.DataFrame | str | Sequence[str] | None = None,
    *,
    start: str | date | None = None,
    end: str | date | None = None,
    benchmark: str = "SPY",
    horizons: int | Iterable[int] = DEFAULT_HORIZONS,
    sampling: str = "daily",
    universe: str = "pit",
    allow_static_universe: bool = False,
    keep_non_members: bool = False,
    terminal_policy: Mapping[str, Any] | None = None,
    neutralize: Sequence[str] = (),
    time_policy: str | None = None,
) -> pd.DataFrame:
    """Return forward return labels as a ``pd.DataFrame`` without requiring split boundaries.

    Entry is the open of the session after the signal, exit the close ``H`` sessions
    later; total return when the version has ``daily_returns``, else vendor-adjusted.
    One ``int`` horizon gives the standard label columns; several prefix each horizon's
    columns with ``h{H}_``. Every horizon adds ``forward_excess_return_{H}d`` and
    ``trainable_{H}d``. Symbols build candidates (sampling, membership); a candidate
    DataFrame keeps its rows and gets ``in_universe`` under ``universe`` (candidates
    whose ``attrs["parameters"]`` name another rule are refused; a live row gets NA,
    use ``panel`` for live rows). A version without membership rows
    needs ``allow_static_universe=True``. ``neutralize`` names groups ("size", a sample
    column or a universe field) for ``excess_return_{H}d_{group}``. Masks count rows
    outside the universe, including those dropped when candidates are built here
    (their counts are in ``attrs["counts"]``).
    """
    horizon_list, single = _labels.horizons(horizons)
    policy = _labels.terminal_policy(terminal_policy)
    rule = _candidates.membership_rule(_membership_present(version), universe)
    universe_basis = _candidates.require_pit(rule, allow_static_universe)
    benchmark_id = str(version.resolve(benchmark)[0])
    if isinstance(candidates_or_symbols, pd.DataFrame):
        origin = candidates_or_symbols.attrs.get("parameters")
        if (
            isinstance(origin, Mapping)
            and "universe_rule" in origin
            and origin["universe_rule"] != rule
        ):
            raise ValueError(
                f"The candidates use universe {origin['universe_rule'] or 'static'} "
                f"but forward_returns resolves {rule or 'static'}; pass the "
                "candidates' universe"
            )
        samples = _candidates.ensure_samples(version, candidates_or_symbols)
    else:
        samples = build_candidates(
            version,
            candidates_or_symbols,
            start=start,
            end=end,
            sampling=sampling,
            universe=universe,
            keep_non_members=keep_non_members,
            benchmark=benchmark,
        )
    cal = _candidates.calendar(version, version.calendar)
    signal = cal.positions(samples["signal_session"])
    asset_ids = list(dict.fromkeys(samples["asset_id"].astype(str)))
    n = len(cal)
    first = cal.days[min(int(signal.min()) + 1, n - 1)] if len(signal) else None
    last = (
        cal.days[min(int(signal.max()) + max(horizon_list), n - 1)]
        if len(signal)
        else None
    )
    labels = _label_rows(
        samples,
        _return_inputs(version, [*asset_ids, benchmark_id], first, last),
        cal,
        horizon_list=horizon_list,
        single=single,
        benchmark_id=benchmark_id,
        cutoff=_day(version.manifest["cutoff_date"]),
        policy=policy,
        membership=_candidates.read_membership(version, asset_ids) if rule else None,
        rule=rule,
        months=_candidates.membership_months(version),
    )
    universe_rows = {
        str(row["asset_id"]): row for row in _candidates.records(version.universe)
    }
    industry_names = {"ff12", "sic_division", "sic_major_group", "sic"}
    families = version.manifest.get("data_families") or {}
    has_profiles = isinstance(families, Mapping) and "issuer_profiles" in families
    has_uni_sector = any(
        universe_rows.get(str(a), {}).get("sector") is not None
        for a in samples["asset_id"]
    )
    has_uni_sic = any(
        universe_rows.get(str(a), {}).get("sic") is not None
        for a in samples["asset_id"]
    )
    group_samples = samples
    used_industry = any(name in industry_names for name in neutralize)
    sector_via_industry = (
        "sector" in neutralize
        and "sector" not in samples
        and (has_profiles or (not has_uni_sector and has_uni_sic))
    )
    need_industry = sector_via_industry or any(
        name in industry_names and name not in samples for name in neutralize
    )
    if neutralize and need_industry:
        ind_policy = (
            _policy(time_policy)
            if time_policy is not None
            else (
                "observed_content"
                if "decision_at" in samples.columns
                else "public_reconstructed"
            )
        )
        ind_df = _industry.industry(version, samples, time_policy=ind_policy)
        group_samples = samples.copy()
        for col in ("ff12", "sic_division", "sic_major_group", "sic"):
            if col not in group_samples.columns and col in ind_df.columns:
                group_samples[col] = ind_df[col].to_numpy()
        if sector_via_industry:
            group_samples["sector"] = ind_df["ff12"].to_numpy()
        used_industry = True

    groups_from_universe = [
        name
        for name in dict.fromkeys(neutralize)
        if name != "size" and name not in group_samples
    ]
    if neutralize:
        benchmarks = {benchmark_id}.union(
            asset for asset, row in universe_rows.items() if _candidates.flagged(row)
        )
        eligible = ~samples["asset_id"].astype(str).isin(benchmarks).to_numpy(bool)
        groups = {
            name: _labels.neutral_groups(group_samples, name, universe_rows)
            for name in dict.fromkeys(neutralize)
        }
        labels = _labels.neutralize(labels, groups, horizon_list, eligible)
    # Candidates built here: rows outside the universe were dropped before labelling.
    built = not isinstance(candidates_or_symbols, pd.DataFrame)
    counts = dict(samples.attrs.get("counts", {})) if built else {}
    dropped = counts.get("not_in_universe_dropped", 0)
    masks = _labels.mask_counts(labels, horizon_list, single, rule is None, dropped)
    return_basis = labels.attrs["return_basis"]
    labels.attrs["parameters"] = {
        "benchmark_id": benchmark_id,
        "horizons": horizon_list,
        "sampling": sampling,
        "universe_basis": universe_basis,
        "universe_rule": rule,
        "terminal_policy": policy,
        "return_basis": return_basis,
        "neutralize": list(dict.fromkeys(neutralize)),
    }
    if single:
        labels.attrs["parameters"]["horizon"] = horizon_list[0]
    labels.attrs["masks"] = masks
    if counts:
        labels.attrs["counts"] = counts
    lims = _labels.limitations(universe_basis, return_basis, groups_from_universe)
    if used_industry and _industry.SIC_LIMITATION not in lims:
        lims.append(_industry.SIC_LIMITATION)
    labels.attrs["limitations"] = lims
    return labels


def panel(
    version: Any,
    symbols: str | Sequence[str] | None = None,
    *,
    time_policy: str,
    start: str | date | None = None,
    end: str | date | None = None,
    benchmark: str = "SPY",
    horizons: int | Iterable[int] = DEFAULT_HORIZONS,
    sampling: str = "daily",
    universe: str = "pit",
    allow_static_universe: bool = False,
    keep_non_members: bool = False,
    terminal_policy: Mapping[str, Any] | None = None,
    neutralize: Sequence[str] = (),
    next_session: str | date | None = None,
    fundamental_time_policy: str | None = None,
    fundamentals: str = "derived",
    include_fundamentals: bool = True,
    include_ratios: bool = True,
    include_sec_events: bool = True,
    include_earnings: bool = True,
    include_extra: bool | Sequence[str] = True,
    include_release: bool | str = False,
    provenance_columns: bool = False,
    output_dir: str | Path | None = None,
) -> pd.DataFrame:
    """Build a unified PIT research ``pd.DataFrame`` combining daily features, fundamentals, ratios, and forward returns.

    Candidates are built once (sampling, point-in-time membership, default securities
    without benchmarks); features are computed on the daily grid and kept for those
    rows. A version without membership rows needs ``allow_static_universe=True``.
    ``fundamentals="derived"`` (default) computes derived single quarters, trailing
    twelve months, YoY changes, and fundamental factors; ``fundamentals="legacy"``
    retains the v1 per-period selection engine; ``fundamentals="none"`` omits all
    fundamental and ratio blocks.
    """
    if fundamentals not in ("derived", "legacy", "none"):
        raise ValueError(
            f"fundamentals must be 'derived', 'legacy', or 'none', got {fundamentals!r}"
        )
    if isinstance(include_extra, bool):
        extra_groups = list(DEFAULT_EXTRA_GROUPS) if include_extra else []
    elif isinstance(include_extra, Sequence) and not isinstance(
        include_extra, (str, bytes)
    ):
        extra_groups = list(dict.fromkeys(include_extra))
        unknown_extra = [g for g in extra_groups if g not in EXTRA_GROUPS]
        if unknown_extra:
            raise ValueError(
                f"Unknown extra feature group(s) {unknown_extra}; valid groups are {EXTRA_GROUPS}"
            )
    else:
        raise TypeError(
            "include_extra must be a bool or a sequence of extra feature group names"
        )
    if not isinstance(include_release, (bool, str)):
        raise TypeError("include_release must be a bool or an extractor_version string")
    if isinstance(include_release, str) and not include_release.strip():
        raise ValueError("include_release string must be a non-empty extractor_version")
    _policy(time_policy)
    fund_policy = _policy(fundamental_time_policy or time_policy)
    horizon_list, _ = _labels.horizons(horizons)
    rule = _candidates.membership_rule(_membership_present(version), universe)
    _candidates.require_pit(rule, allow_static_universe)
    candidates = build_candidates(
        version,
        symbols,
        start=start,
        end=end,
        sampling=sampling,
        universe=universe,
        keep_non_members=keep_non_members,
        benchmark=benchmark,
        next_session=next_session,
    )
    if candidates.empty:
        raise ValueError("No candidate rows: no selected security is a member then")
    daily, event_summary, _ = _read_feature_rows(
        version,
        list(dict.fromkeys(candidates["asset_id"])),
        start=candidates["signal_session"].min(),
        end=candidates["signal_session"].max(),
        time_policy=time_policy,
        benchmark=benchmark,
        next_session=next_session,
        output_days=(
            None
            if sampling == "daily"
            else sorted(candidates["signal_session"].unique())
        ),
    )
    rows = candidates.merge(
        daily.drop(columns=["previous_decision_at", "decision_at"]),
        on=KEYS,
        how="left",
        validate="one_to_one",
    )
    source_coverage = (
        _coverage_summary(daily, event_summary["coverage_columns"])
        if sampling == "daily"
        else event_summary["source_coverage"]
    )
    del daily
    parts: list[pd.DataFrame] = [rows]
    samples = rows[KEYS + ["decision_at"]]
    sec_cov_cols = ["sec_coverage"] if "sec_coverage" in rows.columns else []
    sec_samples = rows[KEYS + ["decision_at", *sec_cov_cols]]
    families = _candidates.families(version)
    cal_full = _candidates.calendar(
        version, version.calendar, next_session=next_session
    )
    selected_assets = list(dict.fromkeys(candidates["asset_id"].astype(str)))
    derived_limitations: list[str] = []
    label_columns = [*KEYS, "decision_at", *neutralize]
    if "size" in neutralize:
        label_columns.extend(
            ("market_cap", "dollar_volume_21d_log", "raw_dollar_volume")
        )
    label_rows_input = rows[
        [c for c in dict.fromkeys(label_columns) if c in rows]
    ].copy()

    if (
        include_sec_events
        and "event_observations" in families
        and isinstance(version.manifest.get("sec_event_kinds"), Mapping)
        and version.manifest.get("sec_event_kinds")
    ):
        sec_specs = _sec_events.sec_event_specs(version)
        sec_kinds = [kind for spec in sec_specs for kind in spec.kinds_any]
        if sec_kinds:
            typed = _sec_events.typed_event_features(
                _observations(version, sec_specs),
                sec_samples,
                kinds=sec_kinds,
                calendar=cal_full,
                time_policy=time_policy,
                zones=version.manifest.get("source_timezones", {}),
                vocabulary=version.manifest.get("sec_event_kinds"),
            )
            parts.append(typed.drop(columns=KEYS))
            del typed

    ann_df: pd.DataFrame | None = None
    primary_periods: Any = None
    if include_earnings and "earnings_announcements" in families:
        ann_df = version.family("earnings_announcements", selected_assets)
        bench_id = str(version.resolve(benchmark)[0]) if benchmark is not None else None
        price_ids = list(
            dict.fromkeys([*selected_assets, *([bench_id] if bench_id else [])])
        )
        dr_df = (
            version.family("daily_returns", price_ids)
            if "daily_returns" in families
            else None
        )
        adj_df = _price_frame(version.prices(price_ids, adjusted=True))
        ev_obs_cal = (
            _observations(version)
            if "earnings_observations" in families and "event_observations" in families
            else None
        )
        earn_obs_cal = (
            version.family("earnings_observations", selected_assets)
            if "earnings_observations" in families
            else None
        )
        earn_df = _sec_events.earnings_features(
            ann_df,
            sec_samples,
            calendar=cal_full,
            adjusted=adj_df,
            benchmark_id=bench_id,
            daily_returns=dr_df,
            time_policy=time_policy,
            event_observations=ev_obs_cal,
            earnings_observations=earn_obs_cal,
            horizons=horizon_list,
        )
        primary_periods = earn_df.attrs.get("primary_period_end")
        parts.append(earn_df.drop(columns=KEYS))
        del earn_df, dr_df, adj_df, ev_obs_cal, earn_obs_cal

    extra_fund_cols: dict[str, Any] = {}
    if fundamentals == "derived" and (include_fundamentals or include_ratios):
        derived = _fundamentals_derived.derived_fundamentals(
            version,
            samples,
            time_policy=fund_policy,
            provenance=provenance_columns,
        )
        if "shares_outstanding_i_value" in derived.columns:
            extra_fund_cols["shares_outstanding_value"] = derived[
                "shares_outstanding_i_value"
            ].to_numpy()
            if "shares_outstanding_i_status" in derived.columns:
                extra_fund_cols["shares_outstanding_status"] = derived[
                    "shares_outstanding_i_status"
                ]
        manifest_lims = set(version.manifest.get("limitations", []))
        derived_limitations = [
            item
            for item in derived.attrs.get("limitations", [])
            if item not in manifest_lims
        ]
        ind: pd.DataFrame | None = None
        val: pd.DataFrame | None = None
        derived_part = len(parts)
        if include_fundamentals:
            ind = _industry.industry(version, samples, time_policy=fund_policy)
            parts.append(ind.drop(columns=KEYS))
            if (
                _industry.SIC_LIMITATION not in manifest_lims
                and _industry.SIC_LIMITATION not in derived_limitations
            ):
                derived_limitations.append(_industry.SIC_LIMITATION)
        if include_ratios:
            factors = _fundamentals_derived.fundamental_factors(derived)
            parts.append(factors.drop(columns=KEYS))
            del factors
            val = _valuation.valuation(
                version,
                samples,
                derived,
                time_policy=fund_policy,
                provenance=provenance_columns,
            )
            parts.append(val.drop(columns=KEYS))
            if "market_cap_issuer_value" in val.columns:
                extra_fund_cols["market_cap_issuer_value"] = val[
                    "market_cap_issuer_value"
                ].to_numpy()
                if "market_cap_issuer_status" in val.columns:
                    extra_fund_cols["market_cap_issuer_status"] = val[
                        "market_cap_issuer_status"
                    ]
            if (
                _valuation.VALUATION_LIMITATION not in manifest_lims
                and _valuation.VALUATION_LIMITATION not in derived_limitations
            ):
                derived_limitations.append(_valuation.VALUATION_LIMITATION)
        if include_fundamentals:
            # The sampled statement block can be copied after valuation has used it.
            parts.insert(derived_part, derived.drop(columns=KEYS))
        if (
            val is not None
            and "market_cap_issuer_value" in val.columns
            and ("size" in neutralize or "market_cap_issuer_value" in neutralize)
        ):
            label_rows_input["market_cap_issuer_value"] = val[
                "market_cap_issuer_value"
            ].to_numpy()
        if ind is not None:
            for col in ("ff12", "sic_division", "sic_major_group", "sic"):
                if col in neutralize and col in ind.columns:
                    label_rows_input[col] = ind[col].to_numpy()
        del derived, ind, val
        if include_earnings and include_fundamentals and "fundamentals" in families:
            ciks_series = _fundamentals_derived.cik_at(
                version,
                samples["asset_id"].astype(str).tolist(),
                samples["signal_session"].tolist(),
            )
            unique_ciks = [
                c for c in dict.fromkeys(ciks_series.dropna().astype(str).tolist()) if c
            ]
            q_ledger = (
                _fundamentals_derived.fiscal_quarters(
                    version,
                    time_policy=fund_policy,
                    concepts=("eps_diluted", "eps_basic", "revenue"),
                    ciks=unique_ciks,
                )
                if unique_ciks
                else pd.DataFrame()
            )
            raw_prices = _price_frame(version.prices(selected_assets, adjusted=False))
            sue_df = _sec_events.sue_features(
                q_ledger,
                sec_samples,
                raw=raw_prices,
                asset_ciks=ciks_series,
                primary_period_end=primary_periods,
            )
            parts.append(sue_df.drop(columns=KEYS))
            del sue_df, raw_prices, q_ledger
    elif fundamentals == "legacy" and (include_fundamentals or include_ratios):
        # One read of the facts and one prepared engine serve features and ratios.
        metrics = {
            kind: _fundamentals.default_metrics(kind)
            for kind in ("quarter", "annual", "instant")
        }
        inputs = _fundamentals.FactInputs(
            version,
            samples["asset_id"],
            list(
                dict.fromkeys(
                    [
                        *(name for names in metrics.values() for name in names),
                        *_fundamentals.RATIO_INPUTS,
                    ]
                )
            ),
        )
        if include_fundamentals:
            fund = _fundamentals.features_by_period(
                version,
                samples,
                metrics,
                time_policy=fund_policy,
                provenance=provenance_columns,
                inputs=inputs,
            )
            parts.append(fund.drop(columns=KEYS))
            if "instant_shares_outstanding_value" in fund.columns:
                extra_fund_cols["shares_outstanding_value"] = fund[
                    "instant_shares_outstanding_value"
                ].to_numpy()
                if "instant_shares_outstanding_status" in fund.columns:
                    extra_fund_cols["shares_outstanding_status"] = fund[
                        "instant_shares_outstanding_status"
                    ]
            del fund

        if include_ratios:
            ratios = _fundamentals.ratios_by_period(
                version,
                samples,
                ("quarter", "annual"),
                currency="USD",
                time_policy=fund_policy,
                provenance=provenance_columns,
                inputs=inputs,
            )
            stale = tuple(
                [f"quarter_{name}_" for name in QUARTER_DEFAULT_EXCLUDED_RATIOS]
                + [
                    f"quarter_source_{name}_"
                    for name in QUARTER_DEFAULT_EXCLUDED_METRICS
                ]
            )
            parts.append(
                ratios.drop(
                    columns=KEYS
                    + [column for column in ratios.columns if column.startswith(stale)]
                )
            )
            del ratios

    extra_family_names = (
        "reference_series",
        "reference_checks",
        "short_interest",
        "insider_transactions",
        "borrow_availability",
        "text_changes",
    )
    extra_families_present = [f for f in extra_family_names if f in families]
    extra_coverage_counts: dict[str, dict[str, int]] = {}
    if extra_groups:
        fund_frame = (
            pd.DataFrame(extra_fund_cols, index=rows.index) if extra_fund_cols else None
        )
        extra_cand_cols = [
            c
            for c in (*KEYS, "decision_at", "in_universe", "is_benchmark")
            if c in rows.columns
        ]
        extra_df = _extra_features.extra_features(
            version,
            rows[extra_cand_cols],
            time_policy=time_policy,
            groups=extra_groups,
            fundamentals=fund_frame,
        )
        if not extra_df.columns.empty:
            parts.append(extra_df)
            for cov_col in (
                "ins_coverage",
                "si_coverage",
                "txt_status",
                "brw_observed",
            ):
                if cov_col in extra_df.columns:
                    vc = extra_df[cov_col].value_counts(dropna=False)
                    extra_coverage_counts[cov_col] = {
                        ("null" if pd.isna(k) else str(k)): int(v)
                        for k, v in vc.items()
                        if int(v) > 0
                    }
    extra_provenance = {
        "groups": extra_groups,
        "families_present": extra_families_present,
        "coverage_counts": extra_coverage_counts,
    }

    release_extractor_version: str | None = None
    if include_release is not False:
        rel_fund_frame = (
            pd.DataFrame(extra_fund_cols, index=rows.index) if extra_fund_cols else None
        )
        rel_cand_cols = [c for c in (*KEYS, "decision_at") if c in rows.columns]
        rel_df = _release_features.release_features(
            version,
            rows[rel_cand_cols],
            time_policy=time_policy,
            extractor_version=(
                include_release if isinstance(include_release, str) else None
            ),
            fundamentals=rel_fund_frame,
        )
        release_extractor_version = rel_df.attrs.get("extractor_version")
        if not rel_df.columns.empty:
            parts.append(rel_df)
            if (
                _release_features.RELEASE_LIMITATION not in manifest_lims
                and _release_features.RELEASE_LIMITATION not in derived_limitations
            ):
                derived_limitations.append(_release_features.RELEASE_LIMITATION)

    labels = forward_returns(
        version,
        label_rows_input,
        benchmark=benchmark,
        horizons=horizons,
        sampling=sampling,
        universe=universe,
        allow_static_universe=allow_static_universe,
        keep_non_members=keep_non_members,
        terminal_policy=terminal_policy,
        neutralize=neutralize,
        time_policy=fund_policy,
    )
    del label_rows_input
    # Candidate columns (keys, clocks, membership) win over the label's copies. The
    # labels' calendar has no live session, so non-members are counted from the
    # candidates' membership (it includes the live row's) plus the rows dropped.
    parts.append(labels.drop(columns=[c for c in labels.columns if c in rows]))
    if ann_df is not None:
        lflags = _sec_events.label_announcement_flags(
            ann_df,
            rows[KEYS],
            calendar=cal_full,
            horizons=horizon_list,
        )
        parts.append(lflags.drop(columns=KEYS))
        del lflags
    member = np.asarray(rows["in_universe"].fillna(rule is None), dtype=bool)
    outside = (
        int((~member).sum()) + candidates.attrs["counts"]["not_in_universe_dropped"]
    )
    masks = {
        horizon: {**counts, "not_in_universe": outside}
        for horizon, counts in labels.attrs["masks"].items()
    }
    label_parameters = labels.attrs["parameters"]
    label_overlap = labels.attrs["label_overlap"]
    label_limitations = labels.attrs["limitations"]
    del labels

    combined = pd.concat(parts, axis=1)
    del parts
    provenance = run_record(
        dataset_id=str(version.id),
        manifest_sha256=version.manifest_sha256,
        parameters={
            "symbols": symbols,
            "start": str(candidates["signal_session"].min()),
            "end": str(candidates["signal_session"].max()),
            "benchmark": benchmark,
            "horizons": horizon_list,
            **_time_parameters(time_policy),
            "fundamental_time_policy": fund_policy,
            "fundamentals": fundamentals,
            "derivation_version": (
                _fundamentals_derived.DERIVATION_VERSION
                if fundamentals == "derived"
                else None
            ),
            "include_fundamentals": include_fundamentals,
            "include_ratios": include_ratios,
            "include_sec_events": include_sec_events,
            "include_earnings": include_earnings,
            "include_extra": (
                include_extra if isinstance(include_extra, bool) else extra_groups
            ),
            "include_release": include_release,
            "extractor_version": release_extractor_version,
            "provenance_columns": provenance_columns,
            "next_session": None if next_session is None else str(_day(next_session)),
            "membership_carried_from": candidates.attrs["parameters"][
                "membership_carried_from"
            ],
            "live_membership_unknown": candidates.attrs["parameters"][
                "live_membership_unknown"
            ],
            "keep_non_members": keep_non_members,
            **{
                name: label_parameters[name]
                for name in (
                    "sampling",
                    "universe_basis",
                    "universe_rule",
                    "terminal_policy",
                    "return_basis",
                    "neutralize",
                )
            },
        },
        counts={
            "rows": len(combined),
            "columns": len(combined.columns),
            "in_universe": int(member.sum()),
            **candidates.attrs.get("counts", {}),
        },
        rows=len(combined),
        columns=len(combined.columns),
        masks=masks,
        label_overlap=label_overlap,
        extra=extra_provenance,
        source_coverage=source_coverage,
        **{
            name: event_summary[name]
            for name in (
                "skipped_sources",
                "undatable_events",
                "rank_population",
            )
        },
        limitations=list(
            dict.fromkeys(
                [
                    *LIMITATIONS,
                    *label_limitations,
                    *derived_limitations,
                    *_live_limitations(
                        candidates.attrs["parameters"],
                        candidates.attrs["counts"]["membership_carried"],
                    ),
                    *version.manifest.get("limitations", []),
                ]
            )
        ),
    )
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

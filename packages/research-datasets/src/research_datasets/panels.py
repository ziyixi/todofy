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
from . import fundamentals as _fundamentals
from . import fundamentals_derived as _fundamentals_derived
from . import labels as _labels
from .candidates import build_candidates
from .clocks import CAPTURE_DEADLINE as _CAPTURE_DEADLINE
from .clocks import day as _day
from .clocks import policy as _policy
from .constants import (
    DECISION_TIME,
    DEFAULT_HORIZONS,
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
) -> tuple[pd.DataFrame, dict[str, Any]]:
    """Daily features for contiguous signal sessions and the event reduction summary.

    ``raw`` and ``adjusted`` are normalized price rows. Event counts and coverage are
    computed for the selection and the rank population, over warm-up sessions that feed
    the rolling counts of the first signals.
    """
    sessions = clocks.Calendar(calendar, next_session=next_session)
    first, last = sessions.index(signals[0]), sessions.index(signals[-1])
    start = max(0, first - WARMUP_SESSIONS)
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
        return frame.iloc[first : last + 1].to_numpy().T.ravel()

    count, length = len(asset_ids), last - first + 1
    decisions = sessions.decisions
    frame = pd.DataFrame(
        {
            "asset_id": np.repeat(np.array(asset_ids, dtype=object), length),
            "signal_session": np.tile(
                np.array(calendar[first : last + 1], dtype=object), count
            ),
            "previous_decision_at": clocks.utc(
                np.tile(decisions[first : last + 1], count)
            ),
            "decision_at": clocks.utc(np.tile(decisions[first + 1 : last + 2], count)),
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
    )
    if sampling != "daily":
        features = features[features["signal_session"].isin(set(sampled))]
        features = features.reset_index(drop=True)
    features.attrs["provenance"] = run_record(
        dataset_id=str(version.id),
        manifest_sha256=version.manifest_sha256,
        parameters={
            "asset_ids": asset_ids,
            "start": str(sampled[0]),
            "end": str(sampled[-1]),
            "benchmark_ids": benchmark_ids,
            **_time_parameters(time_policy),
            "event_specs": events["specs"],
            "sampling": sampling,
            "next_session": None if cal.next_session is None else str(cal.next_session),
        },
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
    groups_from_universe = [
        name
        for name in dict.fromkeys(neutralize)
        if name != "size" and name not in samples
    ]
    if neutralize:
        benchmarks = {benchmark_id}.union(
            asset for asset, row in universe_rows.items() if _candidates.flagged(row)
        )
        eligible = ~samples["asset_id"].astype(str).isin(benchmarks).to_numpy(bool)
        groups = {
            name: _labels.neutral_groups(samples, name, universe_rows)
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
    labels.attrs["limitations"] = _labels.limitations(
        universe_basis, return_basis, groups_from_universe
    )
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
    daily = daily_features(
        version,
        list(dict.fromkeys(candidates["asset_id"])),
        start=candidates["signal_session"].min(),
        end=candidates["signal_session"].max(),
        time_policy=time_policy,
        benchmark=benchmark,
        next_session=next_session,
    )
    rows = candidates.merge(
        daily.drop(columns=["previous_decision_at", "decision_at"]),
        on=KEYS,
        how="left",
        validate="one_to_one",
    )
    parts: list[pd.DataFrame] = [rows]
    samples = rows[KEYS + ["decision_at"]]
    derived_limitations: list[str] = []

    if fundamentals == "derived" and (include_fundamentals or include_ratios):
        derived = _fundamentals_derived.derived_fundamentals(
            version,
            samples,
            time_policy=fund_policy,
            provenance=provenance_columns,
        )
        manifest_lims = set(version.manifest.get("limitations", []))
        derived_limitations = [
            item
            for item in derived.attrs.get("limitations", [])
            if item not in manifest_lims
        ]
        if include_fundamentals:
            parts.append(derived.drop(columns=KEYS))
        if include_ratios:
            factors = _fundamentals_derived.fundamental_factors(derived)
            parts.append(factors.drop(columns=KEYS))
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

    labels = forward_returns(
        version,
        rows,
        benchmark=benchmark,
        horizons=horizons,
        sampling=sampling,
        universe=universe,
        allow_static_universe=allow_static_universe,
        keep_non_members=keep_non_members,
        terminal_policy=terminal_policy,
        neutralize=neutralize,
    )
    # Candidate columns (keys, clocks, membership) win over the label's copies. The
    # labels' calendar has no live session, so non-members are counted from the
    # candidates' membership (it includes the live row's) plus the rows dropped.
    parts.append(labels.drop(columns=[c for c in labels.columns if c in rows]))
    member = np.asarray(rows["in_universe"].fillna(rule is None), dtype=bool)
    outside = (
        int((~member).sum()) + candidates.attrs["counts"]["not_in_universe_dropped"]
    )
    masks = {
        horizon: {**counts, "not_in_universe": outside}
        for horizon, counts in labels.attrs["masks"].items()
    }

    combined = pd.concat(parts, axis=1)
    daily_provenance = daily.attrs.get("provenance", {})
    label_parameters = labels.attrs["parameters"]
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
        label_overlap=labels.attrs["label_overlap"],
        **{
            name: daily_provenance.get(name, {})
            for name in (
                "source_coverage",
                "skipped_sources",
                "undatable_events",
                "rank_population",
            )
        },
        limitations=[
            *LIMITATIONS,
            *labels.attrs["limitations"],
            *derived_limitations,
            *_live_limitations(
                candidates.attrs["parameters"],
                candidates.attrs["counts"]["membership_carried"],
            ),
            *version.manifest.get("limitations", []),
        ],
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

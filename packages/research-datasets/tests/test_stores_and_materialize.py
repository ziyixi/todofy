"""Adversarial store, causality, leakage barrier, cache integrity, and local archive tests."""

from __future__ import annotations

import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from datetime import date, datetime, time, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
import yaml

import research_datasets
from research_datasets import (
    DEFAULT_TRAINING_RECIPE_YAML,
    DatasetError,
    audit_features,
    clocks,
    validate_recipe,
)
from research_datasets.stores import (
    build_event_store,
    build_fund_store,
    build_price_store,
)
from tests import test_sdk as fixture

NEW_YORK = ZoneInfo("America/New_York")

ASSET_1 = "11111111-1111-4111-8111-111111111111"
ASSET_SPY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
CIK_1 = "0000100001"


def _nyse_sessions(start: date, count: int) -> list[date]:
    days: list[date] = []
    cur = start
    while len(days) < count:
        holidays = research_datasets.nyse_holidays(cur.year)
        if cur.weekday() < 5 and cur not in holidays:
            days.append(cur)
        cur += timedelta(days=1)
    return days


def _et_iso(day: date, hour: int, minute: int) -> str:
    return (
        pd.Timestamp(datetime.combine(day, time(hour, minute), NEW_YORK))
        .tz_convert("UTC")
        .isoformat()
        .replace("+00:00", "Z")
    )


def _write_local_archive(root: Path, objects: dict[str, bytes]) -> Path:
    for rel_key, payload in objects.items():
        target = root / rel_key.lstrip("/")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(payload)
    return root


def _register_file(
    objects: dict[str, bytes],
    dataset_id: str,
    key: str,
    payload: bytes,
    content_type: str,
) -> dict[str, bytes]:
    import hashlib

    out = dict(objects)
    out[key] = payload
    manifest_key = f"datasets/{dataset_id}/manifest.json"
    manifest = json.loads(out[manifest_key])
    entry = {
        "key": key,
        "sha256": hashlib.sha256(payload).hexdigest(),
        "size_bytes": len(payload),
        "content_type": content_type,
    }
    files = [item for item in manifest.get("files", []) if item.get("key") != key]
    files.append(entry)
    manifest["files"] = files
    if key.endswith("recipe/recipe.yaml"):
        manifest["research_recipe"] = {"config_yaml": entry}
    out[manifest_key] = json.dumps(manifest).encode("utf-8")
    return out


class _SyntheticVersion:
    """In-memory Version double supporting store builders and materialize()."""

    def __init__(
        self,
        *,
        calendar: list[date],
        universe: list[dict[str, Any]],
        families: dict[str, pd.DataFrame],
        prices_adj: pd.DataFrame,
        prices_raw: pd.DataFrame,
        manifest_extra: dict[str, Any] | None = None,
    ) -> None:
        self.id = "99999999-9999-4999-8999-999999999999"
        self.manifest_sha256 = "b" * 64
        self._calendar = [d.isoformat() for d in calendar]
        self._universe = universe
        self._families = families
        self._prices_adj = prices_adj
        self._prices_raw = prices_raw
        data_families = {
            name: {"schema_version": 1, "rows": len(df)}
            for name, df in families.items()
        }
        self.manifest: dict[str, Any] = {
            "dataset_id": self.id,
            "schema_version": 3,
            "cutoff_date": self._calendar[-1],
            "calendar": list(self._calendar),
            "universe": list(universe),
            "data_families": data_families,
            "limitations": [],
            **(manifest_extra or {}),
        }

    @property
    def calendar(self) -> list[str]:
        return list(self._calendar)

    @property
    def universe(self) -> pd.DataFrame:
        return pd.DataFrame(self._universe)

    def resolve(self, symbols: Any = None) -> list[str]:
        if symbols is None or symbols == "all":
            return [str(u["asset_id"]) for u in self._universe]
        known = {str(u["asset_id"]) for u in self._universe}
        items = [symbols] if isinstance(symbols, str) else list(symbols)
        out: list[str] = []
        for item in items:
            if item in known:
                out.append(str(item))
                continue
            matches = [
                u
                for u in self._universe
                if str(u.get("symbol", "")).upper() == str(item).upper()
            ]
            if not matches:
                raise DatasetError("SYMBOL_NOT_FOUND", f"Missing {item}")
            out.append(str(matches[0]["asset_id"]))
        return out

    def prices(
        self, symbols: Any = None, *, adjusted: bool = True, **_: Any
    ) -> pd.DataFrame:
        df = self._prices_adj if adjusted else self._prices_raw
        if df.empty or symbols is None or symbols == "all":
            return df.copy()
        ids = set(self.resolve(symbols))
        return df[df["asset_id"].astype(str).isin(ids)].reset_index(drop=True)

    def family(
        self,
        name: str,
        symbols: Any = None,
        start: Any = None,
        end: Any = None,
        *,
        columns: Any = None,
    ) -> pd.DataFrame:
        del start, end
        if name not in self._families:
            raise DatasetError("CAPABILITY_MISSING", f"Missing {name}")
        df = self._families[name].copy()
        spec = research_datasets.FAMILY_SPECS[name]
        if symbols is not None and symbols != "all" and not df.empty:
            if spec.identity == "asset_id" and "asset_id" in df.columns:
                ids = set(self.resolve(symbols))
                df = df[df["asset_id"].astype(str).isin(ids)]
            elif spec.identity == "cik":
                ids = set(self.resolve(symbols))
                ciks = {
                    str(u.get("cik", "")).zfill(10)
                    for u in self._universe
                    if str(u["asset_id"]) in ids and u.get("cik")
                }
                cik_col = "issuer_cik" if "issuer_cik" in df.columns else "cik"
                if cik_col in df.columns and ciks:
                    df = df[df[cik_col].astype(str).str.zfill(10).isin(ciks)]
        if columns is not None and not df.empty:
            keep = [c for c in columns if c in df.columns]
            df = df[keep].copy()
        return df.reset_index(drop=True)

    def event_observations(self, *, columns: Any = None, **_: Any) -> pd.DataFrame:
        return self.family("event_observations", columns=columns)

    def source_checks(self, symbols: Any = None, **_: Any) -> pd.DataFrame:
        return self.family("source_checks", symbols=symbols)

    def fundamentals(
        self, symbols: Any = None, *, columns: Any = None, **_: Any
    ) -> pd.DataFrame:
        return self.family("fundamentals", symbols=symbols, columns=columns)


def _minimal_recipe(
    *,
    sampling: str = "daily",
    time_policy: str = "public_reconstructed",
    groups: dict[str, dict[str, Any]],
) -> str:
    payload = {
        "schema_version": 1,
        "name": "test-recipe",
        "sampling": sampling,
        "time_policy": time_policy,
        "horizons_trading_days": [5],
        "purge_days": 1,
        "embargo_days": 1,
        "exclude_columns": [],
        "feature_groups": groups,
    }
    return yaml.safe_dump(payload, sort_keys=False)


class StoresAndMaterializeAdversarialTest(unittest.TestCase):
    def test_event_reaction_causality_and_date_only_conservative_clock(self) -> None:
        sessions = _nyse_sessions(date(2025, 1, 6), 30)
        cal = clocks.Calendar(sessions)
        universe = [
            {
                "asset_id": ASSET_1,
                "symbol": "SYN1",
                "cik": CIK_1,
                "listed_from": sessions[0].isoformat(),
                "listed_to": None,
                "status": "active",
                "is_benchmark": False,
            },
            {
                "asset_id": ASSET_SPY,
                "symbol": "SPY",
                "cik": None,
                "listed_from": sessions[0].isoformat(),
                "listed_to": None,
                "status": "active",
                "is_benchmark": True,
            },
        ]
        price_rows = []
        dr_rows = []
        for aid in (ASSET_1, ASSET_SPY):
            lvl = 100.0
            for idx, d in enumerate(sessions):
                lvl = 100.0 + idx * (1.5 if aid == ASSET_1 else 0.5)
                price_rows.append(
                    {
                        "asset_id": aid,
                        "date": d.isoformat(),
                        "open": lvl - 0.2,
                        "high": lvl + 0.3,
                        "low": lvl - 0.4,
                        "close": lvl,
                        "volume": 1000.0 + idx,
                        "vwap": lvl,
                        "trade_count": 50,
                    }
                )
                dr_rows.append(
                    {
                        "asset_id": aid,
                        "date": d.isoformat(),
                        "row_kind": "session",
                        "tr_index": lvl / 100.0,
                        "daily_return": np.nan
                        if idx == 0
                        else (lvl / (lvl - (1.5 if aid == ASSET_1 else 0.5)) - 1.0),
                    }
                )
        prices_df = pd.DataFrame(price_rows)
        dr_df = pd.DataFrame(dr_rows)

        day_t = sessions[10]
        pre_iso = _et_iso(day_t, 8, 30)
        post_iso = _et_iso(day_t, 16, 15)
        late_rec_iso = _et_iso(sessions[11], 12, 0)

        events_df = pd.DataFrame(
            [
                {
                    "source": "sec",
                    "event_uid": "sec-premarket",
                    "event_id": "sec-premarket",
                    "observation_sequence": 1,
                    "form": "8-K",
                    "items": ["2.02"],
                    "filing_date": day_t.isoformat(),
                    "event_date": day_t.isoformat(),
                    "asset_ids": [ASSET_1],
                    "asset_first_seen_at": {ASSET_1: pre_iso},
                    "content_first_seen_at": pre_iso,
                    "observation_recorded_at": pre_iso,
                    "public_time_precision": "second",
                    "public_at": pre_iso,
                    "public_date": day_t.isoformat(),
                    "public_time_basis": "sec_acceptance",
                    "story_key": "",
                },
                {
                    "source": "alpaca_news",
                    "event_uid": "news-postmarket",
                    "event_id": "news-postmarket",
                    "observation_sequence": 1,
                    "form": None,
                    "items": [],
                    "filing_date": None,
                    "event_date": day_t.isoformat(),
                    "asset_ids": [ASSET_1],
                    "asset_first_seen_at": {ASSET_1: post_iso},
                    "content_first_seen_at": post_iso,
                    "observation_recorded_at": post_iso,
                    "public_time_precision": "second",
                    "public_at": post_iso,
                    "public_date": day_t.isoformat(),
                    "public_time_basis": "provider_timestamp",
                    "story_key": "s1",
                },
                {
                    "source": "sec",
                    "event_uid": "sec-date-only-late",
                    "event_id": "sec-date-only-late",
                    "observation_sequence": 1,
                    "form": "10-Q",
                    "items": [],
                    "filing_date": day_t.isoformat(),
                    "event_date": day_t.isoformat(),
                    "asset_ids": [ASSET_1],
                    "asset_first_seen_at": {ASSET_1: late_rec_iso},
                    "content_first_seen_at": late_rec_iso,
                    "observation_recorded_at": late_rec_iso,
                    "public_time_precision": "date_only",
                    "public_at": None,
                    "public_date": day_t.isoformat(),
                    "public_time_basis": "sec_date_only",
                    "story_key": "",
                },
            ]
        )
        checks_df = pd.DataFrame(
            [
                {
                    "source": src,
                    "asset_id": ASSET_1,
                    "checked_start": sessions[0].isoformat(),
                    "checked_end": sessions[-1].isoformat(),
                    "checked_at": _et_iso(sessions[-1], 20, 0),
                    "status": "ok",
                    "error_code": "",
                    "count": 1,
                }
                for src in ("sec", "alpaca_news")
            ]
        )

        ver = _SyntheticVersion(
            calendar=sessions,
            universe=universe,
            families={
                "daily_returns": dr_df,
                "event_observations": events_df,
                "source_checks": checks_df,
            },
            prices_adj=prices_df,
            prices_raw=prices_df,
            manifest_extra={
                "source_timezones": {
                    "sec": "America/New_York",
                    "alpaca_news": "America/New_York",
                }
            },
        )

        pstore = build_price_store(
            ver, [ASSET_1, ASSET_SPY], cal.days, benchmark_id=ASSET_SPY
        )
        estore_re = build_event_store(
            ver,
            pstore.assets,
            time_policy="public_reconstructed",
            cal=cal,
            price_store=pstore,
        )
        estore_cons = build_event_store(
            ver,
            pstore.assets,
            time_policy="observed_content",
            cal=cal,
            price_store=pstore,
        )

        # At t+1 06:00 ET decision: pre-market 08:30 ET and post-market 16:15 ET are BOTH visible,
        # yet NEITHER 1d nor 3d post-event reaction is complete yet!
        dec_t1 = int(cal.decisions[11])
        sl_t1 = estore_re.slice_asset_events(0, dec_t1)
        self.assertGreaterEqual(len(sl_t1["public_at_ns"]), 2)
        self.assertFalse(bool(sl_t1["reaction_1d_ready"].any()))
        self.assertFalse(bool(sl_t1["reaction_3d_ready"].any()))
        self.assertTrue(np.isnan(sl_t1["post_1d_ret"]).all())
        self.assertTrue(np.isnan(sl_t1["post_3d_ret"]).all())

        # Conservative clock hides the date-only event captured at t+1 12:00 ET at t+1 06:00 ET!
        sl_cons_t1 = estore_cons.slice_asset_events(0, dec_t1)
        self.assertEqual(
            len(sl_cons_t1["public_at_ns"]), 2
        )  # excludes late-captured date_only event
        self.assertFalse(bool(sl_cons_t1["reaction_1d_ready"].any()))
        self.assertFalse(bool(sl_cons_t1["reaction_3d_ready"].any()))

        # At t+2 06:00 ET: pre-market 08:30 ET 1d reaction is now ready; post-market 16:15 ET 1d
        # requires t+2 16:00 ET close -> still False! Neither has 3d ready yet.
        dec_t2 = int(cal.decisions[12])
        sl_t2 = estore_re.slice_asset_events(0, dec_t2)
        self.assertEqual(sl_t2["reaction_1d_ready"][:2].tolist(), [True, False])
        self.assertTrue(np.isfinite(sl_t2["post_1d_ret"][0]))
        self.assertTrue(np.isnan(sl_t2["post_1d_ret"][1]))
        self.assertFalse(bool(sl_t2["reaction_3d_ready"].any()))

        # At t+5 06:00 ET: both pre-market and post-market 3d reactions are ready.
        dec_t5 = int(cal.decisions[15])
        sl_t5 = estore_re.slice_asset_events(0, dec_t5)
        self.assertTrue(bool(sl_t5["reaction_1d_ready"][:2].all()))
        self.assertTrue(bool(sl_t5["reaction_3d_ready"][:2].all()))
        self.assertTrue(np.isfinite(sl_t5["post_3d_ret"][:2]).all())

        # Also verify materialize() masks ev_last_post_1d_ret / ev_last_post_3d_ret at signal_session == day_t
        with tempfile.TemporaryDirectory() as tmp:
            recipe = _minimal_recipe(
                sampling="daily",
                groups={"earnings_pead_sue": {"enabled": True}},
            )
            res = research_datasets.materialize(
                ver,
                recipe_yaml=recipe,
                cache_dir=tmp,
                benchmark="SPY",
                include_labels=False,
            )
            row_t = res.anchors.frame[
                (res.anchors.frame["asset_id"] == ASSET_1)
                & (res.anchors.frame["signal_session"] == day_t)
            ]
            self.assertEqual(len(row_t), 1)
            ridx = int(row_t.index[0])
            self.assertTrue(np.isnan(res.X.loc[ridx, "ev_last_post_1d_ret"]))
            self.assertTrue(np.isnan(res.X.loc[ridx, "ev_last_post_3d_ret"]))

            # Regression guard: weekly sampling with late-starting source coverage
            # must pass daily cal.days[first:last+1] to event_features().
            late_checks = checks_df.copy()
            late_checks.loc[late_checks["source"] == "alpaca_news", "checked_start"] = (
                sessions[22].isoformat()
            )
            late_ver = _SyntheticVersion(
                calendar=sessions,
                universe=universe,
                families={
                    "daily_returns": dr_df,
                    "event_observations": events_df,
                    "source_checks": late_checks,
                },
                prices_adj=prices_df,
                prices_raw=prices_df,
                manifest_extra={
                    "source_timezones": {
                        "sec": "America/New_York",
                        "alpaca_news": "America/New_York",
                    }
                },
            )
            weekly_ev_recipe = _minimal_recipe(
                sampling="weekly",
                groups={
                    "sec_typed_events": {"enabled": True},
                    "news_intensity": {"enabled": True},
                },
            )
            weekly_res = research_datasets.materialize(
                late_ver,
                recipe_yaml=weekly_ev_recipe,
                cache_dir=Path(tmp) / "weekly_late",
                benchmark="SPY",
                include_labels=False,
            )
            self.assertIn("news_21d_rank", weekly_res.X.columns)
            self.assertIn("sec_events_21d", weekly_res.X.columns)

    def test_fund_store_restatement_immutability_and_untruncated_history(self) -> None:
        # 270 trading sessions (> 252!) and 16 quarters (> 12!) + a later 10-K/A restatement
        sessions = _nyse_sessions(date(2024, 1, 2), 270)
        cal = clocks.Calendar(sessions)
        universe = [
            {
                "asset_id": ASSET_1,
                "symbol": "SYN1",
                "cik": CIK_1,
                "listed_from": sessions[0].isoformat(),
                "listed_to": None,
                "status": "active",
                "is_benchmark": False,
            },
            {
                "asset_id": ASSET_SPY,
                "symbol": "SPY",
                "cik": None,
                "listed_from": sessions[0].isoformat(),
                "listed_to": None,
                "status": "active",
                "is_benchmark": True,
            },
        ]
        price_rows = []
        dr_rows = []
        for aid in (ASSET_1, ASSET_SPY):
            for idx, d in enumerate(sessions):
                px = 50.0 + 0.1 * idx
                price_rows.append(
                    {
                        "asset_id": aid,
                        "date": d.isoformat(),
                        "open": px,
                        "high": px + 0.5,
                        "low": px - 0.5,
                        "close": px,
                        "volume": 5000.0,
                        "vwap": px,
                        "trade_count": 100,
                    }
                )
                dr_rows.append(
                    {
                        "asset_id": aid,
                        "date": d.isoformat(),
                        "row_kind": "session",
                        "tr_index": px / 50.0,
                        "daily_return": np.nan if idx == 0 else (px / (px - 0.1) - 1.0),
                    }
                )

        # Build 16 sequential quarterly filings visible well before sessions[200]
        fact_rows: list[dict[str, Any]] = []
        q_ends = [date(2020, 3, 31) + timedelta(days=91 * q) for q in range(16)]
        for q_idx, pe in enumerate(q_ends):
            ps = pe - timedelta(days=89)
            pub_day = sessions[min(10 + q_idx * 10, 170)]
            pub_iso = _et_iso(pub_day, 9, 0)
            rev_val = 1000.0 + q_idx * 10.0
            fact_rows.append(
                {
                    "fact_id": f"fact-rev-{q_idx}",
                    "cik": CIK_1,
                    "metric": "Revenues",
                    "source": "sec",
                    "taxonomy": "us-gaap",
                    "tag": "Revenues",
                    "tag_priority": 1,
                    "unit": "USD",
                    "currency": "USD",
                    "period_start": ps.isoformat(),
                    "period_end": pe.isoformat(),
                    "period_kind": "duration",
                    "form": "10-Q",
                    "accession": f"0001-{q_idx:04d}",
                    "filed": pub_day.isoformat(),
                    "public_at": pub_iso,
                    "public_date": pub_day.isoformat(),
                    "public_time_precision": "second",
                    "value": f"{rev_val:.2f}",
                    "observed_at": pub_iso,
                    "content_first_seen_at": pub_iso,
                    "observation_sequence": 1,
                    "is_retracted": False,
                }
            )
            # Also add instant Assets so derived/fund snapshots always resolve cleanly
            fact_rows.append(
                {
                    "fact_id": f"fact-assets-{q_idx}",
                    "cik": CIK_1,
                    "metric": "Assets",
                    "source": "sec",
                    "taxonomy": "us-gaap",
                    "tag": "Assets",
                    "tag_priority": 1,
                    "unit": "USD",
                    "currency": "USD",
                    "period_start": None,
                    "period_end": pe.isoformat(),
                    "period_kind": "instant",
                    "form": "10-Q",
                    "accession": f"0001-{q_idx:04d}",
                    "filed": pub_day.isoformat(),
                    "public_at": pub_iso,
                    "public_date": pub_day.isoformat(),
                    "public_time_precision": "second",
                    "value": "5000.00",
                    "observed_at": pub_iso,
                    "content_first_seen_at": pub_iso,
                    "observation_sequence": 1,
                    "is_retracted": False,
                }
            )

        # Amended 10-K/A restates quarter 15's revenue from 1150.0 -> 2500.0 at sessions[220]!
        orig_day = sessions[160]
        amend_day = sessions[220]
        amend_iso = _et_iso(amend_day, 9, 0)
        pe_15 = q_ends[15]
        ps_15 = pe_15 - timedelta(days=89)
        fact_rows.append(
            {
                "fact_id": "fact-rev-15",
                "cik": CIK_1,
                "metric": "Revenues",
                "source": "sec",
                "taxonomy": "us-gaap",
                "tag": "Revenues",
                "tag_priority": 1,
                "unit": "USD",
                "currency": "USD",
                "period_start": ps_15.isoformat(),
                "period_end": pe_15.isoformat(),
                "period_kind": "duration",
                "form": "10-K/A",
                "accession": "0001-9999",
                "filed": amend_day.isoformat(),
                "public_at": amend_iso,
                "public_date": amend_day.isoformat(),
                "public_time_precision": "second",
                "value": "2500.00",
                "observed_at": amend_iso,
                "content_first_seen_at": amend_iso,
                "observation_sequence": 2,
                "is_retracted": False,
            }
        )

        ver = _SyntheticVersion(
            calendar=sessions,
            universe=universe,
            families={
                "fundamentals": pd.DataFrame(fact_rows),
                "daily_returns": pd.DataFrame(dr_rows),
            },
            prices_adj=pd.DataFrame(price_rows),
            prices_raw=pd.DataFrame(price_rows),
            manifest_extra={"source_timezones": {"sec": "America/New_York"}},
        )
        pstore = build_price_store(
            ver, [ASSET_1, ASSET_SPY], cal.days, benchmark_id=ASSET_SPY
        )
        self.assertGreater(pstore.channel("close_adj").shape[1], 252)
        self.assertEqual(pstore.channel("close_adj").shape[1], 270)

        fstore = build_fund_store(
            ver,
            [CIK_1],
            time_policy="public_reconstructed",
            cal=cal,
            price_store=pstore,
            primary_asset_of_cik={CIK_1: 0},
        )
        # Decision BEFORE amendment (after orig_day, before amend_day): immutable snapshot sees 1150.0
        dec_pre = int(cal.decisions[200])
        snap_pre = fstore.lookup_snap_id(CIK_1, dec_pre)
        # Decision AFTER amendment (after amend_day): newer snapshot sees 2500.0 & all 16 quarters
        dec_post = int(cal.decisions[230])
        snap_post = fstore.lookup_snap_id(CIK_1, dec_post)
        self.assertNotEqual(snap_pre, snap_post)
        q_pre = fstore.slice_snapshot(snap_pre, dec_pre)
        q_post = fstore.slice_snapshot(snap_post, dec_post)
        self.assertEqual(
            len(q_pre["values"]), 16
        )  # > 12 quarters retained untruncated!
        self.assertEqual(len(q_post["values"]), 16)
        self.assertAlmostEqual(float(q_pre["values"][-1, 0]), 1150.0, places=2)
        self.assertAlmostEqual(float(q_post["values"][-1, 0]), 2500.0, places=2)
        # Verify earlier snapshot was NEVER mutated retroactively after build
        self.assertAlmostEqual(
            float(fstore.slice_snapshot(snap_pre, dec_pre)["values"][-1, 0]),
            1150.0,
            places=2,
        )
        self.assertGreater(sessions.index(amend_day), sessions.index(orig_day))

    def test_materialize_rejects_swapped_order_cached_part(self) -> None:
        objects, _ = fixture._build_synthetic_bundle()
        recipe = _minimal_recipe(
            sampling="weekly",
            groups={"price_momentum_reversal": {"enabled": True, "windows": [1, 5]}},
        )
        with tempfile.TemporaryDirectory() as tmp:
            archive_root = _write_local_archive(Path(tmp) / "archive", objects)
            cache_dir = Path(tmp) / "cache"
            ds = research_datasets.load_local(archive_root)
            res = ds.materialize(recipe_yaml=recipe, cache_dir=cache_dir)
            part_path = Path(res.report["part_paths"]["price_momentum_reversal"])
            self.assertTrue(part_path.is_file())

            # Replace cached part with exact same rows/schema but swapped order + bad anchor_order_sha256
            table = pq.read_table(part_path)
            swapped = table.take(list(reversed(range(table.num_rows))))
            meta = dict(swapped.schema.metadata or {})
            meta[b"anchor_order_sha256"] = b"0" * 64
            swapped = swapped.replace_schema_metadata(meta)
            pq.write_table(swapped, part_path)

            with self.assertRaises(DatasetError) as ctx:
                ds.materialize(recipe_yaml=recipe, cache_dir=cache_dir)
            self.assertEqual(ctx.exception.reason, "INTEGRITY")
            self.assertIn("ANCHOR_ORDER_MISMATCH", str(ctx.exception))

    def test_physical_x_barrier_and_validate_recipe_leakage_rejection(self) -> None:
        objects, _ = fixture._build_synthetic_bundle()
        with tempfile.TemporaryDirectory() as tmp:
            archive_root = _write_local_archive(Path(tmp) / "archive", objects)
            cache_dir = Path(tmp) / "cache"
            ds = research_datasets.load_local(archive_root)
            res = ds.materialize(cache_dir=cache_dir, include_labels=True)

            forbidden = {
                "row_id",
                "asset_idx",
                "session_idx",
                "fund_snap_id",
                "event_start_cursor",
                "event_end_cursor",
                "size_usd",
                "turnover",
                "in_universe",
                "rank_size",
            }
            self.assertTrue(set(res.X.columns).isdisjoint(forbidden))
            self.assertTrue(audit_features(list(res.X.columns)).empty)
            self.assertTrue(res.report["audit_passed"])

        bad_tokens = (
            "size_usd",
            "turnover",
            "future_return",
            "reaction_1d_return",
            "row_id",
            "fund_snap_id",
            "price_missing",
        )
        for tok in bad_tokens:
            bad_yaml = (
                "schema_version: 1\n"
                "feature_groups:\n"
                "  price_momentum_reversal:\n"
                "    enabled: true\n"
                f"    extra_token: {tok}\n"
            )
            with self.subTest(token=tok), self.assertRaises(ValueError) as ctx:
                validate_recipe(bad_yaml)
            self.assertIn("RECIPE_FORBIDDEN_LEAKAGE_COLUMN", str(ctx.exception))

    def test_incremental_cache_hit_and_fast_reload(self) -> None:
        objects, _ = fixture._build_synthetic_bundle()
        with tempfile.TemporaryDirectory() as tmp:
            archive_root = _write_local_archive(Path(tmp) / "archive", objects)
            cache_dir = Path(tmp) / "cache"
            ds = research_datasets.load_local(archive_root)

            # 1) Cold build across default recipe
            cold = ds.materialize(cache_dir=cache_dir)
            enabled = [
                g
                for g, cfg in cold.recipe["feature_groups"].items()
                if cfg.get("enabled", True)
            ]
            self.assertEqual(cold.report["recomputed_groups"], enabled)

            # 2) Change one group param (news_intensity) -> only news_intensity recomputes
            parsed = yaml.safe_load(DEFAULT_TRAINING_RECIPE_YAML)
            parsed["feature_groups"]["news_intensity"]["half_lives_days"] = [1.0, 10.0]
            warm_one = ds.materialize(
                recipe_yaml=yaml.safe_dump(parsed, sort_keys=False), cache_dir=cache_dir
            )
            self.assertEqual(warm_one.report["recomputed_groups"], ["news_intensity"])
            self.assertEqual(
                warm_one.report["cached_groups"],
                [g for g in enabled if g != "news_intensity"],
            )
            self.assertIn("news_decay_hl_10d", warm_one.X.columns)
            self.assertLess(warm_one.report["elapsed_seconds"], 3.0)

            # 3) Change exclude_columns only -> 0 recomputed groups & 100% cache hit
            parsed["exclude_columns"] = ["pmom_ret_5d"]
            warm_excl = ds.materialize(
                recipe_yaml=yaml.safe_dump(parsed, sort_keys=False), cache_dir=cache_dir
            )
            self.assertEqual(warm_excl.report["recomputed_groups"], [])
            self.assertEqual(warm_excl.report["cached_groups"], enabled)
            self.assertNotIn("pmom_ret_5d", warm_excl.X.columns)
            self.assertLess(warm_excl.report["elapsed_seconds"], 3.0)

    def test_load_local_and_dataset_recipe_yaml(self) -> None:
        objects, _ = fixture._build_synthetic_bundle()
        all_tbl = pq.read_table(
            io.BytesIO(objects[f"datasets/{fixture.DATASET_ID}/all/part-0000.parquet"])
        ).to_pandas()
        dr_df = (
            all_tbl[["asset_id", "date", "close"]]
            .sort_values(["asset_id", "date"])
            .copy()
        )
        first_mask = dr_df.groupby("asset_id").cumcount() == 0
        dr_df["row_kind"] = np.where(first_mask, "first", "session")
        dr_df["open_raw"] = dr_df["close"] - 0.5
        dr_df["close_raw"] = dr_df["close"]
        dr_df["tr_index"] = dr_df.groupby("asset_id")["close"].transform(
            lambda s: s / float(s.iloc[0])
        )
        dr_df["tr_status"] = np.where(first_mask, "first", "ok")
        dr_df["terminal_basis"] = ""
        dr_df["cash_amount"] = 0.0
        dr_cols = [
            "asset_id",
            "date",
            "row_kind",
            "open_raw",
            "close_raw",
            "tr_index",
            "tr_status",
            "terminal_basis",
            "cash_amount",
        ]
        dr_buf = io.BytesIO()
        pq.write_table(
            pa.Table.from_pandas(dr_df[dr_cols], preserve_index=False),
            dr_buf,
        )
        dr_key = f"datasets/{fixture.DATASET_ID}/daily_returns/part-0000.parquet"
        objects = _register_file(
            objects,
            fixture.DATASET_ID,
            dr_key,
            dr_buf.getvalue(),
            "application/octet-stream",
        )
        m_key = f"datasets/{fixture.DATASET_ID}/manifest.json"
        m_data = json.loads(objects[m_key])
        m_data["data_families"]["daily_returns"] = {
            "schema_version": 1,
            "rows": len(dr_df),
        }
        objects[m_key] = json.dumps(m_data).encode("utf-8")

        custom_recipe = _minimal_recipe(
            sampling="weekly",
            groups={
                "price_momentum_reversal": {"enabled": True, "windows": [1, 5, 21]},
                "macro_regime": {"enabled": True},
            },
        )
        objects = _register_file(
            objects,
            fixture.DATASET_ID,
            f"datasets/{fixture.DATASET_ID}/recipe/recipe.yaml",
            custom_recipe.encode("utf-8"),
            "application/yaml",
        )
        with tempfile.TemporaryDirectory() as tmp:
            archive_root = _write_local_archive(Path(tmp) / "archive", objects)
            ds = research_datasets.load_local(archive_root)
            self.assertEqual(ds.recipe_yaml(), custom_recipe)
            mat = ds.materialize(cache_dir=Path(tmp) / "cache", include_stores=True)
            self.assertIsNotNone(mat.stores)
            self.assertIsNotNone(mat.y)
            self.assertEqual(len(mat.X), len(mat.anchors.frame))
            self.assertEqual(len(mat.y), len(mat.anchors.frame))
            self.assertIn("pmom_ret_21d", mat.X.columns)
            self.assertNotIn("pmom_ret_252d", mat.X.columns)

    def test_fresh_import_populates_feature_groups(self) -> None:
        env = {**os.environ, "PYTHONPATH": os.pathsep.join(sys.path)}
        output = subprocess.check_output(
            [
                sys.executable,
                "-c",
                "import research_datasets as rd; print(len(rd.FEATURE_GROUPS))",
            ],
            env=env,
            text=True,
        ).strip()
        self.assertGreaterEqual(int(output), 15)


if __name__ == "__main__":
    unittest.main()

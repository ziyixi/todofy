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
                if (
                    "issuer_history" in self._families
                    and not self._families["issuer_history"].empty
                ):
                    ih = self._families["issuer_history"]
                    for row in ih.to_dict("records"):
                        if (
                            str(row.get("asset_id") or "") in ids
                            and str(row.get("status") or "") == "verified"
                            and str(row.get("cik") or "").strip().isdigit()
                        ):
                            ciks.add(str(row["cik"]).strip().zfill(10))
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

    def test_range_distance_uses_consistent_total_return_units(self) -> None:
        from types import SimpleNamespace

        from research_datasets.feature_groups import GroupBuildContext
        from research_datasets.groups.price import build_price_range_anchor
        from research_datasets.stores import PRICE_CHANNELS, Anchors, PriceStore, Stores

        sessions = _nyse_sessions(date(2025, 1, 2), 30)
        n_sess = len(sessions)
        # Constant tr_index=2.0 with raw close=100, high=110, low=90, and arbitrary close_adj=50.
        tensor = np.full((1, n_sess, len(PRICE_CHANNELS)), np.nan, dtype=np.float32)
        tensor[0, :, 0] = 100.0
        tensor[0, :, 1] = 110.0
        tensor[0, :, 2] = 90.0
        tensor[0, :, 3] = 100.0
        tensor[0, :, 7] = 50.0  # arbitrary dollar adjusted scale must not leak
        tensor[0, :, 8] = 2.0
        tensor[0, -1, 1] = 100.0
        tensor[0, -1, 2] = 100.0
        tensor[0, -1, 3] = 100.0
        pstore = PriceStore(
            tensor,
            assets=[ASSET_1],
            sessions=sessions,
            benchmark_idx=-1,
        )
        anc_df = pd.DataFrame(
            {
                "row_id": [0],
                "asset_id": [ASSET_1],
                "signal_session": [sessions[-1].isoformat()],
                "entry_session": [sessions[-1].isoformat()],
                "decision_at": [pd.Timestamp(sessions[-1], tz="UTC")],
                "in_universe": [True],
                "is_benchmark": [False],
                "asset_idx": [0],
                "session_idx": [n_sess - 1],
                "fund_snap_id": [-1],
                "event_start_cursor": [0],
                "event_end_cursor": [0],
            }
        )
        anchors = Anchors(
            frame=anc_df,
            order_sha256="test",
            assets=(ASSET_1,),
            sessions=tuple(sessions),
            time_policy="pit_v1",
            sampling="weekly",
        )
        stores = Stores(
            anchors=anchors, prices=pstore, fundamentals=None, events=None, macro=None
        )
        ver = SimpleNamespace(calendar=sessions, manifest={"data_families": {}})
        ctx = GroupBuildContext(
            version=ver,
            stores=stores,
            time_policy="pit_v1",
        )
        out = build_price_range_anchor(ctx, {"windows": [21, 252]})
        self.assertLessEqual(float(out["prange_dist_high_21d"].iloc[0]), 0.0)
        self.assertGreaterEqual(float(out["prange_dist_low_21d"].iloc[0]), 0.0)
        self.assertAlmostEqual(
            float(out["prange_dist_high_21d"].iloc[0]), 1.0 / 1.1 - 1.0, places=5
        )
        self.assertAlmostEqual(
            float(out["prange_dist_low_21d"].iloc[0]), 1.0 / 0.9 - 1.0, places=5
        )

    def test_price_store_never_mixes_units_and_masks_adjustment_suspect(self) -> None:
        from types import SimpleNamespace

        from research_datasets.feature_groups import GroupBuildContext
        from research_datasets.groups.price import (
            build_price_momentum_reversal,
            build_price_range_anchor,
        )
        from research_datasets.stores import Anchors, Stores

        sessions = _nyse_sessions(date(2025, 1, 2), 30)
        asset_mix = ASSET_1
        asset_susp = "22222222-2222-4222-8222-222222222222"
        all_rows = []
        raw_rows = []
        dr_rows = []
        for idx, d in enumerate(sessions):
            ds = d.isoformat()
            # asset_mix: first 2 sessions have dollar close_adj=50 without daily_returns, then tr_index starts at 1.0
            for aid in (asset_mix, asset_susp):
                px = 50.0 if aid == asset_mix else (100.0 if idx < 25 else 50.0)
                all_rows.append(
                    {
                        "asset_id": aid,
                        "date": ds,
                        "open": px,
                        "high": px,
                        "low": px,
                        "close": px,
                        "volume": 1000.0,
                        "adjustment": "all",
                    }
                )
                raw_rows.append(
                    {
                        "asset_id": aid,
                        "date": ds,
                        "open": px,
                        "high": px,
                        "low": px,
                        "close": px,
                        "volume": 1000.0,
                        "adjustment": "raw",
                    }
                )
            if idx >= 2:
                dr_rows.append(
                    {
                        "asset_id": asset_mix,
                        "date": ds,
                        "row_kind": "first" if idx == 2 else "session",
                        "tr_index": 1.0,
                        "split_index": 1.0,
                        "flags": [],
                    }
                )
            dr_rows.append(
                {
                    "asset_id": asset_susp,
                    "date": ds,
                    "row_kind": "first" if idx == 0 else "session",
                    "tr_index": 1.0 if idx < 25 else 0.25,
                    "split_index": 1.0,
                    "flags": ["adjustment_suspect"] if idx == 25 else [],
                }
            )

        ver = _SyntheticVersion(
            calendar=sessions,
            universe=[
                {"asset_id": asset_mix, "symbol": "MIX1", "cik": CIK_1},
                {"asset_id": asset_susp, "symbol": "SUS1", "cik": "0000100002"},
            ],
            families={"daily_returns": pd.DataFrame(dr_rows)},
            prices_adj=pd.DataFrame(all_rows),
            prices_raw=pd.DataFrame(raw_rows),
        )
        pstore = build_price_store(ver, [asset_mix, asset_susp], sessions)
        # No -98% (1.0/50.0 - 1) jump when tr_index begins on session 2!
        self.assertTrue(np.isnan(pstore.channel("ret_1d")[0, 2]))
        # adjustment_suspect blanks ret_1d on idx=25
        self.assertTrue(np.isnan(pstore.channel("ret_1d")[1, 25]))

        anc_df = pd.DataFrame(
            {
                "row_id": [0, 1],
                "asset_id": [asset_susp, asset_susp],
                "signal_session": [sessions[25].isoformat(), sessions[29].isoformat()],
                "entry_session": [sessions[26].isoformat(), sessions[29].isoformat()],
                "decision_at": [
                    pd.Timestamp(sessions[25], tz="UTC"),
                    pd.Timestamp(sessions[29], tz="UTC"),
                ],
                "in_universe": [True, True],
                "is_benchmark": [False, False],
                "asset_idx": [1, 1],
                "session_idx": [25, 29],
                "fund_snap_id": [-1, -1],
                "event_start_cursor": [0, 0],
                "event_end_cursor": [0, 0],
            }
        )
        anchors = Anchors(
            frame=anc_df,
            order_sha256="test-b3",
            assets=(asset_mix, asset_susp),
            sessions=tuple(sessions),
            time_policy="pit_v1",
            sampling="weekly",
        )
        stores = Stores(
            anchors=anchors, prices=pstore, fundamentals=None, events=None, macro=None
        )
        ctx = GroupBuildContext(
            version=SimpleNamespace(calendar=sessions, manifest={"data_families": {}}),
            stores=stores,
            time_policy="pit_v1",
        )
        mom = build_price_momentum_reversal(ctx, {"windows": [1, 5, 21]})
        rng = build_price_range_anchor(ctx, {"windows": [21, 252]})
        self.assertTrue(np.isnan(mom["pmom_ret_1d"].iloc[0]))
        self.assertTrue(np.isnan(mom["pmom_ret_5d"].iloc[0]))
        self.assertTrue(np.isnan(mom["pmom_ret_21d"].iloc[1]))
        self.assertTrue(np.isnan(rng["prange_ma_gap_21d"].iloc[1]))
        self.assertTrue(np.isnan(rng["prange_dist_high_21d"].iloc[1]))
        self.assertTrue(np.isnan(rng["prange_dist_low_21d"].iloc[1]))
        self.assertFalse(np.isnan(mom["pmom_ret_1d"].iloc[1]))

    def test_trade_shock_masked_across_split_window(self) -> None:
        from types import SimpleNamespace

        from research_datasets.feature_groups import GroupBuildContext
        from research_datasets.groups.price import build_price_liquidity_shock
        from research_datasets.stores import PRICE_CHANNELS, Anchors, PriceStore, Stores

        n_sess = 140
        sessions = _nyse_sessions(date(2025, 1, 2), n_sess)
        tensor = np.full((1, n_sess, len(PRICE_CHANNELS)), np.nan, dtype=np.float32)
        ch = {name: idx for idx, name in enumerate(PRICE_CHANNELS)}
        tensor[0, :, ch["close_raw"]] = 100.0
        tensor[0, :, ch["high_raw"]] = 101.0
        tensor[0, :, ch["low_raw"]] = 99.0
        tensor[0, :, ch["vwap_raw"]] = 100.0
        tensor[0, :, ch["volume_raw"]] = 1000.0
        tensor[0, :, ch["ret_1d"]] = 0.0
        tensor[0, :70, ch["split_index"]] = 1.0
        tensor[0, 70:, ch["split_index"]] = 4.0
        tensor[0, :70, ch["trade_count_raw"]] = 100.0
        tensor[0, 70:, ch["trade_count_raw"]] = 400.0

        pstore = PriceStore(
            tensor, assets=(ASSET_1,), sessions=sessions, benchmark_idx=-1
        )
        sample_idxs = [69, 70, 75, 131, 132]
        anc_df = pd.DataFrame(
            {
                "row_id": list(range(len(sample_idxs))),
                "asset_id": [ASSET_1] * len(sample_idxs),
                "signal_session": [sessions[i].isoformat() for i in sample_idxs],
                "entry_session": [sessions[i].isoformat() for i in sample_idxs],
                "decision_at": [
                    pd.Timestamp(sessions[i], tz="UTC") for i in sample_idxs
                ],
                "in_universe": [True] * len(sample_idxs),
                "is_benchmark": [False] * len(sample_idxs),
                "asset_idx": [0] * len(sample_idxs),
                "session_idx": sample_idxs,
                "fund_snap_id": [-1] * len(sample_idxs),
                "event_start_cursor": [0] * len(sample_idxs),
                "event_end_cursor": [0] * len(sample_idxs),
            }
        )
        anchors = Anchors(
            frame=anc_df,
            order_sha256="test-b13",
            assets=(ASSET_1,),
            sessions=tuple(sessions),
            time_policy="pit_v1",
            sampling="weekly",
        )
        stores = Stores(
            anchors=anchors, prices=pstore, fundamentals=None, events=None, macro=None
        )
        ctx = GroupBuildContext(
            version=SimpleNamespace(calendar=sessions, manifest={"data_families": {}}),
            stores=stores,
            time_policy="pit_v1",
        )
        out = build_price_liquidity_shock(ctx, {})
        # Session 69 (pre-split): finite ~1.0; sessions 70, 75, 131 (70+61): NaN; session 132 (70+62): finite
        self.assertAlmostEqual(
            float(out["pliq_trade_shock_5d_63d"].iloc[0]), 1.0, places=5
        )
        self.assertTrue(np.isnan(out["pliq_trade_shock_5d_63d"].iloc[1]))
        self.assertTrue(np.isnan(out["pliq_trade_shock_5d_63d"].iloc[2]))
        self.assertTrue(np.isnan(out["pliq_trade_shock_5d_63d"].iloc[3]))
        self.assertAlmostEqual(
            float(out["pliq_trade_shock_5d_63d"].iloc[4]), 1.0, places=5
        )
        self.assertTrue(np.all(np.isfinite(out["pliq_rel_vol_5d_63d"].to_numpy())))

    def test_fund_store_includes_issuer_history_for_delisted_asset(self) -> None:
        sessions = _nyse_sessions(date(2025, 1, 2), 40)
        asset_dlst = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
        cik_dlst = "0000999888"
        universe = [
            {
                "asset_id": asset_dlst,
                "symbol": "DLST",
                "cik": "",
                "issuer_mapping_status": "missing",
                "listed_from": sessions[0].isoformat(),
                "listed_to": sessions[-1].isoformat(),
                "status": "delisted",
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
        for aid in (asset_dlst, ASSET_SPY):
            for idx, d in enumerate(sessions):
                px = 100.0 + idx
                price_rows.append(
                    {
                        "asset_id": aid,
                        "date": d.isoformat(),
                        "open": px,
                        "high": px + 0.5,
                        "low": px - 0.5,
                        "close": px,
                        "volume": 1000.0,
                        "adjustment": "all",
                    }
                )
                dr_rows.append(
                    {
                        "asset_id": aid,
                        "date": d.isoformat(),
                        "row_kind": "first" if idx == 0 else "session",
                        "tr_index": px / 100.0,
                        "split_index": 1.0,
                        "flags": [],
                    }
                )
        pub_iso = _et_iso(sessions[5], 9, 0)
        facts_df = pd.DataFrame(
            [
                {
                    "fact_id": "dlst-rev-1",
                    "cik": cik_dlst,
                    "metric": "Revenues",
                    "source": "sec",
                    "taxonomy": "us-gaap",
                    "tag": "Revenues",
                    "tag_priority": 1,
                    "unit": "USD",
                    "currency": "USD",
                    "period_start": "2024-10-01",
                    "period_end": "2024-12-31",
                    "period_kind": "duration",
                    "form": "10-K",
                    "accession": "0009-0001",
                    "filed": sessions[5].isoformat(),
                    "public_at": pub_iso,
                    "public_date": sessions[5].isoformat(),
                    "public_time_precision": "second",
                    "value": "5000.00",
                    "observed_at": pub_iso,
                    "content_first_seen_at": pub_iso,
                    "observation_sequence": 1,
                    "is_retracted": False,
                }
            ]
        )
        ih_df = pd.DataFrame(
            [
                {
                    "asset_id": asset_dlst,
                    "cik": cik_dlst,
                    "valid_from": sessions[0].isoformat(),
                    "valid_to": sessions[-1].isoformat(),
                    "status": "verified",
                }
            ]
        )
        ver = _SyntheticVersion(
            calendar=sessions,
            universe=universe,
            families={
                "fundamentals": facts_df,
                "daily_returns": pd.DataFrame(dr_rows),
                "issuer_history": ih_df,
            },
            prices_adj=pd.DataFrame(price_rows),
            prices_raw=pd.DataFrame(price_rows),
            manifest_extra={"source_timezones": {"sec": "America/New_York"}},
        )
        with tempfile.TemporaryDirectory() as tmp:
            recipe = _minimal_recipe(
                sampling="weekly",
                groups={"fundamentals_pit": {"enabled": True}},
            )
            res = research_datasets.materialize(
                ver,
                recipe_yaml=recipe,
                cache_dir=tmp,
                benchmark="SPY",
                include_labels=False,
            )
            late_rows = res.anchors.frame[
                (res.anchors.frame["asset_id"] == asset_dlst)
                & (res.anchors.frame["session_idx"] >= 6)
            ]
            self.assertGreater(len(late_rows), 0)
            self.assertTrue((late_rows["fund_snap_id"] >= 0).all())
            late_feats = res.X.loc[late_rows.index, "fund_visible_quarters"]
            self.assertTrue((late_feats >= 1.0).all())

    def test_fund_store_reaction_window_uses_public_ns(self) -> None:
        sessions = _nyse_sessions(date(2025, 1, 2), 40)
        cal = clocks.Calendar(sessions)
        universe = [
            {
                "asset_id": ASSET_1,
                "symbol": "PUB1",
                "cik": CIK_1,
                "listed_from": sessions[0].isoformat(),
                "listed_to": None,
                "status": "active",
                "is_benchmark": False,
            }
        ]
        price_rows = []
        dr_rows = []
        for idx, d in enumerate(sessions):
            # Jump at session 26 (day after public_at at session 24 post-close) vs different move at session 31+ (after observed_at at session 30)
            lvl = 100.0 if idx <= 25 else (120.0 if idx <= 30 else 132.0)
            price_rows.append(
                {
                    "asset_id": ASSET_1,
                    "date": d.isoformat(),
                    "open": lvl,
                    "high": lvl,
                    "low": lvl,
                    "close": lvl,
                    "volume": 1000.0,
                    "adjustment": "all",
                }
            )
            dr_rows.append(
                {
                    "asset_id": ASSET_1,
                    "date": d.isoformat(),
                    "row_kind": "first" if idx == 0 else "session",
                    "tr_index": lvl / 100.0,
                    "split_index": 1.0,
                    "flags": [],
                }
            )
        pub_day = sessions[24]
        obs_day = sessions[30]
        pub_iso = _et_iso(pub_day, 16, 30)
        obs_iso = _et_iso(obs_day, 10, 0)
        facts_df = pd.DataFrame(
            [
                {
                    "fact_id": "pub-clock-1",
                    "cik": CIK_1,
                    "metric": "Revenues",
                    "source": "sec",
                    "taxonomy": "us-gaap",
                    "tag": "Revenues",
                    "tag_priority": 1,
                    "unit": "USD",
                    "currency": "USD",
                    "period_start": "2024-10-01",
                    "period_end": "2024-12-31",
                    "period_kind": "duration",
                    "form": "10-Q",
                    "accession": "0001-7777",
                    "filed": pub_day.isoformat(),
                    "public_at": pub_iso,
                    "public_date": pub_day.isoformat(),
                    "public_time_precision": "second",
                    "value": "1000.00",
                    "observed_at": obs_iso,
                    "content_first_seen_at": obs_iso,
                    "observation_sequence": 1,
                    "is_retracted": False,
                }
            ]
        )
        ver = _SyntheticVersion(
            calendar=sessions,
            universe=universe,
            families={
                "fundamentals": facts_df,
                "daily_returns": pd.DataFrame(dr_rows),
            },
            prices_adj=pd.DataFrame(price_rows),
            prices_raw=pd.DataFrame(price_rows),
            manifest_extra={"source_timezones": {"sec": "America/New_York"}},
        )
        pstore = build_price_store(ver, [ASSET_1], cal.days)
        fstore = build_fund_store(
            ver,
            [CIK_1],
            time_policy="observed_content",
            cal=cal,
            price_store=pstore,
            primary_asset_of_cik={CIK_1: 0},
        )
        self.assertEqual(len(fstore.snap_epoch_ns), 1)
        # public_at is 16:30 after session 24 close -> r0_idx=25, +1d=26 (lvl 120 / pre lvl 100 - 1 = +0.20)
        self.assertEqual(int(fstore.snap_post_1d_ready_ns[0]), int(cal.closes[26]))
        self.assertAlmostEqual(float(fstore.snap_post_1d_ret[0]), 0.20, places=4)

    def test_build_earnings_pead_sue_masks_stale_and_old_sue(self) -> None:
        from unittest.mock import patch

        from research_datasets.feature_groups import GroupBuildContext
        from research_datasets.groups.domain import build_earnings_pead_sue
        from research_datasets.stores import (
            PRICE_CHANNELS,
            Anchors,
            EventStore,
            PriceStore,
            Stores,
        )

        sessions = _nyse_sessions(date(2025, 1, 2), 10)
        cal = clocks.Calendar(sessions)
        tensor = np.full(
            (1, len(sessions), len(PRICE_CHANNELS)), np.nan, dtype=np.float32
        )
        tensor[0, :, 3] = 100.0
        tensor[0, :, 4] = 1000.0
        tensor[0, :, 7] = 100.0
        pstore = PriceStore(
            tensor, assets=(ASSET_1,), sessions=sessions, benchmark_idx=-1
        )
        estore = EventStore(
            assets=(ASSET_1,),
            asset_offsets=np.array([0, 0], dtype=np.int64),
            public_at_ns=np.empty(0, dtype=np.int64),
            available_at_ns=np.empty(0, dtype=np.int64),
            source_id=np.empty(0, dtype=np.uint8),
            kind_code=np.empty(0, dtype=np.int32),
            kinds=(),
            numeric_value=np.empty(0, dtype=np.float32),
            pre_ret_21d=np.empty(0, dtype=np.float32),
            post_1d_ret=np.empty(0, dtype=np.float32),
            post_3d_ret=np.empty(0, dtype=np.float32),
            post_1d_ready_ns=np.empty(0, dtype=np.int64),
            post_3d_ready_ns=np.empty(0, dtype=np.int64),
            time_policy="public_reconstructed",
        )
        anc_df = pd.DataFrame(
            {
                "row_id": [0, 1, 2],
                "asset_id": [ASSET_1, ASSET_1, ASSET_1],
                "signal_session": [
                    sessions[2].isoformat(),
                    sessions[5].isoformat(),
                    sessions[8].isoformat(),
                ],
                "entry_session": [
                    sessions[3].isoformat(),
                    sessions[6].isoformat(),
                    sessions[9].isoformat(),
                ],
                "decision_at": [
                    pd.Timestamp(cal.decisions[2], unit="ns", tz="UTC"),
                    pd.Timestamp(cal.decisions[5], unit="ns", tz="UTC"),
                    pd.Timestamp(cal.decisions[8], unit="ns", tz="UTC"),
                ],
                "in_universe": [True, True, True],
                "is_benchmark": [False, False, False],
                "asset_idx": [0, 0, 0],
                "session_idx": [2, 5, 8],
                "fund_snap_id": [-1, -1, -1],
                "event_start_cursor": [0, 0, 0],
                "event_end_cursor": [0, 0, 0],
            }
        )
        anchors = Anchors(
            frame=anc_df,
            order_sha256="test-b11",
            assets=(ASSET_1,),
            sessions=tuple(sessions),
            time_policy="public_reconstructed",
            sampling="weekly",
        )
        stores = Stores(
            anchors=anchors, prices=pstore, fundamentals=None, events=estore, macro=None
        )
        ver = _SyntheticVersion(
            calendar=sessions,
            universe=[
                {
                    "asset_id": ASSET_1,
                    "symbol": "SUE1",
                    "cik": CIK_1,
                    "issuer_mapping_status": "verified",
                }
            ],
            families={
                "fundamentals": pd.DataFrame(),
                "earnings_announcements": pd.DataFrame(),
            },
            prices_adj=pd.DataFrame(
                [
                    {"asset_id": ASSET_1, "date": d.isoformat(), "close": 100.0}
                    for d in sessions
                ]
            ),
            prices_raw=pd.DataFrame(
                [
                    {"asset_id": ASSET_1, "date": d.isoformat(), "close": 100.0}
                    for d in sessions
                ]
            ),
        )
        ctx = GroupBuildContext(
            version=ver, stores=stores, time_policy="public_reconstructed"
        )
        fake_earn = pd.DataFrame(
            {
                "earn_days_since": [10.0, 20.0, 30.0],
                "earn_next_within_5s": [0, 0, 0],
                "earn_pre_ret_5d": [0.01, 0.02, 0.03],
                "earn_pre_ret_21d": [0.02, 0.03, 0.04],
                "earn_ear": [0.01, 0.02, 0.03],
                "earn_car_5d": [0.01, 0.02, 0.03],
                "earn_car_21d": [0.02, 0.03, 0.04],
                "earn_volume_ratio": [1.5, 1.5, 1.5],
                "earn_reaction_known": [1, 1, 1],
            }
        )
        fake_earn.attrs["primary_period_end"] = [
            "2024-12-31",
            "2024-12-31",
            "2024-12-31",
        ]
        fake_sue = pd.DataFrame(
            {
                "earn_sue_eps": [1.5, 2.5, 3.5],
                "earn_sue_eps_price": [0.01, 0.02, 0.03],
                "earn_sue_revenue": [0.5, 1.0, 1.5],
                "earn_sue_age_days": [50.0, 205.0, 60.0],
                "earn_sue_stale": [False, False, True],
            }
        )
        with (
            patch(
                "research_datasets.groups.domain._sec_events.earnings_features",
                return_value=fake_earn,
            ),
            patch(
                "research_datasets.groups.domain._sec_events.sue_features",
                return_value=fake_sue,
            ),
        ):
            out = build_earnings_pead_sue(ctx, {})
        # Row 0: fresh & non-stale -> preserved
        self.assertAlmostEqual(float(out.loc[0, "earn_sue_eps"]), 1.5)
        self.assertAlmostEqual(float(out.loc[0, "earn_sue_revenue"]), 0.5)
        # Row 1: age_days > 200 -> masked
        self.assertTrue(np.isnan(out.loc[1, "earn_sue_eps"]))
        self.assertTrue(np.isnan(out.loc[1, "earn_sue_eps_price"]))
        self.assertTrue(np.isnan(out.loc[1, "earn_sue_revenue"]))
        # Row 2: earn_sue_stale == True -> masked
        self.assertTrue(np.isnan(out.loc[2, "earn_sue_eps"]))
        self.assertTrue(np.isnan(out.loc[2, "earn_sue_eps_price"]))
        self.assertTrue(np.isnan(out.loc[2, "earn_sue_revenue"]))

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

"""Unit tests for SDK 2.7.0: BTC/ETH 7x24 features, Restatement Delta, streaming prefetch & JAX views."""

from __future__ import annotations

import http.server
import json
import math
import tempfile
import threading
import unittest
import urllib.parse
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd

import research_datasets
from research_datasets import (
    Client,
    DatasetError,
    build_server_training_bundle,
    connect,
)
from research_datasets.training import (
    load_training_bundle,
    slice_training_view,
)
from tests.test_sdk_v26 import ASSET_2, CIK_2, _make_price_rows
from tests.test_stores_and_materialize import (
    ASSET_1,
    ASSET_SPY,
    CIK_1,
    _nyse_sessions,
    _SyntheticVersion,
)

NY_TZ = ZoneInfo("America/New_York")


def _ny_utc_iso(d: date, hour: int, minute: int = 0) -> str:
    return (
        datetime(d.year, d.month, d.day, hour, minute, tzinfo=NY_TZ)
        .astimezone(ZoneInfo("UTC"))
        .isoformat(timespec="seconds")
        .replace("+00:00", "Z")
    )


def _build_rich_synthetic_version(
    *,
    sessions: list[date],
    restate_filed: str = "2024-06-12",
    include_non_reliance_on: str = "2024-06-14",
    include_amendment_on: str = "2024-06-17",
    extra_spike_after_fit_end: float = 0.0,
) -> _SyntheticVersion:
    n_s = len(sessions)
    rng = np.random.default_rng(42)

    # Synthetic 7x24 BTC/ETH prices covering every calendar day including weekends
    first_cal = sessions[0] - timedelta(days=5)
    last_cal = sessions[-1] + timedelta(days=2)
    cal_days: list[date] = []
    cur = first_cal
    while cur <= last_cal:
        cal_days.append(cur)
        cur += timedelta(days=1)

    btc_ret_daily = rng.normal(0.001, 0.03, size=len(cal_days))
    eth_ret_daily = rng.normal(0.001, 0.04, size=len(cal_days))
    btc_close = 40000.0 * np.exp(np.cumsum(btc_ret_daily))
    eth_close = 2500.0 * np.exp(np.cumsum(eth_ret_daily))

    # Inject a known deterministic weekend move on a Friday -> Monday pair
    fri_idx_s = next(
        i
        for i in range(10, n_s - 2)
        if sessions[i].weekday() == 4 and (sessions[i + 1] - sessions[i]).days == 3
    )
    fri_d = sessions[fri_idx_s]
    mon_d = sessions[fri_idx_s + 1]

    ref_rows: list[dict[str, Any]] = []
    day_to_btc: dict[date, float] = {}
    for d, b_c, e_c in zip(cal_days, btc_close, eth_close, strict=True):
        day_to_btc[d] = float(b_c)
        # Weekend shock specifically between fri_d 16:00 ET and mon_d 06:00 ET (+10% BTC, -5% ETH)
        b_c16 = 50000.0 if d == fri_d else float(b_c)
        b_p06 = 55000.0 if d == mon_d else float(b_c * 1.002)
        e_c16 = 3000.0 if d == fri_d else float(e_c)
        e_p06 = 2850.0 if d == mon_d else float(e_c * 0.999)
        # Intentionally put a huge jump on mon_d CLOSE16 (available AFTER Mon 06:00 ET!) to prove anti-leakage
        if d == mon_d:
            b_c16 = 99999.0
            e_c16 = 9999.0

        for sid, val, avail in (
            ("CBBTCUSD", b_c16, _ny_utc_iso(d + timedelta(days=1), 6, 0)),
            ("CBETHUSD", e_c16, _ny_utc_iso(d + timedelta(days=1), 6, 0)),
            ("ALPACA_BTC_CLOSE16", b_c16, _ny_utc_iso(d, 16, 5)),
            ("ALPACA_BTC_PRE06", b_p06, _ny_utc_iso(d, 6, 0)),
            ("ALPACA_ETH_CLOSE16", e_c16, _ny_utc_iso(d, 16, 5)),
            ("ALPACA_ETH_PRE06", e_p06, _ny_utc_iso(d, 6, 0)),
            ("DGS10", 4.2, _ny_utc_iso(d + timedelta(days=2), 0, 0)),
            ("DGS2", 4.5, _ny_utc_iso(d + timedelta(days=2), 0, 0)),
            ("DTB3", 5.2, _ny_utc_iso(d + timedelta(days=2), 0, 0)),
            (
                "VIXCLS",
                15.0 + 0.1 * (d.day % 5),
                _ny_utc_iso(d + timedelta(days=2), 0, 0),
            ),
            ("VXVCLS", 17.0, _ny_utc_iso(d + timedelta(days=2), 0, 0)),
            ("BAA10Y", 2.0, _ny_utc_iso(d + timedelta(days=2), 0, 0)),
            ("DTWEXBGS", 120.0, _ny_utc_iso(d + timedelta(days=2), 0, 0)),
            ("DCOILWTICO", 75.0, _ny_utc_iso(d + timedelta(days=2), 0, 0)),
        ):
            ref_rows.append(
                {
                    "series_id": sid,
                    "date": d.isoformat(),
                    "value": val,
                    "observation_sequence": 1,
                    "observed_at": avail,
                    "available_at": avail,
                }
            )

    # Stock 1 strongly coupled to BTC (+0.8 beta), Stock 2 uncorrelated (0 beta)
    spy_r = rng.normal(0.0004, 0.008, size=n_s)
    btc_s_lvls = np.array([day_to_btc[d] for d in sessions], dtype=np.float64)
    btc_s_ret = np.zeros(n_s, dtype=np.float64)
    btc_s_ret[1:] = np.log(btc_s_lvls[1:] / btc_s_lvls[:-1])
    a1_r = spy_r + 0.8 * btc_s_ret + rng.normal(0.0, 0.003, size=n_s)
    a2_r = spy_r + rng.normal(0.0, 0.008, size=n_s)
    if extra_spike_after_fit_end > 0.0:
        a2_r[-10] += extra_spike_after_fit_end

    p_df, dr_df = _make_price_rows(
        sessions,
        {
            ASSET_SPY: (450.0 * np.exp(np.cumsum(spy_r)), np.full(n_s, 5e7)),
            ASSET_1: (100.0 * np.exp(np.cumsum(a1_r)), np.full(n_s, 2e6)),
            ASSET_2: (50.0 * np.exp(np.cumsum(a2_r)), np.full(n_s, 1.5e6)),
        },
    )

    # Fundamentals for ASSET_1 (non-financial) & ASSET_2 (bank SIC 6021)
    # Q1 2024 originally filed 2024-05-01 with NI=100M, Rev=500M, Assets=1000M.
    # Restated on `restate_filed` (2024-06-12) to NI=60M (-40M = -4% of assets!), Rev=450M (-50M = -5% of assets!).
    facts: list[dict[str, Any]] = []
    fid = 0

    def _add_f(
        cik: str,
        tag: str,
        ps: str | None,
        pe: str,
        form: str,
        filed: str,
        val: str,
        seq: int = 1,
    ) -> None:
        nonlocal fid
        fid += 1
        pub = f"{filed}T16:30:00-04:00"
        facts.append(
            {
                "fact_id": f"rf-{fid}",
                "cik": cik,
                "metric": tag,
                "source": "sec",
                "taxonomy": "us-gaap",
                "tag": tag,
                "tag_priority": 1,
                "unit": "USD",
                "currency": "USD",
                "period_start": ps,
                "period_end": pe,
                "period_kind": "instant" if ps is None else "duration",
                "form": form,
                "accession": f"0009-{fid:04d}",
                "filed": filed,
                "public_at": pub,
                "public_date": filed,
                "public_time_precision": "second",
                "observed_at": pub,
                "content_first_seen_at": pub,
                "available_at": pub,
                "observation_sequence": seq,
                "value": val,
                "is_retracted": False,
            }
        )

    for cik in (CIK_1, CIK_2):
        # Initial Q1 2024 filing (2024-05-01)
        _add_f(
            cik,
            "NetIncomeLoss",
            "2024-01-01",
            "2024-03-31",
            "10-Q",
            "2024-05-01",
            "100000000",
        )
        _add_f(
            cik,
            "Revenues",
            "2024-01-01",
            "2024-03-31",
            "10-Q",
            "2024-05-01",
            "500000000",
        )
        _add_f(cik, "Assets", None, "2024-03-31", "10-Q", "2024-05-01", "1000000000")
        # Restated Q1 2024 in 10-Q/A on restate_filed (2024-06-12)
        _add_f(
            cik,
            "NetIncomeLoss",
            "2024-01-01",
            "2024-03-31",
            "10-Q/A",
            restate_filed,
            "60000000",
            seq=2,
        )
        _add_f(
            cik,
            "Revenues",
            "2024-01-01",
            "2024-03-31",
            "10-Q/A",
            restate_filed,
            "450000000",
            seq=2,
        )

    # SEC EventObservations: 8-K Item 4.02 (non_reliance) & 10-Q/A (quarterly_report_amendment) for ASSET_1
    ev_obs = pd.DataFrame(
        [
            {
                "source": "sec",
                "event_uid": "ev-nr-1",
                "event_id": "ev-nr-1",
                "observation_sequence": 1,
                "form": "8-K",
                "items": "4.02",
                "event_kinds": ["non_reliance"],
                "filing_date": include_non_reliance_on,
                "event_date": include_non_reliance_on,
                "asset_ids": [ASSET_1],
                "asset_first_seen_at": f"{include_non_reliance_on}T17:00:00Z",
                "content_first_seen_at": f"{include_non_reliance_on}T17:00:00Z",
                "observation_recorded_at": f"{include_non_reliance_on}T17:00:00Z",
                "public_time_precision": "second",
                "public_at": f"{include_non_reliance_on}T17:00:00Z",
                "public_date": include_non_reliance_on,
                "public_time_basis": "sec_acceptance",
                "story_key": "",
            },
            {
                "source": "sec",
                "event_uid": "ev-am-1",
                "event_id": "ev-am-1",
                "observation_sequence": 1,
                "form": "10-Q/A",
                "items": "",
                "event_kinds": ["quarterly_report_amendment"],
                "filing_date": include_amendment_on,
                "event_date": include_amendment_on,
                "asset_ids": [ASSET_1],
                "asset_first_seen_at": f"{include_amendment_on}T17:00:00Z",
                "content_first_seen_at": f"{include_amendment_on}T17:00:00Z",
                "observation_recorded_at": f"{include_amendment_on}T17:00:00Z",
                "public_time_precision": "second",
                "public_at": f"{include_amendment_on}T17:00:00Z",
                "public_date": include_amendment_on,
                "public_time_basis": "sec_acceptance",
                "story_key": "",
            },
        ]
    )

    issuer_profiles = pd.DataFrame(
        [
            {
                "cik": CIK_1,
                "sic": "3571",
                "observed_at": "2023-12-01T00:00:00Z",
                "observation_sequence": 1,
            },
            {
                "cik": CIK_2,
                "sic": "6021",
                "observed_at": "2023-12-01T00:00:00Z",
                "observation_sequence": 1,
            },
        ]
    )

    months = sorted({d.strftime("%Y-%m") for d in sessions})
    uni_rows = []
    for m in months:
        for aid in (ASSET_1, ASSET_2):
            uni_rows.append(
                {
                    "rule_version": "pit-largecap-v2",
                    "effective_month": m,
                    "effective_from": f"{m}-01",
                    "asset_id": aid,
                    "member": True,
                    "warmup": False,
                    "observation_sequence": 1,
                }
            )

    universe = [
        {
            "asset_id": ASSET_1,
            "symbol": "AAA",
            "cik": CIK_1,
            "issuer_mapping_status": "verified",
            "security_type": "common",
            "status": "active",
            "is_benchmark": False,
        },
        {
            "asset_id": ASSET_2,
            "symbol": "BBB",
            "cik": CIK_2,
            "issuer_mapping_status": "verified",
            "security_type": "common",
            "status": "active",
            "is_benchmark": False,
        },
        {
            "asset_id": ASSET_SPY,
            "symbol": "SPY",
            "cik": "",
            "issuer_mapping_status": "unknown",
            "security_type": "etf",
            "status": "active",
            "is_benchmark": True,
        },
    ]

    ver = _SyntheticVersion(
        calendar=sessions,
        universe=universe,
        prices_raw=p_df.assign(adjustment="raw"),
        prices_adj=p_df,
        families={
            "daily_returns": dr_df,
            "reference_series": pd.DataFrame(ref_rows),
            "fundamentals": pd.DataFrame(facts),
            "event_observations": ev_obs,
            "issuer_profiles": issuer_profiles,
            "universe_membership": pd.DataFrame(uni_rows),
        },
    )
    ver._fri_d = fri_d  # type: ignore[attr-defined]
    ver._mon_d = mon_d  # type: ignore[attr-defined]
    return ver


class SdkV27Tests(unittest.TestCase):
    def test_crypto_7x24_weekend_gap_and_btc_beta_strictly_causal(self) -> None:
        sessions = _nyse_sessions(date(2024, 1, 2), 140)
        ver = _build_rich_synthetic_version(sessions=sessions)
        fri_d: date = ver._fri_d  # type: ignore[attr-defined]
        recipe = {
            "schema_version": 1,
            "name": "crypto-test",
            "sampling": "daily",
            "time_policy": "public_reconstructed",
            "horizons_trading_days": [5, 21],
            "feature_groups": {
                "macro_regime": {"enabled": True},
                "macro_sensitivity_crisis": {"enabled": True, "window": 63},
            },
        }
        with tempfile.TemporaryDirectory() as tmp:
            mat = research_datasets.materialize(ver, recipe_yaml=recipe, cache_dir=tmp)
            af = mat.anchors.frame
            X = mat.X

            # Friday -> Monday 62h weekend gap MUST equal ln(55000 / 50000), NEVER polluted by Mon 16:00 close 99999!
            fri_rows = af["signal_session"] == fri_d
            self.assertTrue(fri_rows.any())
            wgap_btc = X.loc[fri_rows, "crypto_weekend_gap_btc"].iloc[0]
            wgap_eth = X.loc[fri_rows, "crypto_weekend_gap_eth"].iloc[0]
            self.assertAlmostEqual(
                float(wgap_btc), math.log(55000.0 / 50000.0), places=5
            )
            self.assertAlmostEqual(float(wgap_eth), math.log(2850.0 / 3000.0), places=5)

            # Ordinary weekday transition (e.g. Monday -> Tuesday) has weekend_gap == 0.0
            tue_sig_rows = af["signal_session"] == ver._mon_d  # type: ignore[attr-defined]
            if tue_sig_rows.any():
                self.assertAlmostEqual(
                    float(X.loc[tue_sig_rows, "crypto_weekend_gap_btc"].iloc[0]),
                    0.0,
                    places=6,
                )

            # Stock 1 has ~+0.8 BTC beta while Stock 2 has ~0 BTC beta in late window
            late = af["session_idx"] >= 100
            b1 = X.loc[late & (af["asset_id"] == ASSET_1), "mac_beta_btc_63d"].dropna()
            b2 = X.loc[late & (af["asset_id"] == ASSET_2), "mac_beta_btc_63d"].dropna()
            self.assertGreater(float(b1.median()), 0.5)
            self.assertLess(abs(float(b2.median())), 0.35)

    def test_fundamental_restatement_delta_and_sec_flags_zero_leakage(self) -> None:
        sessions = _nyse_sessions(date(2024, 4, 15), 75)
        ver = _build_rich_synthetic_version(
            sessions=sessions,
            restate_filed="2024-06-12",
            include_non_reliance_on="2024-06-14",
            include_amendment_on="2024-06-17",
        )
        recipe = {
            "schema_version": 1,
            "name": "restate-test",
            "sampling": "daily",
            "time_policy": "public_reconstructed",
            "horizons_trading_days": [5],
            "feature_groups": {
                "fundamental_restatement": {"enabled": True},
            },
        }
        with tempfile.TemporaryDirectory() as tmp:
            mat = research_datasets.materialize(ver, recipe_yaml=recipe, cache_dir=tmp)
            af = mat.anchors.frame
            X = mat.X

            # Before restatement filing (e.g. 2024-06-05): delta == 0, non_reliance == 0, amendment == 0
            a1_before = (af["asset_id"] == ASSET_1) & (
                af["signal_session"] == date(2024, 6, 5)
            )
            self.assertTrue(a1_before.any())
            self.assertAlmostEqual(
                float(X.loc[a1_before, "restate_ni_assets"].iloc[0]), 0.0, places=6
            )
            self.assertAlmostEqual(
                float(X.loc[a1_before, "restate_rev_assets"].iloc[0]), 0.0, places=6
            )
            self.assertEqual(
                float(X.loc[a1_before, "restate_ni_count_4q"].iloc[0]), 0.0
            )
            self.assertEqual(
                float(X.loc[a1_before, "restate_any_downward_4q"].iloc[0]), 0.0
            )
            self.assertEqual(
                float(X.loc[a1_before, "restate_sec_non_reliance_365d"].iloc[0]), 0.0
            )
            self.assertEqual(
                float(X.loc[a1_before, "restate_sec_amendment_365d"].iloc[0]), 0.0
            )

            # After restatement (2024-06-12), non_reliance (2024-06-14), amendment (2024-06-17):
            a1_after = (af["asset_id"] == ASSET_1) & (
                af["signal_session"] == date(2024, 6, 20)
            )
            self.assertTrue(a1_after.any())
            # (60M - 100M) / 1000M = -0.04; (450M - 500M) / 1000M = -0.05
            self.assertAlmostEqual(
                float(X.loc[a1_after, "restate_ni_assets"].iloc[0]), -0.04, places=5
            )
            self.assertAlmostEqual(
                float(X.loc[a1_after, "restate_rev_assets"].iloc[0]), -0.05, places=5
            )
            self.assertEqual(float(X.loc[a1_after, "restate_ni_count_4q"].iloc[0]), 1.0)
            self.assertEqual(
                float(X.loc[a1_after, "restate_rev_count_4q"].iloc[0]), 1.0
            )
            self.assertEqual(
                float(X.loc[a1_after, "restate_any_downward_4q"].iloc[0]), 1.0
            )
            self.assertEqual(
                float(X.loc[a1_after, "restate_sec_non_reliance_365d"].iloc[0]), 1.0
            )
            self.assertEqual(
                float(X.loc[a1_after, "restate_sec_amendment_365d"].iloc[0]), 1.0
            )

            # Financial bank ASSET_2 (SIC 6021): NI restatement visible, Revenue restatement masked NaN!
            a2_after = (af["asset_id"] == ASSET_2) & (
                af["signal_session"] == date(2024, 6, 20)
            )
            self.assertTrue(a2_after.any())
            self.assertAlmostEqual(
                float(X.loc[a2_after, "restate_ni_assets"].iloc[0]), -0.04, places=5
            )
            self.assertTrue(
                math.isnan(float(X.loc[a2_after, "restate_rev_assets"].iloc[0]))
            )
            self.assertTrue(
                math.isnan(float(X.loc[a2_after, "restate_rev_count_4q"].iloc[0]))
            )

    def test_server_training_bundle_http_prefetch_and_zero_leakage_jax_view(
        self,
    ) -> None:
        sessions = _nyse_sessions(date(2024, 1, 2), 130)
        ver = _build_rich_synthetic_version(sessions=sessions)
        recipe = {
            "schema_version": 1,
            "name": "bundle-test",
            "sampling": "weekly",
            "time_policy": "public_reconstructed",
            "horizons_trading_days": [5, 10, 21, 63],
            "feature_groups": {
                "price_momentum_reversal": {"enabled": True, "windows": [1, 5, 21]},
                "price_vol_beta": {"enabled": True, "windows": [5, 21]},
                "fundamentals_pit": {"enabled": True},
                "fundamental_quality": {"enabled": True},
                "fundamental_restatement": {"enabled": True},
                "macro_regime": {"enabled": True},
                "macro_sensitivity_crisis": {"enabled": True, "window": 63},
            },
        }
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bundle_dir = root / "server_bundle"
            meta = build_server_training_bundle(ver, bundle_dir, recipe_yaml=recipe)
            ds_id = ver.id
            bundle_id = meta["bundle_id"]
            key_prefix = f"datasets/{ds_id}/training/{bundle_id}"

            # Build HTTP read-endpoint fixture serving manifest + training/ artifacts
            files_map: dict[str, bytes] = {}
            for p in bundle_dir.iterdir():
                if p.is_file():
                    files_map[f"{key_prefix}/{p.name}"] = p.read_bytes()

            b_json_info = meta["bundle_json"]
            manifest = {
                **ver.manifest,
                "research_recipe": {
                    "training_bundle": {
                        "schema_version": 1,
                        "bundle_id": bundle_id,
                        "recipe_sha256": meta["recipe_sha256"],
                        "anchor_order_sha256": meta["anchor_order_sha256"],
                        "n_rows": meta["n_rows"],
                        "n_features_tier1": meta["n_features_tier1"],
                        "horizons": meta["horizons"],
                        "bundle_json": {
                            "key": f"{key_prefix}/bundle.json",
                            "sha256": b_json_info["sha256"],
                            "size_bytes": b_json_info["size_bytes"],
                            "content_type": "application/json",
                        },
                    }
                },
            }
            files_map[f"datasets/{ds_id}/manifest.json"] = json.dumps(manifest).encode(
                "utf-8"
            )

            request_log: list[str] = []

            class _Handler(http.server.BaseHTTPRequestHandler):
                def log_message(self, format: str, *args: Any) -> None:
                    del format, args

                def do_GET(self) -> None:
                    parsed = urllib.parse.urlsplit(self.path)
                    request_log.append(self.path)
                    if parsed.path == "/datasets":
                        body = json.dumps(
                            {"datasets": [{"dataset_id": ds_id, "state": "ready"}]}
                        ).encode("utf-8")
                        self.send_response(200)
                        self.send_header("Content-Type", "application/json")
                        self.send_header("Content-Length", str(len(body)))
                        self.end_headers()
                        self.wfile.write(body)
                        return
                    if parsed.path == "/artifact":
                        key = urllib.parse.parse_qs(parsed.query).get("key", [""])[0]
                        payload = files_map.get(key)
                        if payload is None:
                            self.send_response(404)
                            self.end_headers()
                            return
                        self.send_response(200)
                        self.send_header("Content-Type", "application/octet-stream")
                        self.send_header("Content-Length", str(len(payload)))
                        self.end_headers()
                        self.wfile.write(payload)
                        return
                    self.send_response(404)
                    self.end_headers()

            server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
            port = server.server_address[1]
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                cache_dir = root / "client_cache"
                client: Client = connect(
                    "synthetic-key",
                    base_url=f"http://127.0.0.1:{port}",
                    cache_dir=cache_dir,
                    quiet=True,
                )
                # Cold load: ds = client.dataset("latest") downloads & SHA-256 verifies all training shards
                ds = client.dataset("latest", progress=False)
                self.assertEqual(ds.id, ds_id)
                cold_reqs = len(request_log)
                self.assertGreater(cold_reqs, 3)

                # Warm reload from second Client sharing same SSD cache_dir -> 0 shard downloads!
                request_log.clear()
                client2 = connect(
                    "synthetic-key",
                    base_url=f"http://127.0.0.1:{port}",
                    cache_dir=cache_dir,
                    quiet=True,
                )
                ds2 = client2.dataset("latest", progress=False)
                # Only /datasets + manifest.json (0 bundle shard downloads because cache_dir hit!)
                shard_downloads = [p for p in request_log if "/training/" in p]
                self.assertEqual(shard_downloads, [])

                # Hard anti-leakage guard: fit_end > as_of rejected
                with self.assertRaisesRegex(ValueError, "LEAKAGE_GUARD"):
                    ds2.training(as_of="2024-05-01", fit_end="2024-06-01", pad_to=128)

                # Slice at as_of = 2024-06-14, fit_end = 2024-05-03
                as_of_d = date(2024, 6, 14)
                fit_end_d = date(2024, 5, 3)
                train = ds2.training(as_of=as_of_d, fit_end=fit_end_d, pad_to=128)

                # All anchors, PriceStore & MacroStore strictly <= as_of_d
                self.assertLessEqual(max(train.anchors["signal_session"]), as_of_d)
                self.assertIsNotNone(train.price_store)
                self.assertIsNotNone(train.macro_store)
                self.assertLessEqual(max(train.price_store.sessions), as_of_d)
                self.assertLessEqual(max(train.macro_store.sessions), as_of_d)

                # Per-horizon maturity masking:
                # For rows near as_of (2024-06-14), h21 & h63 exit AFTER 2024-06-14 -> MUST be masked!
                near_end = train.anchors["signal_session"] >= date(2024, 6, 1)
                self.assertTrue(near_end.any())
                self.assertFalse(bool(train.y.loc[near_end, "trainable_21d"].any()))
                self.assertFalse(bool(train.y.loc[near_end, "trainable_63d"].any()))
                self.assertTrue(
                    bool(train.y.loc[near_end, "h21_gauss_rank"].isna().all())
                )
                self.assertTrue(
                    bool(train.y.loc[near_end, "h63_gauss_rank"].isna().all())
                )
                # Earlier row (e.g. 2024-05-31): h5 exits 2024-06-07 <= 2024-06-14 (mature!), h21 exits > 2024-06-14 (immature!)
                mid_row = train.anchors["signal_session"] == date(2024, 5, 31)
                if mid_row.any():
                    self.assertTrue(bool(train.y.loc[mid_row, "trainable_5d"].any()))
                    self.assertFalse(bool(train.y.loc[mid_row, "trainable_21d"].any()))

                # Zero NaN/Inf in Tier-2 X
                self.assertTrue(np.all(np.isfinite(train.X.to_numpy(dtype=np.float32))))

                # Static TPU-MXU-aligned JAX tensors (pad_to=128)
                j = train.to_jax(pad_to=128, horizons=(5, 10, 21, 63), as_jax=False)
                t_weeks = len(j.signal_sessions)
                self.assertGreater(t_weeks, 5)
                self.assertEqual(j.x_tab.shape, (t_weeks, 128, train.X.shape[1]))
                self.assertEqual(j.ind_id.shape, (t_weeks, 128))
                self.assertEqual(j.valid_mask.shape, (t_weeks, 128))
                self.assertEqual(j.y_ret.shape, (t_weeks, 128, 4))
                self.assertEqual(j.trainable_mask.shape, (t_weeks, 128, 4))
                self.assertEqual(j.y_risk.shape, (t_weeks, 128, 4))
                self.assertTrue(np.all(np.isfinite(j.x_tab)))
                self.assertTrue(np.all(np.isfinite(j.y_ret)))
                self.assertTrue(np.all(np.isfinite(j.y_risk)))
                # Last week cannot have trainable 21d/63d targets
                self.assertFalse(bool(j.trainable_mask[-1, :, 2].any()))
                self.assertFalse(bool(j.trainable_mask[-1, :, 3].any()))

                # Sequence window batch extraction [B, pad_to, 60, 7]
                seq_b = j.seq_window_batch([t_weeks - 2, t_weeks - 1], window=60)
                self.assertEqual(seq_b["x_seq"].shape, (2, 128, 60, 7))
                self.assertTrue(np.all(np.isfinite(seq_b["x_seq"])))

                # Tier-2 fit_end isolation check: modifying future sparse values > fit_end leaves sparse_scales identical
                loaded = load_training_bundle(ds2, progress=False)
                v1 = slice_training_view(
                    loaded, as_of=as_of_d, fit_end=fit_end_d, pad_to=128
                )
                post_fit = loaded.sig_ordinals > fit_end_d.toordinal()
                fit_ok_all = loaded.in_universe & (~loaded.is_benchmark)
                if post_fit.any():
                    loaded.sparse_fit_cache.clear()
                    for cname in loaded.col_types["tier2_c_sparse"]:
                        if cname in loaded.x_cols_np:
                            arr = loaded.x_cols_np[cname]
                            arr[post_fit] = 999999.0
                            nz_idx = np.flatnonzero(
                                np.isfinite(arr) & (arr != 0.0)
                            ).astype(np.int32)
                            nz_v = arr[nz_idx]
                            loaded.sparse_csr[cname] = (
                                nz_idx,
                                np.abs(nz_v).astype(np.float32),
                                np.sign(nz_v).astype(np.float32),
                                fit_ok_all[nz_idx],
                            )
                v2 = slice_training_view(
                    loaded, as_of=as_of_d, fit_end=fit_end_d, pad_to=128
                )
                self.assertEqual(
                    v1.transform_state["sparse_scales"],
                    v2.transform_state["sparse_scales"],
                )

                # Tamper SHA-256 check on cached shard raises INTEGRITY error on refetch
                tampered_item = {
                    "key": f"{key_prefix}/anchors.parquet",
                    "sha256": "0" * 64,
                    "size_bytes": len(files_map[f"{key_prefix}/anchors.parquet"]),
                }
                with self.assertRaises(DatasetError) as err:
                    client2._artifact(tampered_item)
                self.assertEqual(err.exception.reason, "INTEGRITY")
            finally:
                server.shutdown()
                server.server_close()


if __name__ == "__main__":
    unittest.main()

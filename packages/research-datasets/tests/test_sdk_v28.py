"""Unit tests for SDK 2.8.0: Data v2 source gates, PIT mcap/ADV anchors, Qwen3 peers, LLM semantics, macro separation & MLOps publish."""

from __future__ import annotations

import base64
import hashlib
import http.server
import io
import json
import math
import tarfile
import tempfile
import threading
import unittest
from datetime import date
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

import research_datasets
from research_datasets import (
    build_server_training_bundle,
    continuous_feature_scorecard,
    publish_ml_run,
    source_coverage_placebo_audit,
)
from research_datasets.ml_publish import unpack_model_bundle_archive
from research_datasets.training import load_training_bundle, slice_training_view
from tests.test_sdk_v26 import ASSET_2, CIK_2, _make_price_rows
from tests.test_sdk_v27 import _build_rich_synthetic_version
from tests.test_stores_and_materialize import (
    ASSET_1,
    ASSET_SPY,
    CIK_1,
    _nyse_sessions,
    _SyntheticVersion,
)

ASSET_3 = "00000000-0000-4000-8000-000000000003"
CIK_3 = "0000000003"


class SdkV28Tests(unittest.TestCase):
    def test_version_and_unverified_news_physical_gate(self) -> None:
        self.assertEqual(research_datasets.__version__, "2.8.0")
        sessions = _nyse_sessions(date(2024, 1, 2), 90)
        ver = _build_rich_synthetic_version(sessions=sessions)
        anchors_df = pd.DataFrame(
            {
                "signal_session": sessions[:20] * 2,
                "in_universe": [True] * 40,
                "is_benchmark": [False] * 40,
            }
        )
        rng = np.random.default_rng(11)
        x_raw = pd.DataFrame(
            {
                "pmom_ret_21d": rng.standard_normal(40),
                "alpaca_news_events_21d": rng.uniform(0.0, 10.0, size=40),
                "alpaca_news_events_rank_21d": rng.uniform(0.0, 1.0, size=40),
                "news_21d_rank": rng.uniform(0.0, 1.0, size=40),
                "earn_days_since": np.linspace(10.0, 900.0, 40),
            }
        )

        # Default physical gate drops unverified news and caps days_since at <= 365
        x_t1, col_types = research_datasets.build_tier1_features(x_raw, anchors_df)
        self.assertNotIn("alpaca_news_events_21d", x_t1.columns)
        self.assertNotIn("news_21d_rank", x_t1.columns)
        self.assertIn("alpaca_news_events_21d", col_types["dropped"])
        self.assertLessEqual(float(x_t1["earn_days_since"].max()), 365.0)

        # Explicit opt-in permits verified news
        x_opt, _ = research_datasets.build_tier1_features(
            x_raw, anchors_df, allow_unverified_news=True
        )
        self.assertIn("alpaca_news_events_21d", x_opt.columns)
        self.assertIn("news_21d_rank", x_opt.columns)
        del ver

    def test_anchors_pit_market_cap_diluted_fallback_and_cusip_short_interest(
        self,
    ) -> None:
        sessions = _nyse_sessions(date(2024, 1, 2), 80)
        n_s = len(sessions)
        # ASSET_1 reports ONLY WeightedAverageNumberOfDilutedSharesOutstanding (10,000,000 shares)
        p_df, dr_df = _make_price_rows(
            sessions,
            {
                ASSET_SPY: (np.full(n_s, 450.0), np.full(n_s, 5e7)),
                ASSET_1: (np.full(n_s, 80.0), np.full(n_s, 2e6)),
                ASSET_2: (np.full(n_s, 40.0), np.full(n_s, 1e6)),
            },
        )
        pub = "2024-02-01T16:30:00-05:00"
        facts = pd.DataFrame(
            [
                {
                    "fact_id": "f-dil-1",
                    "cik": CIK_1,
                    "metric": "WeightedAverageNumberOfDilutedSharesOutstanding",
                    "source": "sec",
                    "taxonomy": "us-gaap",
                    "tag": "WeightedAverageNumberOfDilutedSharesOutstanding",
                    "tag_priority": 1,
                    "unit": "shares",
                    "currency": "",
                    "period_start": "2023-10-01",
                    "period_end": "2023-12-31",
                    "period_kind": "duration",
                    "form": "10-Q",
                    "accession": "0001-0001",
                    "filed": "2024-02-01",
                    "public_at": pub,
                    "public_date": "2024-02-01",
                    "public_time_precision": "second",
                    "observed_at": pub,
                    "content_first_seen_at": pub,
                    "available_at": pub,
                    "observation_sequence": 1,
                    "value": "10000000",
                    "is_retracted": False,
                }
            ]
        )
        si_df = pd.DataFrame(
            [
                {
                    "asset_id": ASSET_1,
                    "settlement_date": "2024-02-15",
                    "available_at": "2024-02-28T05:00:00Z",
                    "observed_at": "2024-02-28T05:00:00Z",
                    "current_short": 500_000.0,
                    "previous_short": 400_000.0,
                    "days_to_cover": 2.5,
                    "split_flag": False,
                    "link_basis": "cusip_interval",
                    "observation_sequence": 1,
                }
            ]
        )
        months = sorted({d.strftime("%Y-%m") for d in sessions})
        uni_rows = [
            {
                "rule_version": "pit-largecap-v2",
                "effective_month": m,
                "effective_from": f"{m}-01",
                "asset_id": aid,
                "member": True,
                "warmup": False,
                "observation_sequence": 1,
            }
            for m in months
            for aid in (ASSET_1, ASSET_2)
        ]
        ver = _SyntheticVersion(
            calendar=sessions,
            universe=[
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
            ],
            prices_raw=p_df.assign(adjustment="raw"),
            prices_adj=p_df,
            families={
                "daily_returns": dr_df,
                "fundamentals": facts,
                "short_interest": si_df,
                "universe_membership": pd.DataFrame(uni_rows),
            },
        )
        recipe = {
            "schema_version": 1,
            "name": "mcap-si-test",
            "sampling": "weekly",
            "time_policy": "public_reconstructed",
            "horizons_trading_days": [5],
            "feature_groups": {
                "valuation_dynamic": {"enabled": True},
                "short_interest": {"enabled": True},
            },
        }
        with tempfile.TemporaryDirectory() as tmp:
            mat = research_datasets.materialize(ver, recipe_yaml=recipe, cache_dir=tmp)
            af = mat.anchors.frame
            self.assertIn("market_cap_usd", af.columns)
            self.assertIn("adv21_usd", af.columns)

            post_filing = (af["asset_id"] == ASSET_1) & (
                af["signal_session"] >= date(2024, 3, 5)
            )
            self.assertTrue(post_filing.any())
            # 10,000,000 diluted shares * $80.00 = $800,000,000 (NOT adv21 = $160,000,000!)
            self.assertAlmostEqual(
                float(af.loc[post_filing, "market_cap_usd"].iloc[0]),
                800_000_000.0,
                delta=1e3,
            )
            self.assertAlmostEqual(
                float(af.loc[post_filing, "adv21_usd"].iloc[0]),
                160_000_000.0,
                delta=1e3,
            )
            # valuation_dynamic also resolved log_market_cap via shares_weighted_diluted_q
            self.assertAlmostEqual(
                float(mat.X.loc[post_filing, "val_log_market_cap"].iloc[0]),
                math.log(800_000_000.0),
                places=4,
            )
            # Historical CUSIP-linked short interest accepted!
            self.assertAlmostEqual(
                float(mat.X.loc[post_filing, "si_days_to_cover"].iloc[0]),
                2.5,
                places=4,
            )

    def test_qwen3_embedding_peers_llm_semantics_and_macro_separation(self) -> None:
        sessions = _nyse_sessions(date(2024, 1, 2), 130)
        n_s = len(sessions)
        rng = np.random.default_rng(99)
        spy_r = rng.normal(0.0003, 0.006, size=n_s)
        a1_r = spy_r + rng.normal(0.0, 0.01, size=n_s)
        a2_r = spy_r + rng.normal(0.0, 0.01, size=n_s)
        a3_r = spy_r + rng.normal(0.0, 0.01, size=n_s)
        # Inject strong +12% 5d rally in peer ASSET_2 right around session 80
        a2_r[76:81] += 0.025

        p_df, dr_df = _make_price_rows(
            sessions,
            {
                ASSET_SPY: (450.0 * np.exp(np.cumsum(spy_r)), np.full(n_s, 5e7)),
                ASSET_1: (100.0 * np.exp(np.cumsum(a1_r)), np.full(n_s, 3e6)),
                ASSET_2: (60.0 * np.exp(np.cumsum(a2_r)), np.full(n_s, 2e6)),
                ASSET_3: (45.0 * np.exp(np.cumsum(a3_r)), np.full(n_s, 1.5e6)),
            },
        )

        # Synthetic 256d float16 Qwen3-Embedding-4B Item 1 vectors:
        # CIK_1 and CIK_2 share nearly identical business embedding (~0.98 cosine); CIK_3 is orthogonal.
        v_base = np.zeros(256, dtype=np.float32)
        v_base[0] = 1.0
        v_peer = np.zeros(256, dtype=np.float32)
        v_peer[0] = 0.98
        v_peer[1] = 0.198997
        v_orth = np.zeros(256, dtype=np.float32)
        v_orth[2] = 1.0

        # Also add a LATER embedding for CIK_1 accepted on sessions[100] to test YoY drift & anti-leakage!
        v_shifted = np.zeros(256, dtype=np.float32)
        v_shifted[0] = 0.6
        v_shifted[1] = 0.8

        emb_df = pd.DataFrame(
            [
                {
                    "accession": "acc-1a",
                    "cik": CIK_1,
                    "filing_date": sessions[10].isoformat(),
                    "accepted_at": f"{sessions[10].isoformat()}T16:30:00-05:00",
                    "model_id": "Qwen/Qwen3-Embedding-4B",
                    "dim": 256,
                    "text_sha256": "a" * 64,
                    "vector_f16_blob": v_base.astype(np.float16).tobytes(),
                },
                {
                    "accession": "acc-2a",
                    "cik": CIK_2,
                    "filing_date": sessions[10].isoformat(),
                    "accepted_at": f"{sessions[10].isoformat()}T16:30:00-05:00",
                    "model_id": "Qwen/Qwen3-Embedding-4B",
                    "dim": 256,
                    "text_sha256": "b" * 64,
                    "vector_f16_blob": v_peer.astype(np.float16).tobytes(),
                },
                {
                    "accession": "acc-3a",
                    "cik": CIK_3,
                    "filing_date": sessions[10].isoformat(),
                    "accepted_at": f"{sessions[10].isoformat()}T16:30:00-05:00",
                    "model_id": "Qwen/Qwen3-Embedding-4B",
                    "dim": 256,
                    "text_sha256": "c" * 64,
                    "vector_f16_blob": v_orth.astype(np.float16).tobytes(),
                },
                {
                    "accession": "acc-1b",
                    "cik": CIK_1,
                    "filing_date": sessions[100].isoformat(),
                    "accepted_at": f"{sessions[100].isoformat()}T16:30:00-04:00",
                    "model_id": "Qwen/Qwen3-Embedding-4B",
                    "dim": 256,
                    "text_sha256": "d" * 64,
                    "vector_f16_blob": v_shifted.astype(np.float16).tobytes(),
                },
            ]
        )

        sec_8k_df = pd.DataFrame(
            [
                {
                    "accession": "8k-1",
                    "cik": CIK_1,
                    "accepted_at": f"{sessions[70].isoformat()}T17:00:00Z",
                    "ev8k_mna_sentiment": 0.85,
                    "ev8k_exec_departure_sev": 0.0,
                    "ev8k_buyback_pct_mcap": 0.04,
                    "ev8k_guidance_shock": 0.5,
                    "ev8k_distress_litigation": 0.0,
                }
            ]
        )
        sec_diff_df = pd.DataFrame(
            [
                {
                    "accession": "10k-diff-1",
                    "cik": CIK_1,
                    "accepted_at": f"{sessions[70].isoformat()}T17:00:00Z",
                    "diff_item1a_new_risk_sev": 0.72,
                    "diff_item1a_tone_shift": -0.35,
                    "diff_mdna_margin_driver": 0.40,
                    "diff_mdna_acct_policy_chg": 0.10,
                    "diff_substantive_chg_ratio": 0.22,
                }
            ]
        )
        ref_rows = [
            {
                "series_id": sid,
                "date": d.isoformat(),
                "value": val,
                "observation_sequence": 1,
                "observed_at": f"{d.isoformat()}T12:00:00Z",
                "available_at": f"{d.isoformat()}T12:00:00Z",
            }
            for i_d, d in enumerate(sessions)
            for sid, val in (
                ("VIXCLS", 15.0 + 0.08 * (i_d % 11)),
                ("VXVCLS", 17.5),
                ("DGS10", 4.1 + 0.01 * (i_d % 7)),
                ("DGS2", 4.4),
                ("DTB3", 5.2),
                ("BAA10Y", 1.9 + 0.01 * (i_d % 9)),
            )
        ]
        months = sorted({d.strftime("%Y-%m") for d in sessions})
        uni_rows = [
            {
                "rule_version": "pit-largecap-v2",
                "effective_month": m,
                "effective_from": f"{m}-01",
                "asset_id": aid,
                "member": True,
                "warmup": False,
                "observation_sequence": 1,
            }
            for m in months
            for aid in (ASSET_1, ASSET_2, ASSET_3)
        ]
        ver = _SyntheticVersion(
            calendar=sessions,
            universe=[
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
                    "asset_id": ASSET_3,
                    "symbol": "SIVB",
                    "cik": CIK_3,
                    "issuer_mapping_status": "verified",
                    "security_type": "common",
                    "status": "delisted",
                    "listed_to": sessions[-5].isoformat(),
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
            ],
            prices_raw=p_df.assign(adjustment="raw"),
            prices_adj=p_df,
            families={
                "daily_returns": dr_df,
                "reference_series": pd.DataFrame(ref_rows),
                "sec_item1_embeddings": emb_df,
                "sec_8k_events": sec_8k_df,
                "sec_filing_diffs": sec_diff_df,
                "universe_membership": pd.DataFrame(uni_rows),
            },
        )
        recipe = {
            "schema_version": 1,
            "name": "v28-full-test",
            "sampling": "weekly",
            "time_policy": "public_reconstructed",
            "horizons_trading_days": [5, 21],
            "feature_groups": {
                "price_momentum_reversal": {"enabled": True, "windows": [5, 21]},
                "macro_regime": {"enabled": True},
                "stock_macro_interactions": {"enabled": True, "window": 63},
                "embedding_peer_spillover": {"enabled": True, "top_k": 5},
                "llm_filing_semantics": {"enabled": True},
            },
        }
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            mat = research_datasets.materialize(
                ver, recipe_yaml=recipe, cache_dir=root / "mat"
            )
            af = mat.anchors.frame

            # Before session 70: 8-K & Diff features are 0 / NaN (zero look-ahead!)
            pre_70 = (af["asset_id"] == ASSET_1) & (af["signal_session"] < sessions[70])
            self.assertTrue(
                np.all(mat.X.loc[pre_70, "ev8k_mna_sentiment"].to_numpy() == 0.0)
            )
            self.assertTrue(
                bool(mat.X.loc[pre_70, "diff_item1a_new_risk_sev"].isna().all())
            )
            # Before session 100: emb_self_yoy_cos is NaN (future 10-K embedding not leaked!)
            pre_100 = (af["asset_id"] == ASSET_1) & (
                af["signal_session"] < sessions[100]
            )
            self.assertTrue(bool(mat.X.loc[pre_100, "emb_self_yoy_cos"].isna().all()))
            post_100 = (af["asset_id"] == ASSET_1) & (
                af["signal_session"] >= sessions[101]
            )
            self.assertAlmostEqual(
                float(mat.X.loc[post_100, "emb_self_yoy_cos"].iloc[0]), 0.6, places=3
            )
            # Around session 80, ASSET_1 picks up ASSET_2's rally via Qwen3 cosine spillover
            s80 = (
                (af["asset_id"] == ASSET_1)
                & (af["signal_session"] >= sessions[78])
                & (af["signal_session"] <= sessions[83])
            )
            self.assertGreater(float(mat.X.loc[s80, "emb_peer_ret_5d"].iloc[0]), 0.03)

            # Build server bundle & verify macro separation in TrainingView + JAX batch
            b_dir = root / "bundle"
            build_server_training_bundle(ver, b_dir, recipe_yaml=recipe)
            loaded = load_training_bundle(ver, progress=False, recipe_yaml=recipe)
            v_prev = slice_training_view(
                loaded,
                as_of=sessions[85],
                fit_end=sessions[75],
                pad_to=128,
            )
            v_curr = slice_training_view(
                loaded,
                as_of=sessions[-1],
                fit_end=sessions[105],
                pad_to=128,
            )

            # Date-constant macro features are separated out of X into macro_X & j.x_macro!
            self.assertFalse(
                any(c.startswith(("ref_", "etf_", "crypto_")) for c in v_curr.X.columns)
            )
            self.assertGreater(v_curr.macro_X.shape[1], 0)
            self.assertGreater(v_curr.macro_state.shape[1], 0)
            self.assertTrue(any(c.startswith("ix_") for c in v_curr.X.columns))

            j_batch = v_curr.to_jax(pad_to=128, horizons=(5, 21), as_jax=False)
            self.assertEqual(
                j_batch.x_macro.shape,
                (len(j_batch.signal_sessions), v_curr.macro_X.shape[1]),
            )
            self.assertEqual(
                j_batch.y_max_dd.shape, (len(j_batch.signal_sessions), 128, 2)
            )

            # Scorecard & Placebo Survivorship Audit
            sc = continuous_feature_scorecard(v_prev, v_curr, horizon=5)
            self.assertFalse(sc.empty)
            self.assertIn("psi", sc.columns)

            placebo_x = pd.DataFrame(
                {
                    "dividend_yield_benign": np.where(
                        af["asset_id"] == ASSET_3, np.nan, 0.02
                    ),
                    "tainted_vendor_col": np.where(
                        af["asset_id"] == ASSET_3, np.nan, 1.0
                    ),
                    "clean_embed_col": np.ones(len(af), dtype=np.float32),
                }
            )
            audit_df = source_coverage_placebo_audit(ver, X=placebo_x, anchors=af)
            by_feat = audit_df.set_index("feature")
            # Benign accounting zero passes even when correlated with small/exiting stock
            self.assertTrue(bool(by_feat.loc["dividend_yield_benign", "gate_passed"]))
            # Tainted vendor column with 100% missingness on delisted SIVB fails gate!
            self.assertFalse(bool(by_feat.loc["tainted_vendor_col", "gate_passed"]))
            self.assertTrue(bool(by_feat.loc["clean_embed_col", "gate_passed"]))
            self.assertIn("SIVB", audit_df.attrs["landmark_delisted_coverage"])

    def test_publish_ml_run_one_shot_bundle_upload(self) -> None:
        received: dict[str, Any] = {}

        class _PublishHandler(http.server.BaseHTTPRequestHandler):
            def log_message(self, format: str, *args: Any) -> None:
                del format, args

            def do_POST(self) -> None:
                length = int(self.headers.get("Content-Length", "0"))
                raw = self.rfile.read(length)
                received["path"] = self.path
                received["auth"] = self.headers.get("Authorization")
                received["sha_hdr"] = self.headers.get("X-Bundle-Sha256")
                received["json"] = json.loads(raw.decode("utf-8"))
                resp = json.dumps({"ok": True, "version_id": "quant-v0.1"}).encode(
                    "utf-8"
                )
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(resp)))
                self.end_headers()
                self.wfile.write(resp)

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _PublishHandler)
        port = server.server_address[1]
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            # Missing score_formula is rejected up-front
            with self.assertRaisesRegex(ValueError, "score_formula"):
                publish_ml_run(
                    base_url=f"http://127.0.0.1:{port}",
                    write_key="mlw_secret_test",
                    node={"version_id": "quant-v0.1"},
                    run={"run_id": "r1"},
                )

            res = publish_ml_run(
                base_url=f"http://127.0.0.1:{port}",
                write_key="mlw_secret_test",
                node={
                    "version_id": "quant-v0.1",
                    "parent_version_ids": [],
                    "colab_notebook_id": "1SdOZVeSXIMDhgmWkQqs6IKd6QKe4lTmE",
                    "notebook_title": "Quant v0.1 (20261127)",
                    "status": "prod_pinned",
                    "summary": "Clean root baseline",
                },
                run={
                    "run_id": "run-001",
                    "version_id": "quant-v0.1",
                    "dataset_id": "ds-v2",
                    "mode": "lockbox",
                    "period_cadence": "monthly",
                    "score_formula": "0.25*H8_B2 + 0.75*H10_M1c",
                    "accelerator": "tpu_v5e_1",
                    "cu_spent": 1.8,
                },
                forum_post={
                    "post_id": "p-001",
                    "version_id": "quant-v0.1",
                    "title": "Root v0.1 Baseline",
                },
                charts={"decile_ic.svg": "<svg></svg>"},
                bundle_files={"weights.bin": b"\x01\x02\x03\x04"},
            )
            self.assertTrue(res["ok"])
            self.assertEqual(received["path"], "/api/quant/ml/v1/runs:publish")
            self.assertEqual(received["auth"], "Bearer mlw_secret_test")
            body = received["json"]
            comp_bytes = base64.b64decode(body["bundle_zst_b64"])
            self.assertEqual(
                hashlib.sha256(comp_bytes).hexdigest(), received["sha_hdr"]
            )
            tar_raw = unpack_model_bundle_archive(comp_bytes)
            with tarfile.open(fileobj=io.BytesIO(tar_raw), mode="r:") as tf:
                names = set(tf.getnames())
            self.assertIn("run_manifest.json", names)
            self.assertIn("charts/decile_ic.svg", names)
            self.assertIn("artifacts/weights.bin", names)
        finally:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    unittest.main()

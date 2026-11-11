"""Performance smoke benchmark for derived fundamentals state machine and point-in-time joins."""

from __future__ import annotations

import time
from datetime import date, timedelta
from typing import Any

import pandas as pd

from research_datasets import derived_fundamentals, fundamental_states


def _generate_synthetic_material(
    num_issuers: int = 300, filings_per_issuer: int = 44
) -> tuple[dict[str, Any], pd.DataFrame]:
    universe_rows: list[dict[str, Any]] = []
    fact_rows: list[dict[str, Any]] = []
    sample_rows: list[dict[str, Any]] = []

    base_year = 2015
    quarters = [
        (1, (1, 1), (3, 31), (5, 5), "10-Q"),
        (2, (1, 1), (6, 30), (8, 5), "10-Q"),
        (3, (1, 1), (9, 30), (11, 5), "10-Q"),
        (4, (1, 1), (12, 31), (2, 20), "10-K"),
    ]

    for i in range(1, num_issuers + 1):
        cik = f"{i:010d}"
        asset_id = f"00000000-0000-4000-8000-{i:012d}"
        universe_rows.append(
            {
                "asset_id": asset_id,
                "symbol": f"S{i:04d}",
                "cik": cik,
                "issuer_mapping_status": "verified",
            }
        )
        for f_idx in range(filings_per_issuer):
            yr = base_year + (f_idx // 4)
            q_num, (sm, sd), (em, ed), (fm, fd), form = quarters[f_idx % 4]
            filed_yr = yr + 1 if q_num == 4 else yr
            p_start = date(yr, sm, sd).isoformat()
            p_end = date(yr, em, ed).isoformat()
            filed = date(filed_yr, fm, fd).isoformat()
            pub_at = f"{filed}T12:00:00Z"
            acc = f"{cik}-{filed_yr % 100:02d}-{f_idx + 1:06d}"
            scale = float(100 + i + f_idx)

            # Cumulative YTD cash flow, quarterly/annual revenue & net income, balance sheet instant
            if q_num < 4:
                q_start = date(yr, (q_num - 1) * 3 + 1, 1).isoformat()
                fact_rows.append(
                    {
                        "fact_id": f"{acc}-rev-q",
                        "cik": cik,
                        "metric": "revenue",
                        "source": "sec",
                        "taxonomy": "us-gaap",
                        "tag": "Revenues",
                        "tag_priority": 1,
                        "unit": "USD",
                        "currency": "USD",
                        "value": str(scale * 1_000_000.0),
                        "period_start": q_start,
                        "period_end": p_end,
                        "period_kind": "quarter",
                        "form": form,
                        "accession": acc,
                        "filed": filed,
                        "public_at": pub_at,
                        "public_date": filed,
                        "public_time_precision": "second",
                        "observed_at": pub_at,
                        "content_first_seen_at": pub_at,
                        "observation_sequence": 1,
                        "is_retracted": False,
                    }
                )
            else:
                fact_rows.append(
                    {
                        "fact_id": f"{acc}-rev-fy",
                        "cik": cik,
                        "metric": "revenue",
                        "source": "sec",
                        "taxonomy": "us-gaap",
                        "tag": "Revenues",
                        "tag_priority": 1,
                        "unit": "USD",
                        "currency": "USD",
                        "value": str(scale * 4_100_000.0),
                        "period_start": p_start,
                        "period_end": p_end,
                        "period_kind": "annual",
                        "form": form,
                        "accession": acc,
                        "filed": filed,
                        "public_at": pub_at,
                        "public_date": filed,
                        "public_time_precision": "second",
                        "observed_at": pub_at,
                        "content_first_seen_at": pub_at,
                        "observation_sequence": 1,
                        "is_retracted": False,
                    }
                )

            fact_rows.append(
                {
                    "fact_id": f"{acc}-ocf-ytd",
                    "cik": cik,
                    "metric": "operating_cash_flow",
                    "source": "sec",
                    "taxonomy": "us-gaap",
                    "tag": "NetCashProvidedByUsedInOperatingActivities",
                    "tag_priority": 1,
                    "unit": "USD",
                    "currency": "USD",
                    "value": str(scale * q_num * 250_000.0),
                    "period_start": p_start,
                    "period_end": p_end,
                    "period_kind": "annual" if q_num == 4 else "ytd",
                    "form": form,
                    "accession": acc,
                    "filed": filed,
                    "public_at": pub_at,
                    "public_date": filed,
                    "public_time_precision": "second",
                    "observed_at": pub_at,
                    "content_first_seen_at": pub_at,
                    "observation_sequence": 1,
                    "is_retracted": False,
                }
            )
            fact_rows.append(
                {
                    "fact_id": f"{acc}-eq-i",
                    "cik": cik,
                    "metric": "stockholders_equity",
                    "source": "sec",
                    "taxonomy": "us-gaap",
                    "tag": "StockholdersEquity",
                    "tag_priority": 1,
                    "unit": "USD",
                    "currency": "USD",
                    "value": str(scale * 5_000_000.0),
                    "period_start": None,
                    "period_end": p_end,
                    "period_kind": "instant",
                    "form": form,
                    "accession": acc,
                    "filed": filed,
                    "public_at": pub_at,
                    "public_date": filed,
                    "public_time_precision": "second",
                    "observed_at": pub_at,
                    "content_first_seen_at": pub_at,
                    "observation_sequence": 1,
                    "is_retracted": False,
                }
            )

        for m_offset in range(0, 120, 3):
            sig = date(2016, 1, 15) + timedelta(days=m_offset * 30)
            sample_rows.append(
                {
                    "asset_id": asset_id,
                    "signal_session": sig,
                    "decision_at": pd.Timestamp(
                        f"{(sig + timedelta(days=1)).isoformat()}T11:00:00Z"
                    ),
                }
            )

    material = {
        "manifest": {"source_timezones": {"sec": "America/New_York"}},
        "universe": pd.DataFrame(universe_rows),
        "fundamentals": pd.DataFrame(fact_rows),
    }
    return material, pd.DataFrame(sample_rows)


def main() -> None:
    t0 = time.perf_counter()
    material, samples = _generate_synthetic_material(300, 44)
    t_gen = time.perf_counter() - t0

    t1 = time.perf_counter()
    states = fundamental_states(material, time_policy="public_reconstructed")
    t_states = time.perf_counter() - t1

    t2 = time.perf_counter()
    joined = derived_fundamentals(material, samples, time_policy="public_reconstructed")
    t_join = time.perf_counter() - t2

    print(
        f"synthetic_facts={len(material['fundamentals'])} "
        f"states={len(states)} samples={len(joined)} "
        f"gen_s={t_gen:.2f} state_build_s={t_states:.2f} join_s={t_join:.2f}"
    )


if __name__ == "__main__":
    main()

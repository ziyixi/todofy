"""Decision instants, public clocks and their vectorized forms."""

from __future__ import annotations

import unittest

import numpy as np
import pandas as pd

from research_datasets import clocks, events

ASSET = "00000000-0000-4000-8000-000000000002"


def utc(value: str) -> int:
    return int(pd.Timestamp(value).value)


def counts(calendar: clocks.Calendar, rows: list[dict]) -> np.ndarray:
    """sec counts per window of the calendar's sessions (public_reconstructed)."""
    matrices, _ = events.event_matrices(
        pd.DataFrame(rows),
        assets=[ASSET],
        boundaries=calendar.decisions[np.flatnonzero(calendar.decisions != clocks.NAT)],
        policy="public_reconstructed",
        zones={},
    )
    return matrices["sec"].counts[0]


def filing(uid: str, accepted: str, filing_date: str | None) -> dict:
    return {
        "source": "sec",
        "event_uid": uid,
        "observation_sequence": 1,
        "form": "8-K",
        "filing_date": filing_date,
        "asset_ids": [ASSET],
        "public_time_precision": "second",
        "public_at": accepted,
    }


class ClockTest(unittest.TestCase):
    def test_decision_is_0600_new_york_on_entry_session_across_dst(self) -> None:
        calendar = clocks.Calendar(
            ["2026-01-02", "2026-01-05", "2026-03-06", "2026-03-09"]
        )
        # Signal 2026-01-02 enters on 01-05 (EST); signal 03-06 enters on 03-09 (EDT).
        self.assertEqual(calendar.decision_at(1), pd.Timestamp("2026-01-05T11:00Z"))
        self.assertEqual(calendar.decision_at(3), pd.Timestamp("2026-03-09T10:00Z"))
        self.assertTrue(pd.isna(calendar.decision_at(4)))
        live = clocks.Calendar(calendar.days, next_session="2026-03-10")
        self.assertEqual(live.decision_at(4), pd.Timestamp("2026-03-10T10:00Z"))
        for invalid in ("2026-03-09", "2026-03-14"):
            with self.subTest(next_session=invalid), self.assertRaises(ValueError):
                clocks.Calendar(calendar.days, next_session=invalid)
        # The window of signal 03-06 is (06:00 on 03-06, 06:00 on 03-09].
        rows = [
            filing(uid, accepted, None)
            for uid, accepted in (
                ("at-previous", "2026-03-06T11:00:00Z"),
                ("after-previous", "2026-03-06T11:00:01Z"),
                ("at-decision", "2026-03-09T10:00:00Z"),
                ("after-decision", "2026-03-09T10:00:01Z"),
            )
        ]
        self.assertEqual(counts(calendar, rows).tolist(), [0, 1, 2])
        self.assertEqual(calendar.open_at(3), pd.Timestamp("2026-03-09T13:30Z"))
        # observed_content accepts captures until 09:00 New York on the entry session.
        self.assertEqual(
            calendar.capture_deadline(1), pd.Timestamp("2026-01-05T14:00Z")
        )
        self.assertEqual(
            calendar.capture_deadline(3), pd.Timestamp("2026-03-09T13:00Z")
        )
        self.assertTrue(pd.isna(calendar.capture_deadline(4)))
        self.assertEqual(live.capture_deadline(4), pd.Timestamp("2026-03-10T13:00Z"))
        closes = clocks.Calendar(calendar.days, closes={"2026-03-09": "13:00"})
        self.assertEqual(closes.close_at(3), pd.Timestamp("2026-03-09T17:00Z"))
        self.assertEqual(closes.close_at(2), pd.Timestamp("2026-03-06T21:00Z"))

    def test_sec_public_is_max_of_acceptance_and_filing_date_0600(self) -> None:
        cases = [
            # Accepted Friday 18:10 New York; SEC dated it Monday: public Monday 06:00.
            ("late", "2026-03-06T23:10:00Z", "2026-03-09", "2026-03-09T10:00:00Z"),
            # Accepted Tuesday 07:15 inside the business day: the acceptance instant.
            ("morning", "2026-03-10T11:15:00Z", "2026-03-10", "2026-03-10T11:15:00Z"),
            # Columbus Day: markets open, SEC closed; filing date is the next day.
            ("holiday", "2026-10-12T14:00:00Z", "2026-10-13", "2026-10-13T10:00:00Z"),
            ("undated", "2026-03-06T23:10:00Z", None, "2026-03-06T23:10:00Z"),
        ]
        frame = pd.DataFrame(
            [filing(uid, accepted, date) for uid, accepted, date, _ in cases]
        )
        public, invalid = clocks.public_clocks(frame, {})
        for row, (uid, _, _, expected) in zip(frame.to_dict("records"), cases):
            with self.subTest(case=uid):
                self.assertEqual(clocks.public_clock(row, {}), pd.Timestamp(expected))
        self.assertEqual(public.tolist(), [utc(case[3]) for case in cases])
        self.assertFalse(invalid.any())
        # Facts carry the date as filed; news ignores SEC dates.
        fact = {**filing("fact", cases[0][1], None), "filed": "2026-03-09"}
        news = {**filing("news", cases[0][1], "2026-03-09"), "source": "alpaca_news"}
        public, _ = clocks.public_clocks(pd.DataFrame([fact, news]), {})
        self.assertEqual(public.tolist(), [utc(cases[0][3]), utc(cases[0][1])])
        # The late Friday filing counts in the window decided Monday 06:00 (signal Fri).
        calendar = clocks.Calendar(["2026-03-05", "2026-03-06", "2026-03-09"])
        self.assertEqual(counts(calendar, [filing(*cases[0][:3])]).tolist(), [0, 1])

    def test_date_precision_uses_next_midnight_in_source_zone_never_event_date(
        self,
    ) -> None:
        rows = [
            {"source": "finnhub_news", "public_time_precision": "date"},
            {"source": "alpaca_news", "public_time_precision": "date"},
            {"source": "alpaca_news", "public_time_precision": "unknown"},
            {
                "source": "alpaca_news",
                "public_time_precision": "date",
                "public_date": "",
            },
        ]
        frame = pd.DataFrame(rows)
        frame["public_date"] = ["2026-03-06", "2026-03-06", "2026-03-06", ""]
        frame["event_date"] = "2026-03-06"
        zones = {"finnhub_news": "Asia/Tokyo"}
        public, invalid = clocks.public_clocks(frame, zones)
        expected = ["2026-03-06T15:00:00Z", "2026-03-07T05:00:00Z"]
        self.assertEqual(public[:2].tolist(), [utc(value) for value in expected])
        self.assertEqual(public[2:].tolist(), [clocks.NAT, clocks.NAT])
        self.assertEqual(invalid.tolist(), [False, False, False, True])
        for row, value in zip(frame.to_dict("records"), public):
            scalar = clocks.public_clock(row, zones)
            self.assertEqual(clocks.NAT if scalar is None else scalar.value, value)

    def test_vectorized_instants_match_scalar_clock(self) -> None:
        values = [
            "2026-03-06T20:00:00Z",
            "2026-03-06T15:00:00-05:00",
            "2026-03-06T20:00:00.123456789+00:00",
            "2026-03-06 20:00:00+00:00",
            "2026-03-06T20:00:00",
            "not a time",
            "",
            None,
            np.nan,
            pd.Timestamp("2026-03-06T20:00:00Z"),
            pd.Timestamp("2026-03-06T20:00:00"),
        ]
        expected = [
            clocks.NAT if clock is None else clock.value
            for clock in map(clocks.clock, values)
        ]
        self.assertEqual(
            clocks.instants(np.array(values, dtype=object)).tolist(), expected
        )
        self.assertEqual(
            expected[:4], [utc("2026-03-06T20:00:00Z")] * 2 + expected[2:4]
        )
        public = np.array(
            [clocks.NAT, utc("2026-03-06T20:00Z"), utc("2026-03-06T20:00Z")]
        )
        capture = np.array(
            [utc("2026-03-06T23:00Z"), clocks.NAT, utc("2026-03-07T02:00Z")]
        )
        invalid = np.array([False, False, False])
        observed = clocks.available_at(public, invalid, "observed_content", (capture,))
        self.assertEqual(
            observed.tolist(),
            [utc("2026-03-06T20:00Z"), clocks.NAT, utc("2026-03-06T23:00Z")],
        )
        invalid[2] = True
        self.assertEqual(
            clocks.available_at(public, invalid, "observed_content", (capture,))[2],
            clocks.NAT,
        )
        reconstructed = clocks.available_at(public, invalid, "public_reconstructed")
        self.assertEqual(reconstructed.tolist(), public.tolist())


if __name__ == "__main__":
    unittest.main()

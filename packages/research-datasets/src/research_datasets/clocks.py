"""Calendar, decision instants and public clocks: one 06:00 New York rule for history and live use.

A row (asset, signal session T) is decided at 06:00 New York on its entry session t and
sees what was public at or before that instant. Instants are UTC; vectorized helpers use
int64 nanoseconds with ``NAT`` for a missing clock.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Mapping, Sequence
from datetime import date, datetime, time, timedelta
from functools import lru_cache
from typing import Any
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd

from .constants import (
    CAPTURE_GRACE,
    DECISION_TIME,
    LABEL_CLOSE_TIME,
    LABEL_OPEN_TIME,
    NEW_YORK_ZONE,
    POLICIES,
    SEC_DISSEMINATION_START,
    SOURCE_CONTRACTS,
)

NEW_YORK = ZoneInfo(NEW_YORK_ZONE)
NAT = np.iinfo(np.int64).min  # int64 view of NaT; earlier than every instant
NEVER = np.iinfo(np.int64).max  # later than every instant
GRACE_NS = int(CAPTURE_GRACE / timedelta(microseconds=1)) * 1000
CAPTURE_DEADLINE = (
    datetime.combine(date(2000, 1, 3), DECISION_TIME) + CAPTURE_GRACE
).time()
_ISO_INSTANT = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$"
)
_EPOCH_ORDINAL = date(1970, 1, 1).toordinal()
_DAY_NS = 86_400_000_000_000


@lru_cache(maxsize=65536)
def day_str(value: str) -> date:
    return date.fromisoformat(value[:10])


def day(value: Any) -> date:
    if isinstance(value, date) and not isinstance(value, datetime):
        return value
    return day_str(str(value))


@lru_cache(maxsize=131072)
def _clock_str(value: str) -> pd.Timestamp | None:
    try:
        parsed = pd.Timestamp(value)
    except (TypeError, ValueError):
        return None
    if pd.isna(parsed) or parsed.tzinfo is None:
        return None
    return parsed.tz_convert("UTC")


def clock(value: Any) -> pd.Timestamp | None:
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
def at(value: date, hour: int, minute: int = 0) -> pd.Timestamp:
    """A New York wall time on a date, as a UTC instant."""
    return pd.Timestamp(
        datetime.combine(value, time(hour, minute), NEW_YORK)
    ).tz_convert("UTC")


def decision_at(value: date) -> pd.Timestamp:
    return at(value, DECISION_TIME.hour, DECISION_TIME.minute)


def policy(time_policy: str) -> str:
    if time_policy not in POLICIES:
        raise ValueError(
            "Choose an explicit supported time policy: " + " or ".join(POLICIES)
        )
    return time_policy


def mapping(value: Any) -> dict[str, Any]:
    """An Arrow MAP cell (dict, pairs or key/value records) as a dict."""
    if isinstance(value, Mapping):
        return dict(value)
    if isinstance(value, (list, tuple, np.ndarray)):
        return dict(
            (item["key"], item["value"]) if isinstance(item, Mapping) else item
            for item in value
        )
    return {}


def date_field(row: Mapping[str, Any], *names: str) -> date | None:
    """The first present YYYY-MM-DD field; a malformed present value gives None."""
    for name in names:
        value = row.get(name)
        if isinstance(value, str) and value:
            try:
                return day_str(value)
            except ValueError:
                return None
    return None


def source_zone(source: str, zones: Mapping[str, str]) -> ZoneInfo:
    contract = SOURCE_CONTRACTS.get(source)
    for name in (zones.get(source), contract.timezone if contract else NEW_YORK_ZONE):
        if name:
            try:
                return ZoneInfo(name)
            except (ValueError, KeyError):
                continue
    return NEW_YORK


def sec_floor(filing_date: date) -> pd.Timestamp:
    """SEC disseminates a filing from 06:00 New York on its SEC filing date."""
    return at(filing_date, SEC_DISSEMINATION_START.hour, SEC_DISSEMINATION_START.minute)


def sec_public(accepted: pd.Timestamp, filing_date: date) -> pd.Timestamp:
    """SEC dates filings accepted after 17:30 or on non-business days to the next
    business day, so the public instant is max(acceptance, 06:00 on the filing date)."""
    return max(accepted, sec_floor(filing_date))


def _next_midnight(value: Any, zone: str) -> pd.Timestamp | None:
    try:
        following = day(value) + timedelta(days=1)
        return pd.Timestamp(
            datetime.combine(following, time(), ZoneInfo(zone))
        ).tz_convert("UTC")
    except (ValueError, KeyError):
        return None


def public_clock(
    row: Mapping[str, Any], zones: Mapping[str, str]
) -> pd.Timestamp | None:
    """One row's public instant (scalar form of ``public_clocks``)."""
    precision = row.get("public_time_precision")
    if not isinstance(precision, str):
        return None
    source = str(row.get("source", ""))
    contract = SOURCE_CONTRACTS.get(source)
    if precision == "second":
        public = clock(row.get("public_at"))
        if (
            public is not None
            and contract is not None
            and contract.clock == "sec_filing"
        ):
            filed = date_field(row, "filing_date", "filed")
            if filed is not None:
                public = sec_public(public, filed)
        return public
    if precision != "date":
        return None
    public_date = row.get("public_date")
    if public_date is None or pd.isna(public_date) or public_date == "":
        return None
    zone = zones.get(source) or (contract.timezone if contract else None)
    return _next_midnight(public_date, zone) if zone else None


# --- vectorized forms -------------------------------------------------------------


def nanos(values: Any) -> np.ndarray:
    """UTC instants (DatetimeIndex-like) as int64 nanoseconds, NaT -> NAT."""
    index = pd.DatetimeIndex(values)
    if index.tz is None:
        index = index.tz_localize("UTC")
    return index.as_unit("ns").asi8.copy()


def _ns(value: pd.Timestamp | None) -> int:
    return NAT if value is None else int(value.as_unit("ns").value)


def map_unique(values: Any, function: Callable[[Any], int]) -> np.ndarray:
    """Apply a scalar int64 function once per distinct non-null value."""
    codes, uniques = pd.factorize(pd.Series(values, dtype=object))
    mapped = np.fromiter((function(value) for value in uniques), np.int64, len(uniques))
    result = np.full(len(codes), NAT, dtype=np.int64)
    known = codes >= 0
    result[known] = mapped[codes[known]]
    return result


def instants(values: Any) -> np.ndarray:
    """Offset-bearing timestamps as UTC int64 nanoseconds; anything else is NAT."""
    series = pd.Series(values)
    if isinstance(series.dtype, pd.DatetimeTZDtype):
        return nanos(series)
    if pd.api.types.is_datetime64_dtype(series.dtype):
        return np.full(len(series), NAT, dtype=np.int64)
    cells = series.to_numpy(dtype=object)
    text = np.fromiter((isinstance(value, str) for value in cells), bool, len(cells))
    fast = np.zeros(len(cells), dtype=bool)
    if text.any():
        fast[text] = pd.Series(cells[text], dtype=object).str.match(_ISO_INSTANT)
    result = np.full(len(cells), NAT, dtype=np.int64)
    if fast.any():
        result[fast] = nanos(
            pd.to_datetime(cells[fast], utc=True, format="ISO8601", errors="coerce")
        )
    slow = ~fast
    if slow.any():
        result[slow] = map_unique(cells[slow], lambda value: _ns(clock(value)))
    return result


def _first_text(frame: pd.DataFrame, names: Sequence[str]) -> np.ndarray:
    """Per row, the first column among ``names`` holding a non-empty string."""
    chosen = np.full(len(frame), None, dtype=object)
    for name in reversed(names):
        if name in frame.columns:
            cells = frame[name].to_numpy(dtype=object)
            present = np.fromiter(
                (isinstance(value, str) and value != "" for value in cells),
                bool,
                len(cells),
            )
            chosen[present] = cells[present]
    return chosen


def _day_or_none(value: Any) -> date | None:
    try:
        return day_str(value)
    except ValueError:
        return None


def date_ordinals(frame: pd.DataFrame, names: Sequence[str]) -> np.ndarray:
    """``date_field`` per row as a proleptic ordinal, 0 when absent or malformed."""

    def ordinal(value: Any) -> int:
        parsed = _day_or_none(value)
        return 0 if parsed is None else parsed.toordinal()

    result = map_unique(_first_text(frame, names), ordinal)
    result[result == NAT] = 0
    return result


def _sec_floor(value: Any) -> int:
    parsed = _day_or_none(value)
    return NAT if parsed is None else _ns(sec_floor(parsed))


def public_clocks(
    frame: pd.DataFrame, zones: Mapping[str, str]
) -> tuple[np.ndarray, np.ndarray]:
    """Public instants (int64 ns, NAT when unknown) and invalid declared clocks per row.

    Second precision parses ``public_at`` (offset required); SEC-clock sources take
    max(acceptance, 06:00 New York on ``filing_date`` or ``filed``). Date precision is
    the next midnight in the source's zone. A declared precision whose value cannot be
    read is invalid.
    """
    rows = len(frame)
    public = np.full(rows, NAT, dtype=np.int64)
    if rows == 0 or "public_time_precision" not in frame.columns:
        return public, np.zeros(rows, dtype=bool)
    precision = frame["public_time_precision"].to_numpy(dtype=object)
    sources = (
        frame["source"].astype(str).to_numpy(dtype=object)
        if "source" in frame.columns
        else np.full(rows, "", dtype=object)
    )
    second, dated = precision == "second", precision == "date"
    if second.any() and "public_at" in frame.columns:
        public[second] = instants(frame["public_at"].to_numpy(dtype=object)[second])
        sec = second & np.isin(
            sources,
            [
                name
                for name, item in SOURCE_CONTRACTS.items()
                if item.clock == "sec_filing"
            ],
        )
        sec &= public != NAT
        if sec.any():
            floors = map_unique(
                _first_text(frame.loc[sec], ("filing_date", "filed")), _sec_floor
            )
            public[sec] = np.maximum(public[sec], floors)
    if dated.any() and "public_date" in frame.columns:
        cells = frame["public_date"].to_numpy(dtype=object)[dated]
        zone_of = {
            source: zones.get(source)
            or (
                SOURCE_CONTRACTS[source].timezone
                if source in SOURCE_CONTRACTS
                else None
            )
            for source in set(sources[dated])
        }
        pairs = [
            None
            if value is None
            or value == ""
            or (not isinstance(value, date) and pd.isna(value))
            or not zone_of[source]
            else (value, zone_of[source])
            for value, source in zip(cells, sources[dated])
        ]
        public[dated] = map_unique(
            pairs, lambda pair: _ns(_next_midnight(pair[0], pair[1]))
        )
    invalid = (second | dated) & (public == NAT)
    return public, invalid


def available_at(
    public: np.ndarray,
    invalid: np.ndarray,
    time_policy: str,
    captures: Sequence[np.ndarray] = (),
) -> np.ndarray:
    """When a row may be used: its public clock, or under observed_content
    max(public, each capture - CAPTURE_GRACE), missing when a capture is missing or a
    declared public clock is invalid."""
    if policy(time_policy) == "public_reconstructed":
        return public.copy()
    result = public.copy()
    complete = ~invalid
    for capture in captures:
        complete &= capture != NAT
        result = np.maximum(result, np.where(capture != NAT, capture - GRACE_NS, NAT))
    return np.where(complete, result, NAT)


def wall_instants(days: Sequence[date], wall: time) -> np.ndarray:
    """A New York wall time on each day as UTC int64 nanoseconds."""
    local = np.array(list(days), dtype="datetime64[D]").astype("datetime64[ns]")
    local = local + np.timedelta64(wall.hour * 60 + wall.minute, "m")
    return nanos(pd.DatetimeIndex(local).tz_localize(NEW_YORK))


def local_ordinals(values: np.ndarray, zone: ZoneInfo) -> np.ndarray:
    """Calendar dates (ordinals) of UTC int64 instants in a zone."""
    local = pd.DatetimeIndex(values.astype("datetime64[ns]"), tz="UTC").tz_convert(zone)
    return local.tz_localize(None).as_unit("ns").asi8 // _DAY_NS + _EPOCH_ORDINAL


class Calendar:
    """Frozen sessions, their 06:00 decision instants, opens and closes.

    ``closes`` maps a session to its close ("HH:MM", default 16:00). ``next_session``
    (live use) is a weekday after the last frozen session that gives the last signal a
    decision instant; it is never a signal itself.
    """

    def __init__(
        self,
        sessions: Sequence[Any],
        closes: Mapping[str, str] | None = None,
        next_session: Any = None,
    ) -> None:
        self.days: list[date] = [day(value) for value in sessions]
        if not self.days or self.days != sorted(set(self.days)):
            raise ValueError(
                "Frozen calendar must contain unique ordered session dates"
            )
        self.next_session = None if next_session is None else day(next_session)
        if self.next_session is not None and (
            self.next_session <= self.days[-1] or self.next_session.weekday() > 4
        ):
            raise ValueError("next_session must be a weekday after the last session")
        self._index = {value: position for position, value in enumerate(self.days)}
        self._closes = {
            day(key): time.fromisoformat(value) for key, value in (closes or {}).items()
        }
        following = [] if self.next_session is None else [self.next_session]
        # decisions[i] = 06:00 New York on session i; one more entry for the session
        # after the last (NAT unless next_session is known).
        self.decisions = wall_instants([*self.days, *following], DECISION_TIME)
        if not following:
            self.decisions = np.append(self.decisions, np.int64(NAT))

    def __len__(self) -> int:
        return len(self.days)

    def index(self, value: Any) -> int:
        try:
            return self._index[day(value)]
        except KeyError:
            raise ValueError(f"{value} is not a frozen session") from None

    def decision_at(self, position: int) -> pd.Timestamp:
        """06:00 New York on session ``position`` (NaT past the known sessions)."""
        value = self.decisions[position] if position < len(self.decisions) else NAT
        return pd.NaT if value == NAT else pd.Timestamp(int(value), tz="UTC")

    def capture_deadline(self, position: int) -> pd.Timestamp:
        """09:00 New York on session ``position``: the latest capture observed_content
        accepts for that decision (NaT past the known sessions)."""
        decision = self.decision_at(position)
        return decision if pd.isna(decision) else decision + CAPTURE_GRACE

    def open_at(self, position: int) -> pd.Timestamp:
        return at(self.days[position], LABEL_OPEN_TIME.hour, LABEL_OPEN_TIME.minute)

    def close_at(self, position: int) -> pd.Timestamp:
        value = self.days[position]
        close = self._closes.get(value, LABEL_CLOSE_TIME)
        return at(value, close.hour, close.minute)

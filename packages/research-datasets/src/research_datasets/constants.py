"""Frozen research dataset constants, read contracts, family registry and metric maps."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from datetime import time, timedelta
from types import MappingProxyType

__version__ = "2.0.0rc1"
API = "v1"

# The newest manifest layout this SDK reads; client_min_version is checked separately.
MANIFEST_SCHEMA_MAX = 3
NEW_YORK_ZONE = "America/New_York"
POLICIES: tuple[str, ...] = ("public_reconstructed", "observed_content")
TIME_POLICY_VERSION = 2
# One information cutoff for history and live use: a row (asset, signal session T) is
# decided at 06:00 New York on the entry session t and sees what was public at or
# before that instant. Its event window is (06:00 on T, 06:00 on t].
DECISION_TIME = time(6, 0)
# observed_content also needs each capture by 09:00 New York on t (06:00 + 3 h).
CAPTURE_GRACE = timedelta(hours=3)
# SEC disseminates a filing no earlier than 06:00 New York on its filing date.
SEC_DISSEMINATION_START = time(6, 0)
LABEL_OPEN_TIME = time(9, 30)
LABEL_CLOSE_TIME = time(16, 0)
# Articles of one story (same story key) within this span count once per security.
STORY_WINDOW = timedelta(hours=72)
RANK_WINDOW_SESSIONS = 21

# Candidates and labels.
SAMPLINGS: tuple[str, ...] = ("daily", "weekly", "monthly")
DEFAULT_HORIZONS: tuple[int, ...] = (5, 21, 63, 126)
MAX_HORIZON = 756
# Monthly point-in-time membership rule used when universe="pit".
DEFAULT_UNIVERSE_RULE = "pit-largecap-v1"
# Default candidate sets keep these security types when the universe records one.
CANDIDATE_SECURITY_TYPES = frozenset({"common", "common_presumed"})
# Reader assumption for an exit whose terminal value is not a stored fact: a performance
# delisting loses 30 % from the last close (Shumway 1997); None masks the label.
DEFAULT_TERMINAL_POLICY: Mapping[str, float | None] = MappingProxyType(
    {"performance": -0.30, "unknown": None}
)
# Neutralized labels fall back to the session mean below this many group members.
NEUTRAL_MIN_GROUP = 5
SIZE_GROUPS = 5

FIELDS: tuple[str, ...] = (
    "asset_id",
    "symbol",
    "adjustment",
    "date",
    "open",
    "high",
    "low",
    "close",
    "volume",
    "vwap",
    "trade_count",
    "source_asof",
)


@dataclass(frozen=True)
class SourceContract:
    """How the reader understands one event source."""

    clock: str  # "sec_filing" | "provider" | "none"
    timezone: str  # date-precision zone unless the manifest names another
    counts: bool  # produces count and coverage features
    countable_partial: frozenset[str] = frozenset()  # partial codes still countable
    read_complete_codes: frozenset[str] = (
        frozenset()
    )  # countable, labelled read_complete
    count_forms: frozenset[str] | None = None  # form filter of the count feature


# The meaning of the sec count features stays the pre-2.0 form set in every version;
# newer forms feed only dedicated event specifications.
LEGACY_SEC_COUNT_FORMS = frozenset({"8-K", "10-K", "10-Q", "6-K", "20-F"})
_HISTORY_LIMIT = frozenset({"SOURCE_HISTORY_LIMIT"})

SOURCE_CONTRACTS: dict[str, SourceContract] = {
    "sec": SourceContract(
        "sec_filing",
        NEW_YORK_ZONE,
        True,
        _HISTORY_LIMIT,
        count_forms=LEGACY_SEC_COUNT_FORMS,
    ),
    # Exhibit text for later features only: the filing itself is already counted by sec.
    "sec_earnings_release": SourceContract(
        "sec_filing", NEW_YORK_ZONE, False, _HISTORY_LIMIT
    ),
    "alpaca_news": SourceContract(
        "provider",
        NEW_YORK_ZONE,
        True,
        _HISTORY_LIMIT,
        frozenset({"SOURCE_PUBLICATION_COVERAGE_UNKNOWN"}),
    ),
    "finnhub_news": SourceContract("provider", NEW_YORK_ZONE, True, _HISTORY_LIMIT),
    # Calendar rows without a publication clock: no count features.
    "alpaca_actions": SourceContract("none", NEW_YORK_ZONE, False),
    "finnhub_earnings": SourceContract("none", NEW_YORK_ZONE, False),
}
# Readable sources. Rows of any other source are skipped and counted, never fatal.
SOURCES: tuple[str, ...] = tuple(SOURCE_CONTRACTS)
COUNT_SOURCES: tuple[str, ...] = tuple(
    name for name, contract in SOURCE_CONTRACTS.items() if contract.counts
)

# Coverage classes of a source check (status + error code):
# countable (checked/empty/not_changed without a code, the contract's partial codes),
# veto (identity cannot prove the security's ticker or issuer for the window),
# na (the security had no own session in the window), soft (every other windowed
# partial or failure) and unbounded (no window). Countable, veto and na checks repaint
# days in check order; soft checks repaint only days that are not countable.
VETO_CODES = frozenset(
    {"SOURCE_SYMBOL_UNVERIFIED", "SEC_PREDECESSOR_UNMAPPED", "IDENTITY_REFETCH_PENDING"}
)
NOT_LISTED_CODES = frozenset({"IDENTITY_NOT_LISTED"})


@dataclass(frozen=True)
class FamilySpec:
    """How the reader filters one frozen data family."""

    identity: str  # "asset_id" | "cik" | "none"
    part_clock: str | None  # clock indexed in part_index for date pruning
    schema_versions: frozenset[int]
    evaluation_only: bool = False  # never joinable as a feature


_V1 = frozenset({1})
FAMILY_SPECS: dict[str, FamilySpec] = {
    "events": FamilySpec("asset_id", "event_date", frozenset({1, 2})),
    "event_observations": FamilySpec("asset_id", "observation_recorded_at", _V1),
    "source_checks": FamilySpec("asset_id", "checked_at", _V1),
    "price_coverage": FamilySpec("asset_id", None, _V1),
    "security_history": FamilySpec("asset_id", "observed_at", _V1),
    "earnings_observations": FamilySpec("asset_id", "observed_at", _V1),
    "fundamentals": FamilySpec("cik", None, _V1),
    "financial_checks": FamilySpec("cik", "checked_at", _V1),
    "symbol_history": FamilySpec("asset_id", None, _V1),
    "issuer_history": FamilySpec("asset_id", None, _V1),
    "news_versions": FamilySpec("none", "observed_at", _V1),
    # Label inputs: monthly membership, exits and total-return series.
    "universe_membership": FamilySpec("asset_id", "effective_from", _V1),
    "delistings": FamilySpec("asset_id", "observed_at", _V1),
    "daily_returns": FamilySpec("asset_id", "date", _V1),
}
DATA_FAMILIES: tuple[str, ...] = tuple(FAMILY_SPECS)

KEYS: list[str] = ["asset_id", "signal_session"]

DURATION_METRICS: dict[str, str] = {
    "revenue": "USD",
    "gross_profit": "USD",
    "operating_income": "USD",
    "net_income": "USD",
    "operating_cash_flow": "USD",
    "capex": "USD",
    "diluted_eps": "USD/shares",
    "weighted_average_shares_basic": "shares",
    "weighted_average_shares_diluted": "shares",
}

INSTANT_METRICS: dict[str, str] = {
    "cash": "USD",
    "total_assets": "USD",
    "total_liabilities": "USD",
    "equity": "USD",
    "shares_outstanding": "shares",
}

ALL_METRICS: dict[str, str] = {
    **DURATION_METRICS,
    **INSTANT_METRICS,
}

RATIO_METRICS: tuple[str, ...] = (
    "gross_margin",
    "operating_margin",
    "net_margin",
    "free_cash_flow",
    "free_cash_flow_margin",
    "revenue_yoy",
)

# 10-Q cash-flow statements are year-to-date, so a "quarter" value of these metrics is
# up to a year old. Default quarterly columns omit them until derived quarters exist;
# explicit requests still return them.
QUARTER_DEFAULT_EXCLUDED_METRICS: tuple[str, ...] = ("operating_cash_flow", "capex")
QUARTER_DEFAULT_EXCLUDED_RATIOS: tuple[str, ...] = (
    "free_cash_flow",
    "free_cash_flow_margin",
)

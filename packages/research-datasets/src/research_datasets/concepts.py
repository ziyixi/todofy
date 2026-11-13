"""Public XBRL financial statement concept catalogue, composite definitions, and view rules."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from types import MappingProxyType

DERIVATION_VERSION = "fundamentals-derived-v2"

PERIODIC_ANNUAL_FORMS: frozenset[str] = frozenset({"10-K", "10-KT", "20-F", "40-F"})
PERIODIC_QUARTER_FORMS: frozenset[str] = frozenset({"10-Q", "10-QT"})
PERIODIC_FORMS: frozenset[str] = frozenset(
    {
        *PERIODIC_ANNUAL_FORMS,
        *PERIODIC_QUARTER_FORMS,
        *(f"{form}/A" for form in (*PERIODIC_ANNUAL_FORMS, *PERIODIC_QUARTER_FORMS)),
    }
)

STALE_AFTER_DAYS: Mapping[str, int] = MappingProxyType(
    {
        "q": 200,
        "ttm": 200,
        "i": 200,
        "fy": 460,
        "quarter": 200,
        "instant": 200,
        "annual": 460,
    }
)

FUNDAMENTAL_STATUSES: tuple[str, ...] = (
    "ok",
    "stale",
    "approximate",
    "not_yet_available",
    "metric_missing",
    "not_captured",
    "not_checked",
    "mapping_missing",
    "period_unavailable",
    "annual_only",
    "ambiguous",
    "unit_unavailable",
    "invalid_value",
    "issuer_not_sec_filer",
    "prior_unavailable",
    "unverified_prior_period",
    "zero_prior",
    "nonpositive_prior",
    "period_mismatch",
    "fx_unavailable",
    "price_unavailable",
    "shares_unavailable",
    "class_shares_unavailable",
    "split_unverified",
)


@dataclass(frozen=True)
class Concept:
    """One base XBRL financial concept mapped from ordered (taxonomy, tag) pairs."""

    name: str
    kind: str  # "duration" | "instant"
    unit_kind: str  # "money" | "shares" | "per_share"
    additive: bool
    tags: tuple[tuple[str, str], ...]
    min_parser: int  # 1 for concepts covered by v1 tag set, 2 for expanded v2 tags


@dataclass(frozen=True)
class CompositeSpec:
    """One period-level composite rule evaluated over base concepts."""

    name: str
    kind: str  # "duration" | "instant"
    unit_kind: str  # "money" | "shares" | "per_share"
    additive: bool
    inputs: tuple[str, ...]
    bases: tuple[str, ...]
    min_parser: int


def _us(*tags: str) -> tuple[tuple[str, str], ...]:
    return tuple(("us-gaap", tag) for tag in tags)


def _tags(*entries: str | tuple[str, str]) -> tuple[tuple[str, str], ...]:
    result: list[tuple[str, str]] = []
    for entry in entries:
        if isinstance(entry, tuple):
            result.append(entry)
        else:
            result.append(("us-gaap", entry))
    return tuple(result)


_BASE_CONCEPTS: tuple[Concept, ...] = (
    # --- Duration / money (additive) ---
    Concept(
        "revenue_total",
        "duration",
        "money",
        True,
        _tags(
            "Revenues",
            "RevenuesNetOfInterestExpense",
            "SalesRevenueNet",
            "RegulatedAndUnregulatedOperatingRevenue",
            ("ifrs-full", "Revenue"),
        ),
        1,
    ),
    Concept(
        "revenue_contracts",
        "duration",
        "money",
        True,
        _tags(
            "RevenueFromContractWithCustomerExcludingAssessedTax",
            "RevenueFromContractWithCustomerIncludingAssessedTax",
            ("ifrs-full", "RevenueFromContractsWithCustomers"),
        ),
        1,
    ),
    Concept(
        "cost_of_revenue",
        "duration",
        "money",
        True,
        _tags(
            "CostOfRevenue",
            "CostOfGoodsAndServicesSold",
            "CostOfGoodsSold",
            ("ifrs-full", "CostOfSales"),
        ),
        2,
    ),
    Concept(
        "gross_profit",
        "duration",
        "money",
        True,
        _tags("GrossProfit", ("ifrs-full", "GrossProfit")),
        1,
    ),
    Concept(
        "sga",
        "duration",
        "money",
        True,
        _us("SellingGeneralAndAdministrativeExpense"),
        2,
    ),
    Concept(
        "rnd",
        "duration",
        "money",
        True,
        _us(
            "ResearchAndDevelopmentExpense",
            "ResearchAndDevelopmentExpenseExcludingAcquiredInProcessCost",
        ),
        2,
    ),
    Concept(
        "operating_income",
        "duration",
        "money",
        True,
        _tags(
            "OperatingIncomeLoss", ("ifrs-full", "ProfitLossFromOperatingActivities")
        ),
        1,
    ),
    Concept(
        "interest_expense",
        "duration",
        "money",
        True,
        _us("InterestExpense", "InterestExpenseNonoperating", "InterestExpenseDebt"),
        2,
    ),
    Concept(
        "pretax_income",
        "duration",
        "money",
        True,
        _tags(
            "IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest",
            "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments",
            ("ifrs-full", "ProfitLossBeforeTax"),
        ),
        2,
    ),
    Concept(
        "income_tax",
        "duration",
        "money",
        True,
        _tags(
            "IncomeTaxExpenseBenefit",
            ("ifrs-full", "IncomeTaxExpenseContinuingOperations"),
        ),
        2,
    ),
    Concept(
        "net_income_parent",
        "duration",
        "money",
        True,
        _tags("NetIncomeLoss", ("ifrs-full", "ProfitLossAttributableToOwnersOfParent")),
        1,
    ),
    Concept(
        "net_income_total",
        "duration",
        "money",
        True,
        _tags("ProfitLoss", ("ifrs-full", "ProfitLoss")),
        1,
    ),
    Concept(
        "net_income_nci",
        "duration",
        "money",
        True,
        _tags(
            "NetIncomeLossAttributableToNoncontrollingInterest",
            ("ifrs-full", "ProfitLossAttributableToNoncontrollingInterests"),
        ),
        2,
    ),
    Concept(
        "net_income_common",
        "duration",
        "money",
        True,
        _us("NetIncomeLossAvailableToCommonStockholdersBasic"),
        2,
    ),
    Concept(
        "d_and_a",
        "duration",
        "money",
        True,
        _tags(
            "DepreciationDepletionAndAmortization",
            "DepreciationAndAmortization",
            ("ifrs-full", "DepreciationAndAmortisationExpense"),
        ),
        2,
    ),
    Concept(
        "stock_comp",
        "duration",
        "money",
        True,
        _us("ShareBasedCompensation", "AllocatedShareBasedCompensationExpense"),
        2,
    ),
    Concept(
        "interest_income",
        "duration",
        "money",
        True,
        _us("InterestAndDividendIncomeOperating"),
        2,
    ),
    Concept(
        "net_interest_income",
        "duration",
        "money",
        True,
        _us("InterestIncomeExpenseNet"),
        2,
    ),
    Concept(
        "noninterest_income",
        "duration",
        "money",
        True,
        _us("NoninterestIncome"),
        2,
    ),
    Concept(
        "noninterest_expense",
        "duration",
        "money",
        True,
        _us("NoninterestExpense"),
        2,
    ),
    Concept(
        "credit_loss_provision",
        "duration",
        "money",
        True,
        _us("ProvisionForLoanLeaseAndOtherLosses", "ProvisionForLoanAndLeaseLosses"),
        2,
    ),
    Concept(
        "premiums_earned",
        "duration",
        "money",
        True,
        _us("PremiumsEarnedNet"),
        2,
    ),
    Concept(
        "operating_cash_flow",
        "duration",
        "money",
        True,
        _tags(
            "NetCashProvidedByUsedInOperatingActivities",
            "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations",
            ("ifrs-full", "CashFlowsFromUsedInOperatingActivities"),
        ),
        1,
    ),
    Concept(
        "investing_cash_flow",
        "duration",
        "money",
        True,
        _us("NetCashProvidedByUsedInInvestingActivities"),
        2,
    ),
    Concept(
        "financing_cash_flow",
        "duration",
        "money",
        True,
        _us("NetCashProvidedByUsedInFinancingActivities"),
        2,
    ),
    Concept(
        "capex",
        "duration",
        "money",
        True,
        _tags(
            "PaymentsToAcquirePropertyPlantAndEquipment",
            "PaymentsToAcquireProductiveAssets",
            (
                "ifrs-full",
                "PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities",
            ),
        ),
        1,
    ),
    Concept(
        "dividends_paid",
        "duration",
        "money",
        True,
        _tags(
            "PaymentsOfDividendsCommonStock",
            "PaymentsOfDividends",
            ("ifrs-full", "DividendsPaidClassifiedAsFinancingActivities"),
        ),
        2,
    ),
    Concept(
        "repurchases",
        "duration",
        "money",
        True,
        _tags(
            "PaymentsForRepurchaseOfCommonStock",
            ("ifrs-full", "PaymentsToAcquireOrRedeemEntitysShares"),
        ),
        2,
    ),
    Concept(
        "stock_issuance",
        "duration",
        "money",
        True,
        _us("ProceedsFromIssuanceOfCommonStock"),
        2,
    ),
    # --- Duration / non-additive ---
    Concept(
        "eps_diluted",
        "duration",
        "per_share",
        False,
        _tags(
            "EarningsPerShareDiluted",
            ("ifrs-full", "DilutedEarningsLossPerShare"),
        ),
        1,
    ),
    Concept(
        "eps_basic",
        "duration",
        "per_share",
        False,
        _tags("EarningsPerShareBasic", ("ifrs-full", "BasicEarningsLossPerShare")),
        2,
    ),
    Concept(
        "dps_declared",
        "duration",
        "per_share",
        False,
        _us("CommonStockDividendsPerShareDeclared"),
        2,
    ),
    Concept(
        "shares_weighted_basic",
        "duration",
        "shares",
        False,
        _tags(
            "WeightedAverageNumberOfSharesOutstandingBasic",
            ("ifrs-full", "WeightedAverageShares"),
        ),
        1,
    ),
    Concept(
        "shares_weighted_diluted",
        "duration",
        "shares",
        False,
        _tags(
            "WeightedAverageNumberOfDilutedSharesOutstanding",
            ("ifrs-full", "AdjustedWeightedAverageShares"),
        ),
        1,
    ),
    # --- Instant ---
    Concept(
        "cash",
        "instant",
        "money",
        False,
        _tags(
            "CashAndCashEquivalentsAtCarryingValue",
            ("ifrs-full", "CashAndCashEquivalents"),
        ),
        1,
    ),
    Concept(
        "cash_incl_restricted",
        "instant",
        "money",
        False,
        _us("CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents"),
        2,
    ),
    Concept(
        "short_term_investments",
        "instant",
        "money",
        False,
        _us("ShortTermInvestments", "MarketableSecuritiesCurrent"),
        2,
    ),
    Concept(
        "receivables",
        "instant",
        "money",
        False,
        _us("AccountsReceivableNetCurrent"),
        2,
    ),
    Concept(
        "inventory",
        "instant",
        "money",
        False,
        _us("InventoryNet"),
        2,
    ),
    Concept(
        "assets_current",
        "instant",
        "money",
        False,
        _tags("AssetsCurrent", ("ifrs-full", "CurrentAssets")),
        2,
    ),
    Concept(
        "ppe_net",
        "instant",
        "money",
        False,
        _us("PropertyPlantAndEquipmentNet"),
        2,
    ),
    Concept(
        "goodwill",
        "instant",
        "money",
        False,
        _us("Goodwill"),
        2,
    ),
    Concept(
        "intangibles",
        "instant",
        "money",
        False,
        _us("IntangibleAssetsNetExcludingGoodwill"),
        2,
    ),
    Concept(
        "total_assets",
        "instant",
        "money",
        False,
        _tags("Assets", ("ifrs-full", "Assets")),
        1,
    ),
    Concept(
        "payables",
        "instant",
        "money",
        False,
        _us("AccountsPayableCurrent"),
        2,
    ),
    Concept(
        "liabilities_current",
        "instant",
        "money",
        False,
        _tags("LiabilitiesCurrent", ("ifrs-full", "CurrentLiabilities")),
        2,
    ),
    Concept(
        "debt_current",
        "instant",
        "money",
        False,
        _us("DebtCurrent"),
        2,
    ),
    Concept(
        "long_term_debt_current",
        "instant",
        "money",
        False,
        _us("LongTermDebtCurrent"),
        2,
    ),
    Concept(
        "short_term_borrowings",
        "instant",
        "money",
        False,
        _us("ShortTermBorrowings", "CommercialPaper"),
        2,
    ),
    Concept(
        "long_term_debt_noncurrent",
        "instant",
        "money",
        False,
        _us("LongTermDebtNoncurrent", "LongTermDebtAndCapitalLeaseObligations"),
        2,
    ),
    Concept(
        "long_term_debt",
        "instant",
        "money",
        False,
        _us("LongTermDebt"),
        2,
    ),
    Concept(
        "total_liabilities",
        "instant",
        "money",
        False,
        _tags("Liabilities", ("ifrs-full", "Liabilities")),
        1,
    ),
    Concept(
        "liabilities_and_equity",
        "instant",
        "money",
        False,
        _us("LiabilitiesAndStockholdersEquity"),
        2,
    ),
    Concept(
        "equity_parent",
        "instant",
        "money",
        False,
        _tags(
            "StockholdersEquity",
            ("ifrs-full", "EquityAttributableToOwnersOfParent"),
        ),
        1,
    ),
    Concept(
        "equity_total",
        "instant",
        "money",
        False,
        _tags(
            "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest",
            ("ifrs-full", "Equity"),
        ),
        1,
    ),
    Concept(
        "minority_interest",
        "instant",
        "money",
        False,
        _us("MinorityInterest"),
        2,
    ),
    Concept(
        "preferred_stock",
        "instant",
        "money",
        False,
        _us("PreferredStockValue"),
        2,
    ),
    Concept(
        "retained_earnings",
        "instant",
        "money",
        False,
        _us("RetainedEarningsAccumulatedDeficit"),
        2,
    ),
    Concept(
        "deposits",
        "instant",
        "money",
        False,
        _us("Deposits"),
        2,
    ),
    Concept(
        "loans_net",
        "instant",
        "money",
        False,
        _us("LoansAndLeasesReceivableNetReportedAmount"),
        2,
    ),
    Concept(
        "shares_outstanding_bs",
        "instant",
        "shares",
        False,
        _us("CommonStockSharesOutstanding"),
        1,
    ),
    Concept(
        "shares_outstanding_cover",
        "instant",
        "shares",
        False,
        (("dei", "EntityCommonStockSharesOutstanding"),),
        1,
    ),
    Concept(
        "public_float",
        "instant",
        "money",
        False,
        (("dei", "EntityPublicFloat"),),
        2,
    ),
)

_COMPOSITES: tuple[CompositeSpec, ...] = (
    CompositeSpec(
        "revenue",
        "duration",
        "money",
        True,
        ("revenue_total", "revenue_contracts"),
        ("total", "contracts"),
        1,
    ),
    CompositeSpec(
        "net_income",
        "duration",
        "money",
        True,
        (
            "net_income_parent",
            "net_income_total",
            "net_income_nci",
            "minority_interest",
        ),
        ("parent", "total_no_nci"),
        1,
    ),
    CompositeSpec(
        "equity",
        "instant",
        "money",
        False,
        ("equity_parent", "equity_total", "net_income_nci", "minority_interest"),
        ("parent", "total_no_nci"),
        1,
    ),
    CompositeSpec(
        "fcf",
        "duration",
        "money",
        True,
        ("operating_cash_flow", "capex"),
        ("ocf_minus_capex",),
        1,
    ),
    CompositeSpec(
        "ebitda",
        "duration",
        "money",
        True,
        ("operating_income", "d_and_a"),
        ("oi_plus_da",),
        2,
    ),
    CompositeSpec(
        "total_debt",
        "instant",
        "money",
        False,
        (
            "debt_current",
            "long_term_debt_noncurrent",
            "long_term_debt",
            "short_term_borrowings",
            "long_term_debt_current",
        ),
        ("dc_ltdnc", "ltd_stb", "ltdc_ltdnc"),
        2,
    ),
    CompositeSpec(
        "shares_outstanding",
        "instant",
        "shares",
        False,
        ("shares_outstanding_cover", "shares_outstanding_bs"),
        ("cover", "balance_sheet"),
        1,
    ),
)

CONCEPTS: Mapping[str, Concept] = MappingProxyType(
    {concept.name: concept for concept in _BASE_CONCEPTS}
)
COMPOSITES: Mapping[str, CompositeSpec] = MappingProxyType(
    {spec.name: spec for spec in _COMPOSITES}
)
ALL_CONCEPTS: Mapping[str, Concept | CompositeSpec] = MappingProxyType(
    {**CONCEPTS, **COMPOSITES}
)


def _build_tag_maps() -> tuple[
    Mapping[tuple[str, str], Concept],
    Mapping[tuple[str, str], str],
    Mapping[tuple[str, str], int],
    Mapping[str, Concept],
]:
    concept_tags: dict[tuple[str, str], Concept] = {}
    tag_to_concept: dict[tuple[str, str], str] = {}
    tag_ranks: dict[tuple[str, str], int] = {}
    bare_tags: dict[str, Concept] = {}
    for concept in _BASE_CONCEPTS:
        for rank, key in enumerate(concept.tags):
            if key in concept_tags:
                raise AssertionError(f"Duplicate concept tag {key!r}")
            concept_tags[key] = concept
            tag_to_concept[key] = concept.name
            tag_ranks[key] = rank
            bare_tags.setdefault(key[1], concept)
    return (
        MappingProxyType(concept_tags),
        MappingProxyType(tag_to_concept),
        MappingProxyType(tag_ranks),
        MappingProxyType(bare_tags),
    )


CONCEPT_TAGS, TAG_TO_CONCEPT, TAG_RANKS, BARE_TAG_TO_CONCEPT = _build_tag_maps()

# Synthetic/legacy metric-named tags used in fixtures lacking XBRL tag names.
SYNTHETIC_METRIC_TO_CONCEPT: Mapping[str, str] = MappingProxyType(
    {
        "revenue": "revenue_total",
        "gross_profit": "gross_profit",
        "operating_income": "operating_income",
        "net_income": "net_income_parent",
        "operating_cash_flow": "operating_cash_flow",
        "capex": "capex",
        "diluted_eps": "eps_diluted",
        "weighted_average_shares_basic": "shares_weighted_basic",
        "weighted_average_shares_diluted": "shares_weighted_diluted",
        "cash": "cash",
        "total_assets": "total_assets",
        "total_liabilities": "total_liabilities",
        "equity": "equity_parent",
        "shares_outstanding": "shares_outstanding_cover",
    }
)

# Preferred XBRL tag order per legacy stored metric name (used by legacy D3 patches).
LEGACY_TAG_ORDER: Mapping[str, tuple[str, ...]] = MappingProxyType(
    {
        "revenue": (
            "Revenues",
            "RevenuesNetOfInterestExpense",
            "RevenueFromContractWithCustomerExcludingAssessedTax",
            "RevenueFromContractWithCustomerIncludingAssessedTax",
            "SalesRevenueNet",
            "RegulatedAndUnregulatedOperatingRevenue",
            "Revenue",
            "RevenueFromContractsWithCustomers",
        ),
        "gross_profit": ("GrossProfit",),
        "operating_income": (
            "OperatingIncomeLoss",
            "ProfitLossFromOperatingActivities",
        ),
        "net_income": (
            "NetIncomeLoss",
            "ProfitLossAttributableToOwnersOfParent",
            "ProfitLoss",
        ),
        "operating_cash_flow": (
            "NetCashProvidedByUsedInOperatingActivities",
            "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations",
            "CashFlowsFromUsedInOperatingActivities",
        ),
        "capex": (
            "PaymentsToAcquirePropertyPlantAndEquipment",
            "PaymentsToAcquireProductiveAssets",
            "PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities",
        ),
        "diluted_eps": (
            "EarningsPerShareDiluted",
            "DilutedEarningsLossPerShare",
        ),
        "weighted_average_shares_basic": (
            "WeightedAverageNumberOfSharesOutstandingBasic",
            "WeightedAverageShares",
        ),
        "weighted_average_shares_diluted": (
            "WeightedAverageNumberOfDilutedSharesOutstanding",
            "AdjustedWeightedAverageShares",
        ),
        "cash": (
            "CashAndCashEquivalentsAtCarryingValue",
            "CashAndCashEquivalents",
        ),
        "total_assets": ("Assets",),
        "total_liabilities": ("Liabilities",),
        "equity": (
            "StockholdersEquity",
            "EquityAttributableToOwnersOfParent",
            "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest",
            "Equity",
        ),
        "shares_outstanding": (
            "EntityCommonStockSharesOutstanding",
            "CommonStockSharesOutstanding",
        ),
    }
)


def views_for_concept(spec: Concept | CompositeSpec) -> tuple[str, ...]:
    """Supported state-timeline view suffixes for ``spec``."""
    if spec.kind == "instant":
        return ("i", "i_yoy")
    if spec.additive:
        return ("q", "ttm", "fy", "q_yoy", "ttm_yoy", "fy_yoy")
    if spec.unit_kind == "per_share":
        return ("q", "ttm", "fy", "q_yoy")
    return ("q", "fy", "q_yoy")


def parse_view_name(view: str) -> tuple[str, str]:
    """Split ``<concept>_<suffix>`` into ``(concept_name, suffix)``."""
    for suffix in (
        "_ttm_yoy",
        "_fy_yoy",
        "_q_yoy",
        "_i_yoy",
        "_ttm",
        "_fy",
        "_q",
        "_i",
    ):
        if view.endswith(suffix):
            concept_name = view[: -len(suffix)]
            short = suffix[1:]
            spec = ALL_CONCEPTS.get(concept_name)
            if spec is not None and short in views_for_concept(spec):
                return concept_name, short
    raise ValueError(f"Unknown fundamental view {view!r}")


DEFAULT_VIEWS: tuple[str, ...] = (
    # Headline income statement & growth
    "revenue_q",
    "revenue_ttm",
    "revenue_fy",
    "revenue_q_yoy",
    "revenue_ttm_yoy",
    "gross_profit_q",
    "gross_profit_ttm",
    "operating_income_q",
    "operating_income_ttm",
    "ebitda_q",
    "ebitda_ttm",
    "net_income_q",
    "net_income_ttm",
    "net_income_fy",
    "net_income_q_yoy",
    "net_income_ttm_yoy",
    # Per-share & share counts
    "eps_diluted_q",
    "eps_diluted_ttm",
    "eps_diluted_fy",
    "eps_diluted_q_yoy",
    "eps_basic_q",
    "eps_basic_ttm",
    "eps_basic_fy",
    "dps_declared_q",
    "dps_declared_ttm",
    "dps_declared_fy",
    "shares_weighted_basic_q",
    "shares_weighted_diluted_q",
    # Cash flows & capital allocation
    "operating_cash_flow_q",
    "operating_cash_flow_ttm",
    "operating_cash_flow_fy",
    "capex_q",
    "capex_ttm",
    "capex_fy",
    "fcf_q",
    "fcf_ttm",
    "fcf_fy",
    "rnd_ttm",
    "sga_ttm",
    "d_and_a_ttm",
    "interest_expense_ttm",
    "stock_comp_ttm",
    "dividends_paid_ttm",
    "repurchases_ttm",
    "stock_issuance_ttm",
    # Balance sheet instants
    "cash_i",
    "short_term_investments_i",
    "assets_current_i",
    "total_assets_i",
    "total_assets_i_yoy",
    "liabilities_current_i",
    "total_liabilities_i",
    "total_debt_i",
    "equity_i",
    "preferred_stock_i",
    "minority_interest_i",
    "shares_outstanding_i",
    "shares_outstanding_i_yoy",
)


def required_base_concepts(concepts_or_views: tuple[str, ...] | list[str]) -> set[str]:
    """Expand base/composite concept names or view names to required base concepts."""
    needed: set[str] = set()
    for item in concepts_or_views:
        if item in CONCEPTS:
            needed.add(item)
        elif item in COMPOSITES:
            needed.update(COMPOSITES[item].inputs)
        else:
            concept_name, _ = parse_view_name(item)
            if concept_name in CONCEPTS:
                needed.add(concept_name)
            else:
                needed.update(COMPOSITES[concept_name].inputs)
    return needed

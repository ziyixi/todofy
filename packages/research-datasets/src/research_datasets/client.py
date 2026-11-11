"""Frozen research dataset client for Colab, Jupyter, and local Python.

Supports immutable frozen research datasets only (`research_datasets.load(dataset_id)`),
with automatic SHA-256 verification, local disk caching, in-memory DataFrame
caching, and tight coupling with `pandas.DataFrame` across Layer 1 (raw data
families) and Layer 2 (point-in-time aligned research panels).
"""

from __future__ import annotations

import hashlib
import http.client
import json
import os
import re
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Iterable, Iterator, Mapping, Sequence
from copy import deepcopy
from datetime import date
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

import pandas as pd
import pyarrow as pa
import pyarrow.dataset as pads

from .constants import (
    API,
    DATA_FAMILIES,
    DEFAULT_HORIZONS,
    FAMILY_SPECS,
    FIELDS,
    MANIFEST_SCHEMA_MAX,
    FamilySpec,
    __version__,
)
from .events import EventSpec
from .fundamentals import (
    fundamental_features as _fundamental_features,
)
from .fundamentals import (
    fundamental_ratios as _fundamental_ratios,
)
from .fundamentals import (
    prepare_fundamental_features as _prepare_fundamental_features,
)
from .fundamentals import (
    prepare_fundamental_ratios as _prepare_fundamental_ratios,
)
from .fundamentals_derived import (
    asset_at as _asset_at,
)
from .fundamentals_derived import (
    cik_at as _cik_at,
)
from .fundamentals_derived import (
    derived_fundamentals as _derived_fundamentals,
)
from .fundamentals_derived import (
    fiscal_quarters as _fiscal_quarters,
)
from .fundamentals_derived import (
    fundamental_factors as _fundamental_factors,
)
from .fundamentals_derived import (
    fundamental_states as _fundamental_states,
)
from .industry import (
    industry as _industry,
)
from .panels import (
    build_candidates,
)
from .panels import (
    daily_features as _daily_features,
)
from .panels import (
    forward_returns as _forward_returns,
)
from .panels import (
    panel as _panel,
)
from .panels import (
    prepare as _prepare,
)
from .sec_events import (
    earnings_calendar_asof as _earnings_calendar_asof,
)
from .sec_events import (
    sec_event_specs as _sec_event_specs,
)
from .valuation import (
    valuation as _valuation,
)

_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
_RETRY = {429, 500, 502, 503, 504}
_BATCH_SIZE = 65536
_VERSION = re.compile(r"^(\d+)\.(\d+)\.(\d+)(?:(a|b|rc)(\d+))?$")
_PRE_RELEASE = {"a": 0, "b": 1, "rc": 2}
_HINTS = {
    "UNAUTHORIZED": "只读 key 无效或已撤销，请更新调用时提供的 key。",
    "DATASET_NOT_READY": "这个固定版本还没有归档完成：稍后再试，或改用已就绪的版本。",
    "DATA_NOT_READY": "这个固定版本还没有归档完成：稍后再试，或改用已就绪的版本。",
    "NOT_FOUND": "版本或文件不存在（可能已删除）：用 q.versions() 查看可用版本。",
    "ASSET_NOT_IN_DATA": "所选证券不在这份数据里。",
    "BAD_REQUEST": "参数被拒绝：检查日期、字段和证券；代码有歧义时改传 asset_id。",
    "UNAVAILABLE": "服务暂时不可用，请稍后重试。",
    "READ_ONLY": "只读 key 不允许这个操作。",
    "CAPABILITY_MISSING": "这个固定版本未包含该数据族或冻结日历：请改用包含该能力的研究版本。",
    "SYMBOL_AMBIGUOUS": "证券代码在这个版本中对应多个证券身份：请改传明确的 asset_id。",
    "ISSUER_MAPPING_MISSING": "所选证券没有已核实的冻结发行人映射。请查看该版本的 universe。",
    "CLIENT_TOO_OLD": "这个固定版本需要更新的 SDK：请按控制台给出的固定提交重新安装 SDK。",
}


def _version_key(value: Any) -> tuple[int, ...] | None:
    """Release order of X.Y.Z with an optional aN/bN/rcN pre-release (rc1 < final)."""
    match = _VERSION.match(value) if isinstance(value, str) else None
    if match is None:
        return None
    major, minor, patch, phase, number = match.groups()
    return (
        int(major),
        int(minor),
        int(patch),
        _PRE_RELEASE[phase] if phase else len(_PRE_RELEASE),
        int(number or 0),
    )


def check_manifest(manifest: Mapping[str, Any]) -> None:
    """Refuse a manifest layout or client minimum this SDK does not understand."""
    schema = manifest.get("schema_version", 1)
    if type(schema) is not int or schema < 1:
        raise DatasetError("INTEGRITY", "manifest 的 schema_version 无效。")
    if schema > MANIFEST_SCHEMA_MAX:
        raise DatasetError(
            "CLIENT_TOO_OLD",
            f"manifest schema_version {schema} 新于本 SDK {__version__} 支持的 {MANIFEST_SCHEMA_MAX}。",
        )
    minimum = manifest.get("client_min_version")
    if minimum in (None, ""):
        return
    required = _version_key(minimum)
    if required is None or required > (_version_key(__version__) or ()):
        raise DatasetError(
            "CLIENT_TOO_OLD",
            f"这个固定版本要求 SDK {minimum} 或更新，本 SDK 是 {__version__}。",
        )


class DatasetError(Exception):
    """A refused or failed read: reason is a stable code, the message says what to do next."""

    def __init__(
        self, reason: str, message: str, status: int = 0, request_id: str = ""
    ) -> None:
        self.reason, self.status, self.request_id = reason, status, request_id
        hint = _HINTS.get(reason, "")
        super().__init__(
            f"[{reason}] {message}"
            + (f"\n→ {hint}" if hint else "")
            + (f"\n(request {request_id})" if request_id else "")
        )


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(
        self, *args: Any
    ) -> None:  # never send the key to another location
        return None


def connect(
    key: str,
    *,
    base_url: str,
    cache_dir: str | Path | None = None,
    max_requests: int = 500,
    quiet: bool = False,
) -> Client:
    """Connect to an explicit read endpoint with an opaque bearer key."""
    if not isinstance(key, str) or not key or any(char.isspace() for char in key):
        raise DatasetError("KEY_MISSING", "请提供非空的 bearer key。")
    parts = urllib.parse.urlsplit(base_url)
    loopback = parts.scheme == "http" and parts.hostname in {
        "127.0.0.1",
        "localhost",
        "::1",
    }
    if (
        not parts.hostname
        or parts.username is not None
        or parts.password is not None
        or parts.query
        or parts.fragment
        or not (parts.scheme == "https" or loopback)
    ):
        raise DatasetError(
            "BASE_URL_INVALID",
            "base_url 需要完整的 HTTPS 读取入口，不能含凭据、查询参数或片段；本机测试可用 HTTP。",
        )
    cache = (
        Path(cache_dir)
        if cache_dir
        else Path(tempfile.gettempdir()) / "research-datasets-cache"
    )
    return Client(key, base_url.rstrip("/"), cache, max_requests, quiet)


def load(
    dataset_id: str = "latest",
    *,
    key: str,
    base_url: str,
    cache_dir: str | Path | None = None,
    max_requests: int = 500,
    quiet: bool = True,
    preload: bool = False,
) -> Dataset:
    """One-line entry point returning a frozen research `Dataset` (`Version`)."""
    client = connect(
        key,
        base_url=base_url,
        cache_dir=cache_dir,
        max_requests=max_requests,
        quiet=quiet,
    )
    ds = client.version(dataset_id)
    if preload:
        ds.preload()
    return ds


class Client:
    """One notebook session for reading immutable frozen research datasets."""

    def __init__(
        self,
        key: str,
        base_url: str,
        cache_dir: Path,
        max_requests: int,
        quiet: bool,
    ) -> None:
        self._headers = {
            "Authorization": "Bearer " + key,
            "User-Agent": f"Todofy-Research-Datasets/{__version__}",
        }
        self.base_url, self.cache_dir = base_url, cache_dir
        self.max_requests, self.quiet = max_requests, quiet
        self._opener = urllib.request.build_opener(_NoRedirect)
        self._stats = {"requests": 0, "bytes": 0, "cached_parts": 0}
        self._verified: set[str] = set()
        self._versions: dict[str, Dataset] = {}
        self._latest: str | None = None
        cache_dir.mkdir(parents=True, exist_ok=True)

    def __repr__(self) -> str:
        return f"<research_datasets {__version__} {self.base_url} · 本会话 {self._stats['requests']} 个请求>"

    def _request(
        self,
        path: str,
        *,
        body: Any = None,
        target: str | Path | None = None,
        attempts: int = 4,
    ) -> tuple[bytes | None, Any]:
        url = f"{self.base_url}/{path}"
        data = json.dumps(body).encode() if body is not None else None
        headers = dict(
            self._headers, **({"Content-Type": "application/json"} if data else {})
        )
        for attempt in range(attempts):
            if self._stats["requests"] >= self.max_requests:
                raise DatasetError(
                    "SESSION_BUDGET",
                    f"本会话已发出 {self._stats['requests']} 个请求（上限 {self.max_requests}）。"
                    "请把多个证券合并成一次读取，不要逐个循环；确有需要可用 connect(max_requests=...) 放宽。",
                )
            self._stats["requests"] += 1
            request = urllib.request.Request(
                url, data=data, headers=headers, method="POST" if data else "GET"
            )
            try:
                with self._opener.open(request, timeout=300) as response:
                    if response.status != 200:
                        raise DatasetError(
                            "UNEXPECTED_STATUS",
                            f"HTTP {response.status}。",
                            response.status,
                        )
                    if "text/html" in response.headers.get("content-type", ""):
                        raise DatasetError(
                            "UNEXPECTED_HTML",
                            "收到网页而不是数据：只读路径可能被登录页拦截。",
                        )
                    if target is None:
                        payload = response.read()
                        self._stats["bytes"] += len(payload)
                        return payload, response.headers
                    with open(target, "wb") as output:
                        while chunk := response.read(1 << 20):
                            output.write(chunk)
                            self._stats["bytes"] += len(chunk)
                    expected = response.headers.get("content-length", "")
                    size = os.path.getsize(target)
                    if expected.isdigit() and int(expected) != size:
                        raise http.client.IncompleteRead(b"", int(expected) - size)
                    return None, response.headers
            except urllib.error.HTTPError as error:
                problem = _error(error)
                if 300 <= error.code < 400:
                    raise DatasetError(
                        "REDIRECT_REFUSED",
                        f"HTTP {error.code}：只读路径被重定向，key 没有发往新地址。",
                        error.code,
                    ) from None
                if error.code in _RETRY and attempt + 1 < attempts:
                    time.sleep(_retry_after(error.headers.get("retry-after"), attempt))
                    continue
                raise problem from None
            except (
                urllib.error.URLError,
                http.client.HTTPException,
                TimeoutError,
                ConnectionError,
            ) as error:
                if attempt + 1 < attempts:
                    time.sleep(2**attempt)
                    continue
                raise DatasetError(
                    "NETWORK",
                    f"{type(error).__name__}: {getattr(error, 'reason', error)}",
                ) from None
        raise DatasetError("NETWORK", "Request failed after retries")

    def _json(self, path: str) -> Any:
        payload, _ = self._request(path)
        assert payload is not None
        return json.loads(payload)

    def _part(self, item: Mapping[str, Any]) -> Path:
        """An immutable artifact named by its manifest SHA-256: verified once per session, then read from the cache."""
        sha, size = item.get("sha256"), item.get("size_bytes")
        if (
            not isinstance(sha, str)
            or re.fullmatch(r"[0-9a-f]{64}", sha) is None
            or type(size) is not int
            or size < 0
        ):
            raise DatasetError("INTEGRITY", "分片的 SHA-256 或大小元数据无效。")
        path = self.cache_dir / f"{sha}.parquet"
        if path.exists():
            if path.stat().st_size == size and (
                sha in self._verified or _sha256(path) == sha
            ):
                self._verified.add(sha)
                self._stats["cached_parts"] += 1
                return path
            path.unlink(missing_ok=True)
            self._verified.discard(sha)
        partial = path.with_suffix(".partial")
        self._request(
            "artifact?" + urllib.parse.urlencode({"key": item["key"]}), target=partial
        )
        if partial.stat().st_size != size or _sha256(partial) != sha:
            partial.unlink(missing_ok=True)
            raise DatasetError(
                "INTEGRITY",
                f"{item['key']} 的 SHA-256 或大小与 manifest 不一致，已丢弃。",
            )
        partial.replace(path)
        self._verified.add(sha)
        return path

    def _mark(self) -> tuple[int, int, int]:
        return (
            self._stats["requests"],
            self._stats["bytes"],
            self._stats["cached_parts"],
        )

    def _say(self, before: tuple[int, int, int], label: str) -> None:
        if self.quiet:
            return
        spent, size, hits = (now - then for now, then in zip(self._mark(), before))
        print(
            f"research_datasets · {label} · {spent} 个请求 · {size / 1e6:.1f} MB"
            + (f" · {hits} 个分片来自缓存" if hits else "")
        )

    def usage(self) -> dict[str, int]:
        """Requests, bytes and cache hits in this session."""
        return dict(self._stats)

    def versions(self) -> pd.DataFrame:
        """Fixed versions, newest first (1 request)."""
        rows = self._json("datasets?page_size=20")["datasets"]
        columns = [
            "dataset_id",
            "state",
            "created_at",
            "cutoff_date",
            "asset_count",
            "bar_count",
            "event_count",
            "size_bytes",
        ]
        return pd.DataFrame(
            [{name: row.get(name) for name in columns} for row in rows], columns=columns
        )

    def _newest_ready(self) -> str:
        query: dict[str, Any] = {"page_size": 5}
        while True:
            page = self._json("datasets?" + urllib.parse.urlencode(query))
            for row in page["datasets"]:
                if row.get("state") == "ready":
                    return str(row["dataset_id"])
            if not page.get("next_page_token"):
                raise DatasetError("NOT_FOUND", "没有归档就绪的固定版本。")
            query = {"page_size": 20, "page_token": page["next_page_token"]}

    def version(self, ref: str = "latest") -> Dataset:
        """A ready fixed version. 'latest' is resolved once per session; pass the UUID to pin a notebook."""
        if ref == "latest":
            self._latest = self._latest or self._newest_ready()
            ref = self._latest
        if not isinstance(ref, str) or not _UUID.match(ref):
            raise DatasetError("BAD_REQUEST", "固定版本需要 dataset UUID 或 'latest'。")
        if ref not in self._versions:
            before = self._mark()
            raw_manifest, _ = self._request(
                "artifact?"
                + urllib.parse.urlencode({"key": f"datasets/{ref}/manifest.json"})
            )
            assert raw_manifest is not None
            manifest = json.loads(raw_manifest)
            if manifest.get("dataset_id") != ref:
                raise DatasetError(
                    "INTEGRITY", "manifest 的 dataset_id 与请求的版本不一致。"
                )
            self._versions[ref] = Dataset(
                self, manifest, hashlib.sha256(raw_manifest).hexdigest()
            )
            self._say(before, f"版本 {ref[:8]} manifest")
        return self._versions[ref]

    dataset = version


def _retry_after(value: Any, attempt: int) -> float:
    try:
        return min(30.0, max(0.0, float(value)))
    except (TypeError, ValueError):
        return float(2**attempt)


def _error(error: urllib.error.HTTPError) -> DatasetError:
    try:
        with error:
            body = json.loads(error.read())["error"]
        details = {
            item.get("@type", "").rsplit(".", 1)[-1]: item
            for item in body.get("details", [])
        }
        return DatasetError(
            details.get("ErrorInfo", {}).get("reason", body.get("status", "HTTP")),
            body.get("message", ""),
            error.code,
            details.get("RequestInfo", {}).get("request_id", ""),
        )
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return DatasetError("HTTP", f"HTTP {error.code}", error.code)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as source:
        for chunk in iter(lambda: source.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _index_day(value: Any) -> str | None:
    if not isinstance(value, str) or len(value) < 10:
        return None
    try:
        return date.fromisoformat(value[:10]).isoformat()
    except ValueError:
        return None


def _day(value: Any, name: str) -> str | None:
    if value is None:
        return None
    day = _index_day(str(value))
    if not day:
        raise DatasetError("BAD_REQUEST", f"{name} 需要 YYYY-MM-DD 日期。")
    return day


def _range(start: Any, end: Any) -> tuple[str | None, str | None]:
    start_s, end_s = _day(start, "start"), _day(end, "end")
    if start_s and end_s and start_s > end_s:
        raise DatasetError("BAD_REQUEST", f"start {start_s} 晚于 end {end_s}。")
    return start_s, end_s


def _scan_batches(
    dataset: pads.Dataset,
    *,
    scalar_filters: Sequence[tuple[str, Sequence[Any]]] = (),
    asset_ids_wanted: set[str] | None = None,
    historical_links: bool = False,
    time_col: str | None = None,
    start: str | None = None,
    end: str | None = None,
    event_date_fallback: bool = False,
    columns: Sequence[str] | None = None,
) -> pa.Table:
    names = set(dataset.schema.names)
    clauses = []
    for col_name, allowed in scalar_filters:
        if col_name in names:
            clauses.append(pads.field(col_name).isin(list(allowed)))
    if time_col and time_col in names and (start or end):
        if start:
            clauses.append(pads.field(time_col) >= start)
        if end:
            if not start:
                clauses.append(pads.field(time_col) >= "0001-01-01")
            clauses.append(pads.field(time_col) <= f"{end}~")
    condition = None
    for clause in clauses:
        condition = clause if condition is None else condition & clause
    # Read only the requested columns plus those the filters below need.
    needed = list(dataset.schema.names)
    if columns is not None:
        filters = {"asset_ids", "event_date", "filing_date", time_col}
        if historical_links:
            filters.add("asset_first_seen_at")
        needed = [name for name in needed if name in columns or name in filters]
    scanner = dataset.scanner(columns=needed, filter=condition, batch_size=_BATCH_SIZE)
    schema = scanner.projected_schema
    batches = []
    for batch in scanner.to_batches():
        if batch.num_rows == 0:
            continue
        if asset_ids_wanted is not None and "asset_ids" in names:
            associations = batch.column("asset_ids").to_pylist()
            history = (
                batch.column("asset_first_seen_at").to_pylist()
                if historical_links and "asset_first_seen_at" in names
                else [None] * batch.num_rows
            )
            mask = pa.array(
                [
                    bool(
                        asset_ids_wanted.intersection(values or ())
                        or asset_ids_wanted.intersection(dict(previous or ()))
                    )
                    for values, previous in zip(associations, history)
                ],
                type=pa.bool_(),
            )
            batch = batch.filter(mask)
            if batch.num_rows == 0:
                continue
        if event_date_fallback and (start or end):
            ev_col = (
                batch.column("event_date").to_pylist()
                if "event_date" in names
                else [None] * batch.num_rows
            )
            fl_col = (
                batch.column("filing_date").to_pylist()
                if "filing_date" in names
                else [None] * batch.num_rows
            )
            keep = []
            for ev, fl in zip(ev_col, fl_col):
                day = _index_day(ev) or _index_day(fl)
                keep.append(
                    day is not None
                    and (not start or day >= start)
                    and (not end or day <= end)
                )
            batch = batch.filter(pa.array(keep, type=pa.bool_()))
            if batch.num_rows == 0:
                continue
        elif time_col and time_col in names and (start or end):
            keep = []
            for val in batch.column(time_col).to_pylist():
                day = _index_day(val)
                keep.append(
                    day is not None
                    and (not start or day >= start)
                    and (not end or day <= end)
                )
            batch = batch.filter(pa.array(keep, type=pa.bool_()))
            if batch.num_rows == 0:
                continue
        batches.append(batch)
    table = pa.Table.from_batches(batches, schema=schema)
    return table if columns is None else table.select(list(columns))


def _columns(fields: Sequence[str] | None, wide: str | None) -> list[str]:
    columns = list(
        dict.fromkeys(
            [
                "asset_id",
                "symbol",
                "date",
                *(fields or FIELDS),
                *([wide] if wide else []),
            ]
        )
    )
    if any(name not in FIELDS for name in columns):
        raise DatasetError("BAD_REQUEST", f"fields 只能取 {FIELDS}。")
    return columns


def _frame(
    table: pa.Table,
    wide: str | None,
    order: Sequence[str] | None,
    attrs: Mapping[str, Any],
) -> pd.DataFrame:
    frame = table.to_pandas()
    frame["date"] = pd.to_datetime(frame["date"])
    for column in ("asset_id", "symbol", "adjustment"):
        if column in frame:
            frame[column] = frame[column].astype("category")
    if wide:
        names = frame.groupby("asset_id", observed=True)["symbol"].first().astype(str)
        repeated = names[names.duplicated(keep=False)].index
        names.loc[repeated] = [
            f"{names[identity]}·{identity[:8]}" for identity in repeated
        ]
        columns = [
            identity for identity in (order or names.index) if identity in names.index
        ]
        frame = frame.pivot(index="date", columns="asset_id", values=wide)[
            columns
        ].rename(columns=names.to_dict())
        frame.columns = pd.Index(frame.columns.astype(str), name="symbol")
    frame.attrs.update(attrs)
    return frame


def _copy_frame(frame: pd.DataFrame) -> pd.DataFrame:
    """Isolate mutable object cells and metadata as well as pandas' column buffers."""
    result = frame.copy()
    for name in frame.select_dtypes(include="object"):
        result[name] = pd.Series(
            [deepcopy(value) for value in frame[name]], index=frame.index, dtype=object
        )
    result.attrs = deepcopy(frame.attrs)
    return result


class Dataset:
    """One immutable frozen research dataset version (dataset UUID): every read here is reproducible."""

    def __init__(
        self, client: Client, manifest: dict[str, Any], manifest_sha256: str = ""
    ) -> None:
        check_manifest(manifest)
        self._client, self.manifest = client, manifest
        self.manifest_sha256 = manifest_sha256
        self.id = str(manifest["dataset_id"])
        self.dataset_id = self.id
        self.cutoff = str(manifest.get("cutoff_date") or manifest.get("cutoff") or "")
        self.source_asof = str(manifest.get("source_asof", ""))
        self.quality = manifest.get("quality", {})
        self.limitations = manifest.get("limitations", [])
        self._df_cache: dict[tuple[Any, ...], pd.DataFrame] = {}

    def __repr__(self) -> str:
        rows = self.manifest.get("bar_counts", {})
        return (
            f"<research_datasets version {self.id} · 截止 {self.cutoff} · {len(self.manifest['universe']):,} 个证券 · "
            f"原始 {rows.get('raw', 0):,} / 复权 {rows.get('all', 0):,} 行 · 事件 {self.manifest.get('event_count', 0):,}>"
        )

    def usage(self) -> dict[str, int]:
        """Requests, bytes and cache hits in this session."""
        return self._client.usage()

    def clear_cache(self) -> None:
        """Clear in-memory DataFrame cache for this dataset."""
        self._df_cache.clear()

    def preload(self, families: Sequence[str] | None = None) -> Dataset:
        """Download and verify Parquet parts for frozen families up front."""
        for item in self._parts("all") + self._parts("raw"):
            self._client._part(item)
        available = self.manifest.get("data_families", {})
        target_families = (
            list(families)
            if families is not None
            else [f for f in DATA_FAMILIES if f in available]
        )
        for family in target_families:
            for item in self._family_parts(family):
                self._client._part(item)
        return self

    @property
    def universe(self) -> pd.DataFrame:
        """The securities frozen in this version."""
        return pd.DataFrame(self.manifest["universe"])

    @property
    def coverage(self) -> pd.DataFrame:
        """Per-security first/last date, bar count and missing sessions."""
        return pd.DataFrame(self.manifest.get("coverage", []))

    def securities(
        self,
        symbols: str | Sequence[str] | None = None,
        *,
        verified_only: bool = False,
    ) -> pd.DataFrame:
        """Return the frozen universe filtered to ``symbols`` (and optionally ``verified_only=True``)."""
        df = self.universe
        if symbols is not None and symbols != "all":
            ids = self.resolve(symbols)
            order = {aid: idx for idx, aid in enumerate(ids)}
            df = df[df["asset_id"].isin(ids)].copy()
            df["_order"] = df["asset_id"].map(order)
            df = (
                df.sort_values("_order").drop(columns=["_order"]).reset_index(drop=True)
            )
        if verified_only and "issuer_mapping_status" in df.columns:
            df = df[df["issuer_mapping_status"].eq("verified")].reset_index(drop=True)
        df.attrs["dataset_version"] = self.id
        return df

    @property
    def calendar(self) -> list[str]:
        """Frozen ordered trading session dates (YYYY-MM-DD) in this version."""
        raw = self.manifest.get("calendar")
        if not isinstance(raw, list):
            raise DatasetError(
                "CAPABILITY_MISSING", "这个固定版本未包含冻结交易日历（calendar）。"
            )
        return list(raw)

    def calendar_df(
        self,
        start: str | date | None = None,
        end: str | date | None = None,
    ) -> pd.DataFrame:
        """Return frozen trading sessions as a ``pd.DataFrame`` with ``session`` and ``session_index``."""
        start_s, end_s = _range(start, end)
        sessions = self.calendar
        rows = [
            {"session": day, "session_index": idx}
            for idx, day in enumerate(sessions)
            if (not start_s or day >= start_s) and (not end_s or day <= end_s)
        ]
        df = pd.DataFrame(rows, columns=["session", "session_index"])
        df.attrs["dataset_version"] = self.id
        return df

    def recipe_source(self) -> str:
        """Return the verified UTF-8 research recipe frozen with this dataset, without executing it."""
        descriptor = self.manifest.get("research_recipe")
        if not isinstance(descriptor, dict):
            raise DatasetError("CAPABILITY_MISSING", "这个固定版本未包含冻结研究脚本。")
        fields = ("key", "size_bytes", "sha256", "content_type")
        key = descriptor.get("key")
        if (
            not isinstance(key, str)
            or not key.startswith(f"datasets/{self.id}/")
            or not all(field in descriptor for field in fields)
            or not any(
                all(item.get(field) == descriptor[field] for field in fields)
                for item in self.manifest.get("files", [])
            )
        ):
            raise DatasetError("INTEGRITY", "研究脚本未按该版本的文件摘要登记。")
        payload, _ = self._client._request(
            "artifact?" + urllib.parse.urlencode({"key": key})
        )
        assert payload is not None
        if (
            len(payload) != descriptor["size_bytes"]
            or hashlib.sha256(payload).hexdigest() != descriptor["sha256"]
        ):
            raise DatasetError(
                "INTEGRITY", "研究脚本的 SHA-256 或大小与 manifest 不一致。"
            )
        try:
            return payload.decode("utf-8")
        except UnicodeDecodeError:
            raise DatasetError("INTEGRITY", "研究脚本不是有效的 UTF-8 文本。") from None

    def resolve(self, symbols: str | Sequence[str] | None) -> list[str]:
        """Tickers or asset UUIDs -> asset UUIDs. Any ticker matching multiple securities fails with SYMBOL_AMBIGUOUS."""
        assets = self.manifest["universe"]
        if symbols is None or symbols == "all":
            return [str(asset["asset_id"]) for asset in assets]
        known = {asset["asset_id"] for asset in assets}
        ids: list[str] = []
        for value in [symbols] if isinstance(symbols, str) else list(symbols):
            if _UUID.match(value):
                if value not in known:
                    raise DatasetError(
                        "ASSET_OUTSIDE_VERSION", f"{value} 不在这个版本的证券范围内。"
                    )
                ids.append(value)
                continue
            matches = list(
                {
                    asset["asset_id"]: asset
                    for asset in assets
                    if str(asset.get("symbol", "")).upper() == value.upper()
                }.values()
            )
            if not matches:
                raise DatasetError(
                    "SYMBOL_NOT_FOUND",
                    f"{value} 不在这个版本（{len(assets):,} 个证券）。",
                )
            if len(matches) > 1:
                listing = "；".join(
                    f"{asset['asset_id']} {asset.get('status', '')} {asset.get('name', '')}"
                    for asset in matches
                )
                raise DatasetError(
                    "SYMBOL_AMBIGUOUS",
                    f"{value} 对应多个证券，请改传 asset_id：{listing}",
                )
            ids.append(str(matches[0]["asset_id"]))
        if not ids:
            raise DatasetError(
                "BAD_REQUEST", "没有选择证券；读整个版本请传 None 或 'all'。"
            )
        if len(set(ids)) != len(ids):
            raise DatasetError("BAD_REQUEST", "证券重复。")
        return ids

    def _require_family(self, family: str) -> FamilySpec:
        """A frozen family this SDK understands; checked only when it is read."""
        families = self.manifest.get("data_families")
        info = families.get(family) if isinstance(families, dict) else None
        if not isinstance(info, dict):
            raise DatasetError(
                "CAPABILITY_MISSING",
                f"这个固定版本未包含 {family} 数据族。",
            )
        spec = FAMILY_SPECS.get(family)
        if spec is None:
            raise DatasetError(
                "CLIENT_TOO_OLD", f"本 SDK {__version__} 不认识 {family} 数据族。"
            )
        schema = info.get("schema_version", 1)
        if schema not in spec.schema_versions:
            raise DatasetError(
                "CLIENT_TOO_OLD",
                f"{family} 数据族的 schema_version {schema} 需要更新的 SDK（本 SDK {__version__}）。",
            )
        return spec

    def _issuer_ids(
        self, symbols: str | Sequence[str] | None
    ) -> tuple[list[str], list[str]]:
        selected = set(self.resolve(symbols))
        ciks, unmapped_set = [], set()
        for asset in self.manifest["universe"]:
            if asset["asset_id"] not in selected:
                continue
            cik = asset.get("cik", "")
            if (
                asset.get("issuer_mapping_status") == "verified"
                and isinstance(cik, str)
                and re.fullmatch(r"[0-9]{10}", cik)
            ):
                ciks.append(cik)
            else:
                unmapped_set.add(str(asset["asset_id"]))
        families = self.manifest.get("data_families")
        if isinstance(families, dict) and "issuer_history" in families:
            hist = self._read_family(
                "issuer_history",
                symbols=None
                if (symbols is None or symbols == "all")
                else list(selected),
            )
            if not hist.empty and "cik" in hist.columns:
                status_col = (
                    hist["status"].astype(str)
                    if "status" in hist.columns
                    else pd.Series("verified", index=hist.index)
                )
                for aid, cik_val, st in zip(
                    hist["asset_id"].astype(str),
                    hist["cik"].fillna("").astype(str),
                    status_col,
                ):
                    if aid not in selected or st != "verified":
                        continue
                    padded = (
                        cik_val.strip().zfill(10) if cik_val.strip().isdigit() else ""
                    )
                    if re.fullmatch(r"[0-9]{10}", padded) and int(padded) > 0:
                        ciks.append(padded)
                        unmapped_set.discard(aid)
        unmapped = [
            str(asset["asset_id"])
            for asset in self.manifest["universe"]
            if str(asset["asset_id"]) in unmapped_set
        ]
        if not ciks and symbols is not None and symbols != "all":
            raise DatasetError(
                "ISSUER_MAPPING_MISSING",
                f"所选 {len(unmapped)} 个证券缺少冻结发行人映射。",
            )
        return list(dict.fromkeys(ciks)), unmapped

    def _parts(
        self, kind: str, ids: Sequence[str] | None = None
    ) -> list[dict[str, Any]]:
        prefix = f"datasets/{self.id}/{kind}/"
        files = [
            item
            for item in self.manifest["files"]
            if item["key"].startswith(prefix) and item["key"].endswith(".parquet")
        ]
        index = {entry["key"]: entry for entry in self.manifest.get("part_index", [])}
        if ids is None or not all(item["key"] in index for item in files):
            return files
        return [
            item
            for item in files
            if any(
                index[item["key"]]["first_asset_id"]
                <= identity
                <= index[item["key"]]["last_asset_id"]
                for identity in ids
            )
        ]

    def _family_parts(
        self,
        family: str,
        identities: Sequence[str] | None = None,
        start: str | None = None,
        end: str | None = None,
    ) -> list[dict[str, Any]]:
        prefix = f"datasets/{self.id}/{family}/"
        files = [
            item
            for item in self.manifest.get("files", [])
            if item["key"].startswith(prefix) and item["key"].endswith(".parquet")
        ]
        if not files:
            return []
        spec = FAMILY_SPECS.get(family)
        clock = spec.part_clock if spec is not None else None
        identity_column = spec.identity if spec is not None else "none"
        index = {
            entry["key"]: entry
            for entry in self.manifest.get("part_index", [])
            if isinstance(entry, dict) and "key" in entry
        }
        selected = []
        for item in files:
            entry = index.get(item["key"])
            if not isinstance(entry, dict) or entry.get("family") != family:
                selected.append(item)
                continue
            if identities is not None and identity_column != "none":
                first_id = entry.get(f"first_{identity_column}")
                last_id = entry.get(f"last_{identity_column}")
                if (
                    isinstance(first_id, str)
                    and isinstance(last_id, str)
                    and first_id
                    and last_id
                    and first_id <= last_id
                    and not any(
                        first_id <= identity <= last_id for identity in identities
                    )
                ):
                    continue
            if (start or end) and clock:
                first_day = _index_day(entry.get(f"first_{clock}"))
                last_day = _index_day(entry.get(f"last_{clock}"))
                if (
                    first_day is not None
                    and last_day is not None
                    and first_day <= last_day
                    and ((start and last_day < start) or (end and first_day > end))
                ):
                    continue
            selected.append(item)
        return selected

    def _read_family(
        self,
        family: str,
        *,
        symbols: str | Sequence[str] | None = None,
        start: str | date | None = None,
        end: str | date | None = None,
        metrics: Sequence[str] | None = None,
        tags: Sequence[str] | None = None,
        columns: Sequence[str] | None = None,
        optional_columns: bool = False,
    ) -> pd.DataFrame:
        spec = self._require_family(family)
        attrs: dict[str, Any] = {"dataset_version": self.id}
        identity_column = spec.identity
        unmapped: list[str] = []
        whole = symbols is None or symbols == "all"
        if identity_column == "cik":
            identities, unmapped = self._issuer_ids(symbols)
            attrs.update(
                unmapped_asset_ids=unmapped, unmapped_asset_count=len(unmapped)
            )
        elif identity_column == "none":
            if not whole:
                raise DatasetError(
                    "BAD_REQUEST", f"{family} 不按证券划分：请不传 symbols。"
                )
            identities = None
        else:
            identities = None if whole else self.resolve(symbols)
        if columns is not None:
            columns = list(dict.fromkeys(columns))
            if not columns or any(not isinstance(name, str) for name in columns):
                raise DatasetError("BAD_REQUEST", "columns 需要非空的列名列表。")
        start_s, end_s = _range(start, end)
        cache_key = (
            "_read_family",
            family,
            tuple(identities) if identities is not None else None,
            tuple(unmapped),
            start_s,
            end_s,
            tuple(metrics) if metrics is not None else None,
            tuple(tags) if tags is not None else None,
            tuple(columns) if columns is not None else None,
            optional_columns,
        )
        if cache_key in self._df_cache:
            return _copy_frame(self._df_cache[cache_key])

        before = self._client._mark()
        parts = (
            []
            if identities == []
            else self._family_parts(
                family, identities=identities, start=start_s, end=end_s
            )
        )
        mapping_note = (
            f" · {len(unmapped)} 个证券缺少冻结发行人映射" if unmapped else ""
        )
        if not parts:
            frame = pd.DataFrame()
            frame.attrs.update(attrs)
            self._client._say(
                before, f"{self.id[:8]} {family} 0 行 / 0 个分片{mapping_note}"
            )
            self._df_cache[cache_key] = frame
            return _copy_frame(frame)
        paths = [str(self._client._part(item)) for item in parts]
        ds = pads.dataset(paths, format="parquet")
        names = set(ds.schema.names)
        if columns is not None and optional_columns:
            columns = [name for name in columns if name in names]
        if columns is not None and not set(columns).issubset(names):
            raise DatasetError(
                "BAD_REQUEST",
                f"{family} 没有这些列：{sorted(set(columns) - names)}。",
            )
        time_col = spec.part_clock
        if family == "event_observations" and time_col not in names:
            time_col = "content_first_seen_at"
        if (start_s or end_s) and time_col is None:
            raise DatasetError("BAD_REQUEST", f"{family} 不支持按日期筛选。")
        if (start_s or end_s) and time_col not in names:
            raise DatasetError(
                "CAPABILITY_MISSING", f"{family} 缺少 {time_col} 时间列。"
            )
        scalar_filters: list[tuple[str, Sequence[Any]]] = []
        asset_ids_wanted = None
        if identities is not None:
            # Families that link events to securities carry an asset_ids list instead.
            if "asset_ids" in names and (
                family == "event_observations" or identity_column not in names
            ):
                asset_ids_wanted = set(identities)
            elif identity_column in names:
                scalar_filters.append((identity_column, identities))
            else:
                raise DatasetError("INTEGRITY", f"{family} 缺少证券身份列。")
        if metrics is not None:
            if "metric" not in names:
                raise DatasetError("INTEGRITY", f"{family} 缺少 metric 列。")
            scalar_filters.append(("metric", metrics))
        if tags is not None:
            if "tag" not in names:
                raise DatasetError("INTEGRITY", f"{family} 缺少 tag 列。")
            scalar_filters.append(("tag", tags))
        table = _scan_batches(
            ds,
            scalar_filters=scalar_filters,
            asset_ids_wanted=asset_ids_wanted,
            historical_links=family == "event_observations",
            time_col=time_col,
            start=start_s,
            end=end_s,
            columns=columns,
        )
        frame = table.to_pandas().reset_index(drop=True)
        self._client._say(
            before,
            f"{self.id[:8]} {family} {len(frame):,} 行 / {len(parts)} 个分片{mapping_note}",
        )
        frame.attrs.update(attrs)
        self._df_cache[cache_key] = frame
        return _copy_frame(frame)

    def files(self, adjusted: bool = True) -> list[str]:
        """Local paths of every part of one price basis (downloaded once), e.g. for duckdb.read_parquet."""
        return [
            str(self._client._part(item))
            for item in self._parts("all" if adjusted else "raw")
        ]

    def prices(
        self,
        symbols: str | Sequence[str] | None = None,
        start: str | date | None = None,
        end: str | date | None = None,
        *,
        adjusted: bool | str = True,
        fields: Sequence[str] | None = None,
        wide: str | bool | None = None,
    ) -> pd.DataFrame:
        """Daily bars as a long DataFrame, or wide=<field> (or wide=True for 'close') for a date x symbol table.

        Pass ``adjusted="both"`` to concatenate raw and vendor-adjusted bars in one DataFrame.
        """
        if wide is True:
            wide = "close"
        elif wide is False:
            wide = None
        if adjusted == "both":
            if wide:
                raise DatasetError(
                    "BAD_REQUEST", "adjusted='both' 不能与 wide 同时使用。"
                )
            raw_df = self.prices(
                symbols, start, end, adjusted=False, fields=fields, wide=None
            )
            adj_df = self.prices(
                symbols, start, end, adjusted=True, fields=fields, wide=None
            )
            combined = pd.concat([raw_df, adj_df], ignore_index=True)
            combined.attrs.update(
                dataset_version=self.id,
                adjusted="both",
                cutoff=self.cutoff,
                source_asof=self.source_asof,
            )
            return combined

        adj_bool = bool(adjusted)
        whole = symbols is None or symbols == "all"
        ids = self.resolve(symbols)
        start_s, end_s = _range(start, end)
        columns = _columns(fields, wide)
        cache_key = (
            "prices",
            None if whole else tuple(ids),
            start_s,
            end_s,
            adj_bool,
            tuple(columns),
            wide,
        )
        if cache_key in self._df_cache:
            return _copy_frame(self._df_cache[cache_key])

        before = self._client._mark()
        parts = self._parts("all" if adj_bool else "raw", None if whole else ids)
        paths = [str(self._client._part(item)) for item in parts]
        clauses = [] if whole else [pads.field("asset_id").isin(ids)]
        if start_s:
            clauses.append(pads.field("date") >= start_s)
        if end_s:
            clauses.append(pads.field("date") <= end_s)
        condition = None
        for clause in clauses:
            condition = clause if condition is None else condition & clause
        if paths:
            table = pads.dataset(paths, format="parquet").to_table(
                columns=columns, filter=condition
            )
            table = table.sort_by([("asset_id", "ascending"), ("date", "ascending")])
        else:
            table = pa.table({name: [] for name in columns})
        basis = "复权" if adj_bool else "原始"
        self._client._say(
            before,
            f"{self.id[:8]} {basis} {len(ids):,} 个证券 {table.num_rows:,} 行 / {len(parts)} 个分片",
        )
        attrs = {
            "dataset_version": self.id,
            "adjusted": adj_bool,
            "cutoff": self.cutoff,
            "source_asof": self.source_asof,
        }
        frame = _frame(table, wide, ids, attrs)
        self._df_cache[cache_key] = frame
        return _copy_frame(frame)

    def events(
        self,
        symbols: str | Sequence[str] | None = None,
        start: str | date | None = None,
        end: str | date | None = None,
        *,
        sources: str | Sequence[str] | None = None,
    ) -> pd.DataFrame:
        """Events frozen in this version: SEC filings, corporate actions, news metadata and the earnings calendar."""
        families = self.manifest.get("data_families")
        if isinstance(families, dict) and "events" in families:
            self._require_family("events")
        before = self._client._mark()
        start_s, end_s = _range(start, end)
        paths = [
            str(self._client._part(item))
            for item in self._family_parts("events", start=start_s, end=end_s)
        ]
        if not paths:
            return pd.DataFrame()
        wanted = (
            None
            if (symbols is None or symbols == "all")
            else set(self.resolve(symbols))
        )
        source_list = (
            ([sources] if isinstance(sources, str) else list(sources))
            if sources
            else None
        )
        ds = pads.dataset(paths, format="parquet")
        names = set(ds.schema.names)
        if source_list and "source" not in names and "sec" not in source_list:
            table = pa.Table.from_batches([], schema=ds.schema)
        else:
            scalar_filters: list[tuple[str, Sequence[Any]]] = []
            if source_list and "source" in names:
                scalar_filters.append(("source", source_list))
            asset_ids_wanted = None
            if wanted is not None:
                if "asset_ids" in names:
                    asset_ids_wanted = wanted
                elif "symbol" in names:
                    allowed_symbols = [
                        asset["symbol"]
                        for asset in self.manifest["universe"]
                        if asset["asset_id"] in wanted
                    ]
                    scalar_filters.append(("symbol", allowed_symbols))
            table = _scan_batches(
                ds,
                scalar_filters=scalar_filters,
                asset_ids_wanted=asset_ids_wanted,
                time_col="filing_date" if "event_date" not in names else None,
                start=start_s,
                end=end_s,
                event_date_fallback="event_date" in names,
            )
        frame = table.to_pandas()
        if "source" not in frame:
            frame = frame.assign(source="sec", event_date=frame["filing_date"])
        frame = frame.reset_index(drop=True)
        if "available_session" in frame:
            frame["available_session"] = pd.to_datetime(
                frame["available_session"], format="%Y-%m-%d", errors="coerce"
            )
        elif not self._client.quiet:
            print(
                "research_datasets · 这个版本冻结得较早，没有 available_session 列；直接用事件日期可能引入未来信息。"
            )
        self._client._say(before, f"{self.id[:8]} 事件 {len(frame):,} 条")
        frame.attrs.update(dataset_version=self.id)
        return frame

    def family(
        self,
        name: str,
        symbols: str | Sequence[str] | None = None,
        start: str | date | None = None,
        end: str | date | None = None,
        *,
        columns: Sequence[str] | None = None,
    ) -> pd.DataFrame:
        """Any frozen family registered in FAMILY_SPECS, filtered by security and part clock.

        A family this SDK does not know, or a newer family schema, raises CLIENT_TOO_OLD
        only when it is read; the rest of the version stays readable.
        """
        if name in {"raw", "all"}:
            raise DatasetError("BAD_REQUEST", "价格请用 prices()。")
        if name == "events":
            # events keeps its own reader: list links, legacy layouts and date fallback.
            frame = self.events(symbols, start, end)
            if columns is None or frame.columns.empty:
                return frame
            columns = list(dict.fromkeys(columns))
            if not columns or any(not isinstance(column, str) for column in columns):
                raise DatasetError("BAD_REQUEST", "columns 需要非空的列名列表。")
            missing = sorted(set(columns) - set(frame.columns))
            if missing:
                raise DatasetError("BAD_REQUEST", f"events 没有这些列：{missing}。")
            selected = frame[columns].copy()
            selected.attrs.update(frame.attrs)
            return selected
        return self._read_family(
            name, symbols=symbols, start=start, end=end, columns=columns
        )

    def event_observations(
        self,
        symbols: str | Sequence[str] | None = None,
        start: str | date | None = None,
        end: str | date | None = None,
        *,
        columns: Sequence[str] | None = None,
    ) -> pd.DataFrame:
        """Frozen observation versions, including removed links, by observation_recorded_at date.

        ``columns`` keeps only those of the requested columns this version has.
        """
        return self._read_family(
            "event_observations",
            symbols=symbols,
            start=start,
            end=end,
            columns=columns,
            optional_columns=True,
        )

    def source_checks(self, symbols: str | Sequence[str] | None = None) -> pd.DataFrame:
        """Per-security source check records frozen in this version."""
        return self._read_family("source_checks", symbols=symbols)

    def price_coverage(
        self, symbols: str | Sequence[str] | None = None
    ) -> pd.DataFrame:
        """Per-security price coverage records frozen in this version."""
        return self._read_family("price_coverage", symbols=symbols)

    def security_history(
        self,
        symbols: str | Sequence[str] | None = None,
        start: str | date | None = None,
        end: str | date | None = None,
    ) -> pd.DataFrame:
        """Point-in-time security history filtered by observed_at date bounds."""
        return self._read_family(
            "security_history", symbols=symbols, start=start, end=end
        )

    def earnings(
        self,
        symbols: str | Sequence[str] | None = None,
        start: str | date | None = None,
        end: str | date | None = None,
    ) -> pd.DataFrame:
        """All frozen earnings observation versions by observed_at date; no latest/as-of selection.

        For point-in-time calendar snapshots use ``earnings_calendar(asof=...)``; for
        filing-derived announcement timing and volume confirmation use ``earnings_announcements()``.
        """
        return self._read_family(
            "earnings_observations", symbols=symbols, start=start, end=end
        )

    def earnings_announcements(
        self,
        symbols: str | Sequence[str] | None = None,
        start: str | date | None = None,
        end: str | date | None = None,
        *,
        columns: Sequence[str] | None = None,
    ) -> pd.DataFrame:
        """Frozen earnings announcement rows derived from SEC filings and dollar-volume reaction."""
        return self._read_family(
            "earnings_announcements",
            symbols=symbols,
            start=start,
            end=end,
            columns=columns,
        )

    def earnings_calendar(
        self,
        symbols: str | Sequence[str] | None = None,
        *,
        asof: Any = None,
        include_unlinked: bool = False,
    ) -> pd.DataFrame:
        """Latest earnings calendar row per ``(asset_id, fiscal_year, fiscal_quarter)`` as of ``asof``."""
        frame = _earnings_calendar_asof(
            self.event_observations(symbols),
            self.earnings(symbols),
            asof,
            include_unlinked=include_unlinked,
        )
        if not frame.empty and symbols is not None and symbols != "all":
            wanted = {str(aid) for aid in self.resolve(symbols)}
            frame = frame[frame["asset_id"].astype(str).isin(wanted)].reset_index(
                drop=True
            )
        return frame

    def sec_event_specs(
        self,
        *,
        prefix: str = "sec_kind_",
        fallback: bool = False,
    ) -> tuple[EventSpec, ...]:
        """Build typed SEC ``EventSpec`` definitions from this dataset's manifest vocabulary."""
        return _sec_event_specs(self, prefix=prefix, fallback=fallback)

    def _expand_by_asset(
        self, frame: pd.DataFrame, symbols: str | Sequence[str] | None
    ) -> pd.DataFrame:
        if frame.empty or "cik" not in frame.columns:
            return frame
        sec = self.securities(symbols, verified_only=True)
        if sec.empty:
            return frame
        cols = [c for c in ("asset_id", "symbol", "cik") if c in sec.columns]
        mapping = sec[cols].copy()
        mapping["cik"] = mapping["cik"].astype(str).str.zfill(10)
        expanded = mapping.merge(frame, on="cik", how="inner")
        expanded.attrs.update(frame.attrs)
        return expanded.reset_index(drop=True)

    def fundamentals(
        self,
        symbols: str | Sequence[str] | None = None,
        metrics: str | Sequence[str] | None = None,
        *,
        tags: str | Sequence[str] | None = None,
        columns: Sequence[str] | None = None,
        period_kind: str | Sequence[str] | None = None,
        active_only: bool = False,
        by_asset: bool = False,
    ) -> pd.DataFrame:
        """All frozen fact observation versions for frozen verified issuers.

        Optional filters:
        - ``tags``: XBRL tag name or sequence of tag names.
        - ``period_kind``: ``"quarter"``, ``"annual"``, ``"instant"``, or sequence of period kinds.
        - ``active_only=True``: filter to ``is_retracted == False``.
        - ``by_asset=True``: expand CIK-keyed facts to ``(asset_id, symbol)`` rows (for dual-class shares).
        """
        metric_list: list[str] | None = None
        if metrics is not None:
            metric_list = [metrics] if isinstance(metrics, str) else list(metrics)
            if not metric_list or any(
                not isinstance(metric, str) or not metric for metric in metric_list
            ):
                raise DatasetError("BAD_REQUEST", "metrics 需要非空的指标名称。")
        tag_list: list[str] | None = None
        if tags is not None:
            tag_list = [tags] if isinstance(tags, str) else list(tags)
            if not tag_list or any(
                not isinstance(tag, str) or not tag for tag in tag_list
            ):
                raise DatasetError("BAD_REQUEST", "tags 需要非空的标签名称。")
        frame = self._read_family(
            "fundamentals",
            symbols=symbols,
            metrics=metric_list,
            tags=tag_list,
            columns=columns,
        )
        if not frame.empty:
            if period_kind is not None and "period_kind" in frame.columns:
                kinds = (
                    {period_kind} if isinstance(period_kind, str) else set(period_kind)
                )
                frame = frame[frame["period_kind"].isin(kinds)].reset_index(drop=True)
            if active_only and "is_retracted" in frame.columns:
                frame = frame[frame["is_retracted"].eq(False)].reset_index(drop=True)
            if by_asset:
                frame = self._expand_by_asset(frame, symbols)
        return frame

    def iter_fundamentals(
        self,
        ciks: Sequence[str] | None = None,
        *,
        tags: Sequence[str] | None = None,
        columns: Sequence[str] | None = None,
    ) -> Iterator[pd.DataFrame]:
        """Yield per-part ``fundamentals`` frames with bounded memory."""
        self._require_family("fundamentals")
        identities: list[str] | None = None
        if ciks is not None:
            identities = [str(c).strip().zfill(10) for c in ciks if str(c).strip()]
            if not identities:
                return
        parts = self._family_parts("fundamentals", identities=identities)
        for item in parts:
            path = str(self._client._part(item))
            ds = pads.dataset([path], format="parquet")
            names = set(ds.schema.names)
            proj = None
            if columns is not None:
                proj = [name for name in dict.fromkeys(columns) if name in names]
            scalar_filters: list[tuple[str, Sequence[Any]]] = []
            if identities is not None and "cik" in names:
                scalar_filters.append(("cik", identities))
            if tags is not None and "tag" in names:
                scalar_filters.append(("tag", list(tags)))
            table = _scan_batches(ds, scalar_filters=scalar_filters, columns=proj)
            if table.num_rows > 0:
                yield table.to_pandas().reset_index(drop=True)

    def financial_checks(
        self,
        symbols: str | Sequence[str] | None = None,
        *,
        by_asset: bool = False,
    ) -> pd.DataFrame:
        """All frozen issuer check history, with requested windows and original check clocks."""
        frame = self._read_family("financial_checks", symbols=symbols)
        if by_asset and not frame.empty:
            frame = self._expand_by_asset(frame, symbols)
        return frame

    def issuer_profiles(
        self,
        symbols: str | Sequence[str] | None = None,
        *,
        start: str | date | None = None,
        end: str | date | None = None,
        columns: Sequence[str] | None = None,
        by_asset: bool = False,
    ) -> pd.DataFrame:
        """Frozen SEC issuer submission profiles (observations keyed by CIK)."""
        frame = self._read_family(
            "issuer_profiles",
            symbols=symbols,
            start=start,
            end=end,
            columns=columns,
        )
        if by_asset and not frame.empty:
            frame = self._expand_by_asset(frame, symbols)
        return frame

    def share_classes(
        self,
        symbols: str | Sequence[str] | None = None,
        *,
        columns: Sequence[str] | None = None,
        by_asset: bool = False,
    ) -> pd.DataFrame:
        """Frozen cover-page class share counts keyed by CIK."""
        frame = self._read_family("share_classes", symbols=symbols, columns=columns)
        if by_asset and not frame.empty:
            frame = self._expand_by_asset(frame, symbols)
        return frame

    def share_class_checks(
        self,
        symbols: str | Sequence[str] | None = None,
        *,
        start: str | date | None = None,
        end: str | date | None = None,
        columns: Sequence[str] | None = None,
        by_asset: bool = False,
    ) -> pd.DataFrame:
        """Frozen cover-page parsing check records keyed by CIK."""
        frame = self._read_family(
            "share_class_checks",
            symbols=symbols,
            start=start,
            end=end,
            columns=columns,
        )
        if by_asset and not frame.empty:
            frame = self._expand_by_asset(frame, symbols)
        return frame

    def corporate_actions(
        self,
        symbols: str | Sequence[str] | None = None,
        start: str | date | None = None,
        end: str | date | None = None,
        *,
        columns: Sequence[str] | None = None,
    ) -> pd.DataFrame:
        """Frozen structured corporate actions linked per security and participant role."""
        return self._read_family(
            "corporate_actions",
            symbols=symbols,
            start=start,
            end=end,
            columns=columns,
        )

    def total_returns(
        self,
        symbols: str | Sequence[str] | None = None,
        start: str | date | None = None,
        end: str | date | None = None,
        *,
        columns: Sequence[str] | None = None,
    ) -> pd.DataFrame:
        """Frozen daily total-return series, split indices, and terminal rows."""
        return self._read_family(
            "daily_returns",
            symbols=symbols,
            start=start,
            end=end,
            columns=columns,
        )

    def return_reconciliation(
        self,
        symbols: str | Sequence[str] | None = None,
        start: str | date | None = None,
        end: str | date | None = None,
        *,
        columns: Sequence[str] | None = None,
    ) -> pd.DataFrame:
        """Frozen session-level return reconciliation rows."""
        return self._read_family(
            "return_reconciliation",
            symbols=symbols,
            start=start,
            end=end,
            columns=columns,
        )

    def cik_at(
        self,
        asset_ids: Sequence[str],
        sessions: Sequence[str | date],
    ) -> pd.Series:
        """Point-in-time verified 10-digit CIK per ``(asset_id, session)``."""
        return _cik_at(self, asset_ids, sessions)

    def asset_at(self, symbol: str, session: str | date) -> str | None:
        """Resolve ``symbol`` to ``asset_id`` at ``session`` using ``symbol_history``."""
        return _asset_at(self, symbol, session)

    def fundamental_states(
        self,
        *,
        time_policy: str,
        ciks: Sequence[str] | None = None,
        concepts: Sequence[str] | None = None,
        views: Sequence[str] | None = None,
    ) -> pd.DataFrame:
        """Point-in-time derived financial statement state timeline."""
        return _fundamental_states(
            self,
            time_policy=time_policy,
            ciks=ciks,
            concepts=concepts,
            views=views,
        )

    def derived_fundamentals(
        self,
        candidates_or_symbols: pd.DataFrame | str | Sequence[str] | None = None,
        *,
        time_policy: str,
        start: str | date | None = None,
        end: str | date | None = None,
        views: Sequence[str] | None = None,
        stale_after_days: Mapping[str, int] | None = None,
        provenance: bool = False,
    ) -> pd.DataFrame:
        """Join derived point-in-time fundamentals onto ``samples`` or candidate symbols."""
        samples = (
            candidates_or_symbols
            if isinstance(candidates_or_symbols, pd.DataFrame)
            else self.candidates(candidates_or_symbols, start=start, end=end)
        )
        return _derived_fundamentals(
            self,
            samples,
            time_policy=time_policy,
            views=views,
            stale_after_days=stale_after_days,
            provenance=provenance,
        )

    def fiscal_quarters(
        self,
        *,
        time_policy: str,
        concepts: Sequence[str] = ("eps_diluted", "eps_basic", "net_income", "revenue"),
        symbols: str | Sequence[str] | None = None,
    ) -> pd.DataFrame:
        """Point-in-time quarterly ledger recording first-known and latest values per quarter."""
        whole = symbols is None or symbols == "all"
        ciks = None if whole else self._issuer_ids(symbols)[0]
        return _fiscal_quarters(
            self,
            time_policy=time_policy,
            concepts=concepts,
            ciks=ciks,
        )

    def fundamental_factors(
        self,
        derived_or_symbols: pd.DataFrame | str | Sequence[str] | None = None,
        *,
        time_policy: str | None = None,
        start: str | date | None = None,
        end: str | date | None = None,
    ) -> pd.DataFrame:
        """Statement-only quality, margin, growth, and balance-sheet factors."""
        if isinstance(derived_or_symbols, pd.DataFrame) and any(
            str(col).endswith("_value") for col in derived_or_symbols.columns
        ):
            return _fundamental_factors(derived_or_symbols)
        if time_policy is None:
            raise ValueError(
                "time_policy is required when computing derived fundamentals"
            )
        derived = self.derived_fundamentals(
            derived_or_symbols,
            time_policy=time_policy,
            start=start,
            end=end,
        )
        return _fundamental_factors(derived)

    def valuation(
        self,
        candidates_or_symbols: pd.DataFrame | str | Sequence[str] | None = None,
        derived: pd.DataFrame | None = None,
        *,
        time_policy: str,
        start: str | date | None = None,
        end: str | date | None = None,
        prices: pd.DataFrame | None = None,
        split_events: pd.DataFrame | None = None,
        fx: pd.DataFrame | None = None,
        provenance: bool = False,
    ) -> pd.DataFrame:
        """Compute point-in-time market values, enterprise value, and valuation yields."""
        samples = (
            candidates_or_symbols
            if isinstance(candidates_or_symbols, pd.DataFrame)
            else self.candidates(candidates_or_symbols, start=start, end=end)
        )
        return _valuation(
            self,
            samples,
            derived,
            time_policy=time_policy,
            prices=prices,
            split_events=split_events,
            fx=fx,
            provenance=provenance,
        )

    def industry(
        self,
        candidates_or_symbols: pd.DataFrame | str | Sequence[str] | None = None,
        *,
        time_policy: str,
        start: str | date | None = None,
        end: str | date | None = None,
    ) -> pd.DataFrame:
        """Attach SIC, division, Fama-French 12, and non-PIT metadata onto samples."""
        samples = (
            candidates_or_symbols
            if isinstance(candidates_or_symbols, pd.DataFrame)
            else self.candidates(candidates_or_symbols, start=start, end=end)
        )
        return _industry(self, samples, time_policy=time_policy)

    def audit(
        self,
        symbols: str | Sequence[str] | None = None,
        *,
        strict: bool = False,
    ) -> pd.DataFrame:
        """Audit frozen bundle integrity, issuer CIK mappings, financial checks, and fact observations.

        Returns a per-security ``pd.DataFrame`` with summary diagnostics in ``df.attrs["summary"]``.
        When ``strict=True``, raises ``DatasetError("INTEGRITY", ...)`` if any check fails.
        """
        sec = self.securities(symbols)
        ids = sec["asset_id"].tolist() if not sec.empty else []
        families = self.manifest.get("data_families", {})
        has_fundamentals = isinstance(families, dict) and "fundamentals" in families
        has_fin_checks = isinstance(families, dict) and "financial_checks" in families

        facts = pd.DataFrame()
        checks = pd.DataFrame()
        verified_mask = (
            sec["issuer_mapping_status"].eq("verified")
            if "issuer_mapping_status" in sec.columns
            else pd.Series(False, index=sec.index)
        )
        if has_fundamentals and verified_mask.any():
            facts = self.fundamentals(ids)
        if has_fin_checks and verified_mask.any():
            checks = self.financial_checks(ids)

        def _is_finite_decimal(val: Any) -> bool:
            if not isinstance(val, str):
                return False
            try:
                return Decimal(val).is_finite()
            except (InvalidOperation, ValueError):
                return False

        fact_stats_by_cik: dict[str, dict[str, Any]] = {}
        obs_unique = True
        no_dup_seq = True
        all_active_finite = True
        if not facts.empty:
            obs_unique = bool(facts["observation_id"].is_unique)
            no_dup_seq = not bool(
                facts.duplicated(["fact_id", "observation_sequence"]).any()
            )
            for cik_val, group in facts.groupby("cik", observed=True):
                active = group[group["is_retracted"].eq(False)]
                finite_ok = bool(active["value"].map(_is_finite_decimal).all())
                all_active_finite &= finite_ok
                fact_stats_by_cik[str(cik_val).zfill(10)] = {
                    "total_facts": len(group),
                    "active_facts": len(active),
                    "retracted_facts": int(group["is_retracted"].sum()),
                    "finite_active_values": finite_ok,
                }

        check_by_cik: dict[str, dict[str, Any]] = {}
        if not checks.empty:
            for cik_val, group in checks.groupby("cik", observed=True):
                latest = group.sort_values("check_sequence").iloc[-1]
                check_by_cik[str(cik_val).zfill(10)] = {
                    "financial_check_status": str(latest.get("status", "")),
                    "fetch_performed": bool(latest.get("fetch_performed", False)),
                    "initial_check": bool(latest.get("initial", False)),
                    "check_sequence": int(latest.get("check_sequence", 0)),
                    "error_code": str(latest.get("error_code") or ""),
                }

        rows = []
        for record in sec.to_dict("records"):
            cik_raw = str(record.get("cik") or "")
            cik_padded = cik_raw.zfill(10) if cik_raw else ""
            status = str(record.get("issuer_mapping_status") or "")
            is_verified = status == "verified" and bool(
                re.fullmatch(r"[0-9]{10}", cik_padded)
            )
            f_stat = fact_stats_by_cik.get(
                cik_padded,
                {
                    "total_facts": 0,
                    "active_facts": 0,
                    "retracted_facts": 0,
                    "finite_active_values": True,
                },
            )
            c_stat = check_by_cik.get(
                cik_padded,
                {
                    "financial_check_status": "missing"
                    if is_verified
                    else "not_applicable",
                    "fetch_performed": False,
                    "initial_check": False,
                    "check_sequence": 0,
                    "error_code": "",
                },
            )
            rows.append(
                {
                    "asset_id": record["asset_id"],
                    "symbol": record.get("symbol", ""),
                    "cik": cik_padded if cik_raw else None,
                    "issuer_mapping_status": status,
                    "verified_issuer": is_verified,
                    **c_stat,
                    **f_stat,
                }
            )

        audit_df = pd.DataFrame(rows)
        cal = self.calendar if "calendar" in self.manifest else []
        summary = {
            "dataset_id": self.id,
            "manifest_sha256": self.manifest_sha256,
            "producer_build_sha": self.manifest.get("producer_build_sha"),
            "cutoff": self.cutoff,
            "calendar_first": cal[0] if cal else None,
            "calendar_last": cal[-1] if cal else None,
            "securities": len(self.manifest.get("universe", [])),
            "selected_securities": len(audit_df),
            "verified_issuers": int(
                audit_df.loc[audit_df["verified_issuer"], "cik"].nunique()
            )
            if not audit_df.empty
            else 0,
            "unmapped_securities": int((~audit_df["verified_issuer"]).sum())
            if not audit_df.empty
            else 0,
            "fact_rows": len(facts),
            "fact_issuers": int(facts["cik"].nunique()) if not facts.empty else 0,
            "observation_id_unique": obs_unique,
            "fact_sequence_unique": no_dup_seq,
            "active_facts_finite": all_active_finite,
            "metrics": sorted(facts["metric"].unique().tolist())
            if not facts.empty and "metric" in facts.columns
            else [],
            "period_kinds": facts.groupby("period_kind", observed=True).size().to_dict()
            if not facts.empty and "period_kind" in facts.columns
            else {},
            "check_statuses": checks.groupby("status", observed=True).size().to_dict()
            if not checks.empty and "status" in checks.columns
            else {},
            "family_rows": {
                name: spec.get("rows", spec.get("row_count"))
                for name, spec in (self.manifest.get("data_families") or {}).items()
                if isinstance(spec, dict)
            },
        }
        audit_df.attrs["summary"] = summary

        if strict:
            problems: list[str] = []
            if not audit_df.empty and not audit_df["verified_issuer"].all():
                bad = audit_df.loc[~audit_df["verified_issuer"], "symbol"].tolist()
                problems.append(f"unverified securities: {bad}")
            if not obs_unique:
                problems.append("duplicate observation_id in fundamentals")
            if not no_dup_seq:
                problems.append(
                    "duplicate (fact_id, observation_sequence) in fundamentals"
                )
            if not all_active_finite:
                problems.append("non-finite Decimal value in active fundamentals")
            if (
                has_fin_checks
                and not audit_df.empty
                and not audit_df["financial_check_status"]
                .isin({"checked", "not_changed"})
                .all()
            ):
                problems.append("financial_checks contains an unsuccessful status")
            if problems:
                raise DatasetError("INTEGRITY", "；".join(problems))

        return audit_df

    # -----------------------------------------------------------------------
    # Layer 2: Point-in-time (PIT) aligned research panels returning DataFrame
    # -----------------------------------------------------------------------

    def candidates(
        self,
        symbols: str | Sequence[str] | None = None,
        *,
        start: str | date | None = None,
        end: str | date | None = None,
        sampling: str = "daily",
        universe: str = "pit",
        keep_non_members: bool = False,
        benchmark: str | None = None,
        next_session: str | date | None = None,
    ) -> pd.DataFrame:
        """Return candidate rows with decision clocks and point-in-time membership."""
        return build_candidates(
            self,
            symbols,
            start=start,
            end=end,
            sampling=sampling,
            universe=universe,
            keep_non_members=keep_non_members,
            benchmark=benchmark,
            next_session=next_session,
        )

    def daily_features(
        self,
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
        """Return daily price/volume/event-count PIT features as a ``pd.DataFrame``."""
        return _daily_features(
            self,
            symbols,
            start=start,
            end=end,
            time_policy=time_policy,
            benchmark=benchmark,
            specs=specs,
            sampling=sampling,
            next_session=next_session,
        )

    def fundamental_features(
        self,
        candidates_or_symbols: pd.DataFrame | str | Sequence[str] | None = None,
        *,
        time_policy: str,
        start: str | date | None = None,
        end: str | date | None = None,
        metrics: Mapping[str, str] | Sequence[str] | None = None,
        period_kind: str | Sequence[str] = "quarter",
        provenance: bool = True,
    ) -> pd.DataFrame:
        """Return PIT-aligned fundamental features as a ``pd.DataFrame``."""
        return _fundamental_features(
            self,
            candidates_or_symbols,
            start=start,
            end=end,
            metrics=metrics,
            period_kind=period_kind,
            time_policy=time_policy,
            provenance=provenance,
        )

    def fundamental_ratios(
        self,
        candidates_or_symbols: pd.DataFrame | str | Sequence[str] | None = None,
        *,
        time_policy: str,
        start: str | date | None = None,
        end: str | date | None = None,
        currency: str = "USD",
        period_kind: str | Sequence[str] = "quarter",
        provenance: bool = True,
    ) -> pd.DataFrame:
        """Return PIT-aligned fundamental ratios as a ``pd.DataFrame``."""
        return _fundamental_ratios(
            self,
            candidates_or_symbols,
            start=start,
            end=end,
            currency=currency,
            period_kind=period_kind,
            time_policy=time_policy,
            provenance=provenance,
        )

    def forward_returns(
        self,
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
        time_policy: str | None = None,
    ) -> pd.DataFrame:
        """Return forward return labels as a ``pd.DataFrame`` without requiring split boundaries."""
        return _forward_returns(
            self,
            candidates_or_symbols,
            start=start,
            end=end,
            benchmark=benchmark,
            horizons=horizons,
            sampling=sampling,
            universe=universe,
            allow_static_universe=allow_static_universe,
            keep_non_members=keep_non_members,
            terminal_policy=terminal_policy,
            neutralize=neutralize,
            time_policy=time_policy,
        )

    def panel(
        self,
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
        include_sec_events: bool = True,
        include_earnings: bool = True,
        provenance_columns: bool = False,
        output_dir: str | Path | None = None,
    ) -> pd.DataFrame:
        """Build a unified PIT research ``pd.DataFrame`` combining daily, fundamental, ratio, and label columns."""
        return _panel(
            self,
            symbols,
            start=start,
            end=end,
            benchmark=benchmark,
            horizons=horizons,
            sampling=sampling,
            universe=universe,
            allow_static_universe=allow_static_universe,
            keep_non_members=keep_non_members,
            terminal_policy=terminal_policy,
            neutralize=neutralize,
            next_session=next_session,
            time_policy=time_policy,
            fundamental_time_policy=fundamental_time_policy,
            fundamentals=fundamentals,
            include_fundamentals=include_fundamentals,
            include_ratios=include_ratios,
            include_sec_events=include_sec_events,
            include_earnings=include_earnings,
            provenance_columns=provenance_columns,
            output_dir=output_dir,
        )

    def prepare(
        self, **kwargs: Any
    ) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame | None, dict[str, Any]]:
        """Backward-compatible wrapper around ``research_datasets.prepare(self, ...)``."""
        kwargs.setdefault("dataset_id", self.id)
        return _prepare(self, **kwargs)


Version = Dataset

__all__ = [
    "API",
    "FIELDS",
    "Client",
    "Dataset",
    "DatasetError",
    "Version",
    "__version__",
    "_prepare",
    "_prepare_fundamental_features",
    "_prepare_fundamental_ratios",
    "check_manifest",
    "connect",
    "load",
]

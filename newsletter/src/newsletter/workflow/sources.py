"""Supply public metadata leads, not independently read primary evidence.

Crossref journal endpoints and date filters:
https://www.crossref.org/documentation/retrieve-metadata/rest-api/
https://www.crossref.org/documentation/retrieve-metadata/rest-api/tips-for-using-the-crossref-rest-api/
Public list requests: one/second, serial, no retries (2026-07-21):
https://community.crossref.org/t/refining-rest-api-limits-for-improved-stability-and-reliability/16137
Nature RSS 1.0/RDF background: https://blogs.nature.com/blog/nature_web_feeds_a_new_look/
"""

from __future__ import annotations

import asyncio
from collections.abc import Mapping, Sequence
import dataclasses
import datetime
import email.utils as utils
import hashlib
import re
from typing import NotRequired, TypedDict
import urllib.parse as parse
import xml.etree.ElementTree as ElementTree

import httpx

import newsletter.contracts as contracts
import newsletter.errors as errors
import newsletter.model_io as model_io

MAX_FEED_BYTES = 1_000_000
_DOI = re.compile(r"10\.\d{4,9}/[^\s<>\"?#]+\Z", re.IGNORECASE)
_ARXIV = re.compile(
    "/(?:abs|pdf|html)/((?:\\d{4}\\.\\d{4,5}|[a-z-]+/\\d{7}))(v"
    "\\d+)?(?:\\.pdf)?/?\\Z"
)
_TRACKING = {"fbclid", "gclid", "mc_cid", "mc_eid"}


class Candidate(TypedDict):
    """Carry public discovery metadata without asserting verified findings."""

    id: str
    direction: str
    title: str
    url: str
    doi: str
    version: str
    event_key: str
    published_at: str
    summary: str
    why_now: str
    access_scope: str
    provenance: str
    # Additive public-proto fields. Omitted legacy fields mean unknown, not a
    # reason to rewrite a frozen candidate or its evidence hash on read.
    authors: NotRequired[str]
    affiliations: NotRequired[str]
    venue: NotRequired[str]
    publication_status: NotRequired[str]
    contribution: NotRequired[str]
    source_basis: NotRequired[str]
    evidence_urls: NotRequired[list[str]]


def normalize_doi(value: str) -> str:
    """Normalize a bounded DOI spelling or return an empty unknown value."""
    value = value.strip()
    if value.lower().startswith("doi:"):
        value = value[4:].strip()
    elif value.lower().startswith(
        ("https://doi.org/", "http://doi.org/", "https://dx.doi.org/")
    ):
        value = parse.unquote(parse.urlsplit(value).path.lstrip("/"))
    return value.lower() if len(value) <= 256 and _DOI.fullmatch(value) else ""


def identity_keys(value: Mapping[str, object]) -> set[str]:
    """Build comparison keys without rewriting provenance or citation URLs."""
    keys = set()
    doi = normalize_doi(str(value.get("doi", "")))
    if doi:
        keys.add("doi:" + doi)
    url = value.get("url", "")
    if isinstance(url, str) and url:
        try:
            contracts.validate_public_url(url)
            parsed = parse.urlsplit(url)
            if parsed.hostname in {"doi.org", "dx.doi.org"} and (
                derived := normalize_doi(parse.unquote(parsed.path.lstrip("/")))
            ):
                keys.add("doi:" + derived)
            if parsed.hostname in {
                "arxiv.org",
                "www.arxiv.org",
                "export.arxiv.org",
            } and (arxiv := _ARXIV.fullmatch(parsed.path)):
                keys.add("arxiv:" + arxiv[1].lower())
            query = parse.urlencode(
                sorted(
                    (key, item)
                    for key, item in parse.parse_qsl(
                        parsed.query, keep_blank_values=True
                    )
                    if not key.lower().startswith("utm_")
                    and key.lower() not in _TRACKING
                )
            )
            keys.add(
                "url:"
                + parse.urlunsplit(
                    (
                        parsed.scheme.lower(),
                        parsed.netloc.lower(),
                        parsed.path.rstrip("/"),
                        query,
                        "",
                    )
                )
            )
        except (ValueError, contracts.ContractError):
            pass
    event = value.get("event_key", "")
    if isinstance(event, str) and event.strip():
        keys.add("event:" + " ".join(event.lower().split()))
    title = value.get("title", "")
    if isinstance(title, str) and len(title.strip()) >= 12:
        keys.add("title:" + " ".join(title.casefold().split()))
    return keys


def candidate_id(value: Mapping[str, object]) -> str:
    """Derive a stable public identity with DOI and arXiv precedence."""
    keys = identity_keys(value)
    primary = next(
        (
            key
            for prefix in ("doi:", "arxiv:", "url:", "event:")
            for key in sorted(keys)
            if key.startswith(prefix)
        ),
        "",
    )
    if not primary:
        raise ValueError("Candidate has no public identity")
    return "candidate-" + hashlib.sha256(primary.encode()).hexdigest()[:24]


def deduplicate_candidates(
    candidates: Sequence[Candidate],
    history: Sequence[Mapping[str, object]] = (),
    *,
    limit: int = 30,
) -> list[Candidate]:
    """Suppress repeat coverage using stable public identity keys.

    Retain dated or new-version follow-ups only with explicit novelty reasons;
    watchlists guide selection, not repetition of unchanged items.
    """
    if not 1 <= limit <= 60:
        raise ValueError("Candidate limit must be 1..60")
    known = [(identity_keys(item), item) for item in history]
    result: list[Candidate] = []
    seen: set[str] = set()
    for candidate in candidates:
        keys = identity_keys(candidate)
        if not keys:
            continue
        if keys & seen:
            seen |= keys
            continue
        repeated = [item for old_keys, item in known if keys & old_keys]
        if repeated:
            updated = all(
                (
                    re.fullmatch(r"v[0-9]+", candidate["version"])
                    and re.fullmatch(r"v[0-9]+", str(old.get("version", "")))
                    and int(candidate["version"][1:])
                    > int(str(old["version"])[1:])
                )
                or (
                    candidate["published_at"]
                    and old.get("published_at")
                    and candidate["published_at"] > str(old["published_at"])
                )
                for old in repeated
            )
            if not updated or len(candidate["why_now"].strip()) < 20:
                seen |= keys
                continue
        result.append(candidate)
        seen |= keys
        if len(result) >= limit:
            break
    return result


@dataclasses.dataclass(frozen=True)
class MetadataResult:
    """Carry public feed candidates and finite retrieval diagnostics."""

    candidates: list[Candidate]
    diagnostics: list[str]


def _metadata_candidate(
    title: str, url: str, doi: str, published: str, provenance: str
) -> Candidate:
    contracts.validate_public_url(url)
    if not title.strip() or len(title) > 500 or any(ord(c) < 32 for c in title):
        raise ValueError("Invalid metadata title")
    candidate: Candidate = {
        "id": "",
        "direction": "02-science",
        "title": title.strip(),
        "url": url,
        "doi": normalize_doi(doi),
        "version": "",
        "event_key": "",
        "published_at": published,
        "summary": "公开出版元数据线索；尚未核验摘要、正文、方法或研究结果。",
        "why_now": (
            "出版日期来自供应商元数据，进入选题前须核对版本、"
            "日期与实际新增发现。"
        ),
        "access_scope": "metadata",
        "provenance": provenance,
    }
    candidate["id"] = candidate_id(candidate)
    return candidate


def parse_crossref(
    raw: bytes, issue_date: str, *, limit: int = 5
) -> list[Candidate]:
    """Extract bounded journal metadata, skipping malformed or future items."""
    contracts.validate_issue_date(issue_date)
    if not 1 <= limit <= 20:
        raise ValueError("Metadata limit must be 1..20")
    if len(raw) > MAX_FEED_BYTES:
        raise ValueError("Metadata response exceeds limit")
    value = model_io.load_json(raw.decode("utf-8"))
    message = value.get("message") if isinstance(value, dict) else None
    items = message.get("items") if isinstance(message, dict) else None
    if not isinstance(items, list) or len(items) > 100:
        raise ValueError("Invalid Crossref envelope")
    result = []
    for item in items:
        try:
            if (
                not isinstance(item, dict)
                or item.get("type") != "journal-article"
            ):
                continue
            doi = normalize_doi(item["DOI"])
            if not doi:
                continue
            published = ""
            for key in ("published-online", "published-print", "published"):
                parts = item.get(key, {}).get("date-parts", [[]])[0]
                if len(parts) == 3 and all(type(n) is int for n in parts):
                    published = datetime.date(*parts).isoformat()
                    break
            if published and published > issue_date:
                continue
            result.append(
                _metadata_candidate(
                    item["title"][0],
                    "https://doi.org/" + doi,
                    doi,
                    published,
                    "crossref_metadata",
                )
            )
        except (KeyError, TypeError, ValueError, IndexError, AttributeError):
            continue
        if len(result) >= limit:
            break
    return result


def parse_rss(
    raw: bytes, issue_date: str, *, limit: int = 5
) -> list[Candidate]:
    """Extract bounded RSS metadata without resolving external XML entities."""
    contracts.validate_issue_date(issue_date)
    if not 1 <= limit <= 20:
        raise ValueError("Metadata limit must be 1..20")
    if len(raw) > MAX_FEED_BYTES or any(
        token in raw.upper() for token in (b"<!DOCTYPE", b"<!ENTITY")
    ):
        raise ValueError("Unsafe or oversized RSS")
    root = ElementTree.fromstring(raw)
    result = []
    for item in root.iter():
        if item.tag.rsplit("}", 1)[-1] not in {"item", "entry"}:
            continue
        values = {child.tag.rsplit("}", 1)[-1]: child for child in item}
        try:
            title = "".join(values["title"].itertext()).strip()
            link = values["link"]
            url = (link.text or link.attrib.get("href", "")).strip()
            published = ""
            for key in ("date", "pubDate", "published", "updated"):
                if key in values and (stamp := values[key].text):
                    try:
                        published = datetime.date.fromisoformat(
                            stamp[:10]
                        ).isoformat()
                    except ValueError:
                        published = (
                            utils.parsedate_to_datetime(stamp)
                            .date()
                            .isoformat()
                        )
                    break
            if published and published > issue_date:
                continue
            doi = values.get("doi")
            result.append(
                _metadata_candidate(
                    title,
                    url,
                    doi.text or "" if doi is not None else "",
                    published,
                    "rss_metadata",
                )
            )
        except (KeyError, ValueError, TypeError, OverflowError):
            continue
        if len(result) >= limit:
            break
    return result


class PublicMetadataFeed:
    """Fetch three fixed public HTTPS paths, never returned or operator URLs.

    No credentials, proxies, redirects, retries, pagination or full text.
    Fixed hosts plus TLS verification prevent user-controlled SSRF destinations.
    Bound decompressed streams; failures yield diagnostics, not facts.
    """

    def __init__(
        self, *, transport: httpx.AsyncBaseTransport | None = None
    ) -> None:
        self.transport = transport

    async def fetch(self, issue_date: str) -> MetadataResult:
        """Fetch fixed public feeds once and retain per-feed diagnostics."""
        contracts.validate_issue_date(issue_date)
        since = (
            datetime.date.fromisoformat(issue_date)
            - datetime.timedelta(days=14)
        ).isoformat()
        candidates = []
        diagnostics = []
        specs = [
            (
                "crossref_nature",
                "https://api.crossref.org/journals/0028-0836/works",
            ),
            (
                "crossref_science",
                "https://api.crossref.org/journals/0036-8075/works",
            ),
            ("nature_rss", "https://www.nature.com/nature.rss"),
        ]
        async with httpx.AsyncClient(
            transport=self.transport,
            timeout=8,
            follow_redirects=False,
            trust_env=False,
            headers={
                "User-Agent": "personal-newsletter/0.1 public-metadata",
                "Accept-Encoding": "identity",
            },
        ) as client:
            for index, (name, url) in enumerate(specs):
                if index == 1:
                    await asyncio.sleep(
                        1.05
                    )  # Public Crossref list pool, not concurrent.
                params = (
                    {
                        "filter": (
                            f"from-pub-date:{since},"
                            f"until-pub-date:{issue_date},type:journal-article"
                        ),
                        "rows": "5",
                        "sort": "published",
                        "order": "desc",
                    }
                    if name.startswith("crossref")
                    else None
                )
                try:
                    async with asyncio.timeout(10):
                        async with client.stream(
                            "GET", url, params=params
                        ) as response:
                            if response.status_code != 200:
                                raise ValueError("Metadata unavailable")
                            raw = bytearray()
                            async for chunk in response.aiter_bytes():
                                raw.extend(chunk)
                                if len(raw) > MAX_FEED_BYTES:
                                    raise ValueError(
                                        "Metadata exceeds byte limit"
                                    )
                        parser = (
                            parse_crossref
                            if name.startswith("crossref")
                            else parse_rss
                        )
                        candidates.extend(parser(bytes(raw), issue_date))
                    diagnostics.append(name + ":metadata_only")
                except (
                    httpx.HTTPError,
                    ValueError,
                    TimeoutError,
                    ElementTree.ParseError,
                    UnicodeError,
                    errors.EditorError,
                ):
                    diagnostics.append(name + ":unavailable")
        return MetadataResult(deduplicate_candidates(candidates), diagnostics)

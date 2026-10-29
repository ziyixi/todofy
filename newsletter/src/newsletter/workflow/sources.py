"""Supply public metadata leads, not independently read primary evidence.

Candidate identity, history deduplication and the metadata-only lead shape.
Fetching and parsing the configured public feeds lives in ``researcher``.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
import dataclasses
import hashlib
import re
from typing import NotRequired, TypedDict
import urllib.parse as parse

import newsletter.contracts as contracts
import newsletter.types as types

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
    """Carry public feed candidates and finite retrieval diagnostics.

    ``notes`` maps a candidate ID to untrusted feed context (an excerpt and
    ranking signals). It is additive: older artifacts have no notes, and notes
    never enter a Candidate, the candidate pool or Notion.

    ``sources`` holds one content-free count record per fetched registry
    source (id, outcome code, parsed entries, accepted entries, routed seeds,
    truncation) for the owner console. It is also additive: older artifacts
    lack it, and no workflow node reads it.
    """

    candidates: list[Candidate]
    diagnostics: list[str]
    notes: dict[str, types.Payload] = dataclasses.field(default_factory=dict)
    sources: list[types.Payload] = dataclasses.field(default_factory=list)


def metadata_candidate(
    title: str,
    url: str,
    doi: str,
    published: str,
    provenance: str,
    *,
    direction: str,
    version: str = "",
    venue: str = "",
    source_basis: str = "",
) -> Candidate:
    """Build a metadata-only lead whose summary never repeats feed text.

    Titles are collapsed to one line; venue and source basis are code-written
    attribution, omitted when empty so frozen hashes keep their old shape.
    """
    title = " ".join(title.split())
    contracts.validate_public_url(url)
    if not title or len(title) > 500 or any(ord(c) < 32 for c in title):
        raise ValueError("Invalid metadata title")
    candidate: Candidate = {
        "id": "",
        "direction": direction,
        "title": title,
        "url": url,
        "doi": normalize_doi(doi),
        "version": version,
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
    if venue:
        candidate["venue"] = venue
    if source_basis:
        candidate["source_basis"] = source_basis
    candidate["id"] = candidate_id(candidate)
    return candidate

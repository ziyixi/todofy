"""Read a frozen registry of public feeds into routed metadata-only leads.

Registry (``researcher.yaml``, frozen with the run's content configuration)
→ per-host serial fetch → parse → filter → merge by identity keys → rank →
route per discovery direction. Every lead is a metadata-scope Candidate with a
code-written source basis; feed text survives only as a short untrusted excerpt
in ``notes``, never in a Candidate, the candidate pool or Notion. There is no
model call, no retry and no state between runs.

Fetch policy: only registry URLs, HTTPS with TLS verification, no redirects,
no proxies or credentials, every resolved address globally routable and the
connection pinned to the checked address, streamed byte caps, a per-request
timeout and an internal deadline that keeps finished sources.

arXiv API terms (one request every three seconds, one connection at a time):
https://info.arxiv.org/help/api/tou.html
Crossref public pool: serial, polite, no retries (see the Crossref REST API
tips: https://www.crossref.org/documentation/retrieve-metadata/rest-api/).
Hugging Face daily papers is an undocumented public endpoint and optional.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable, Iterable, Mapping, Sequence
import dataclasses
import datetime
import email.utils as utils
import html
import ipaddress
import itertools
import json
import logging
import re
import socket
from typing import Any
import urllib.parse as parse
import xml.etree.ElementTree as ElementTree

import httpx
import yaml

import newsletter.contracts as contracts
import newsletter.errors as errors
import newsletter.types as types
import newsletter.workflow.content as content
import newsletter.workflow.sources as sources

_LOGGER = logging.getLogger(__name__)

REGISTRY_FILE = "researcher.yaml"
KINDS = frozenset({"feed", "arxiv", "crossref", "hf_daily"})
MAX_SOURCES = 80
MAX_SEEDS_PER_DIRECTION = 20
MAX_ARTIFACT_BYTES = 256 * 1024
MIN_SOURCE_BYTES = 64 * 1024
MAX_SOURCE_BYTES = 4 * 1024 * 1024
DEFAULT_SOURCE_BYTES = 1024 * 1024
MAX_ENTRIES = 200
EXCERPT_CHARS = 300
ABSTRACT_CHARS = 80
REQUEST_SECONDS = 15
HOST_CHAINS = 4
USER_AGENT = "personal-newsletter/0.1 public-metadata"
# Seconds between consecutive requests to one host.
HOST_SPACING = {"export.arxiv.org": 3.0, "api.crossref.org": 3.0}
DEFAULT_SPACING = 1.0
# Finite per-source outcome codes; everything except ``ok`` is a failure.
FAILURES = frozenset(
    {
        "http_error",
        "too_large",
        "parse_error",
        "timeout",
        "unavailable",
        "unsafe_address",
        "deadline",
    }
)

_ID = re.compile(r"[a-z0-9][a-z0-9-]{0,63}\Z")
_REQUIRED = frozenset({"id", "name", "direction", "kind", "url"})
_OPTIONAL = frozenset(
    {
        "query",
        "keywords",
        "requires_abstract",
        "max_seeds",
        "max_bytes",
        "max_age_days",
        "enabled",
    }
)
_ARXIV_HOSTS = frozenset({"arxiv.org", "www.arxiv.org", "export.arxiv.org"})
_ARXIV_PATH = re.compile(
    r"/(?:abs|pdf|html)/((?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?/\d{7}))"
    r"(v\d+)?(?:\.pdf)?/?\Z"
)
_ARXIV_ID = re.compile(
    r"((?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?/\d{7}))(v\d+)?\Z"
)
_TRACKING = frozenset(
    {
        "fbclid",
        "gclid",
        "mc_cid",
        "mc_eid",
        "ref_src",
        "cmpid",
        "at_medium",
        "at_campaign",
        "ocid",
    }
)
# Blocks dropped with their text: comments, scripts, styles and JATS
# headings ("Abstract"). Found by a linear scan, never a lazy regex, so a
# hostile body with many unclosed openers cannot stall the event loop.
_BLOCK = re.compile(r"<!--|<(script|style|jats:title)(?=[\s/>])", re.IGNORECASE)
# Tags and markup declarations such as <!DOCTYPE html> inside feed HTML.
_TAG = re.compile(r"</?[A-Za-z][\w:.-]*(?:\s[^<>]*)?/?>|<![A-Za-z][^<>]*>")
_RDF_ABOUT = "{http://www.w3.org/1999/02/22-rdf-syntax-ns#}about"
# NAT64 well-known prefix: Python calls it global, but it embeds an IPv4
# destination that must be global too.
_NAT64 = ipaddress.ip_network("64:ff9b::/96")
# A merged lead names at most this many feeds in its source basis.
_BASIS_NAMES = 5
_DATE_FIELDS = ("date", "pubDate", "published", "publicationDate", "updated")
_BODY_FIELDS = ("encoded", "content", "description", "summary")

Resolver = Callable[[str], Awaitable[Sequence[str]]]
Sleep = Callable[[float], Awaitable[None]]


class RegistryError(ValueError):
    """Reject an invalid registry without echoing its contents."""

    def __init__(self) -> None:
        super().__init__("RESEARCHER_REGISTRY_INVALID")


@dataclasses.dataclass(frozen=True)
class Source:
    """One validated registry source and its bounded fetch settings."""

    index: int
    id: str
    name: str
    direction: str
    kind: str
    url: str
    query: str
    keywords: tuple[re.Pattern[str], ...]
    requires_abstract: bool
    max_seeds: int
    max_bytes: int
    max_age_days: int
    enabled: bool


@dataclasses.dataclass(frozen=True)
class Entry:
    """One parsed feed item before filtering; all text is untrusted."""

    title: str
    url: str
    doi: str
    version: str
    published: str
    text: str
    excerpt: bool
    upvotes: int | None = None


@dataclasses.dataclass
class _Outcome:
    code: str
    entries: list[Entry]
    truncated: bool = False


@dataclasses.dataclass
class _Lead:
    candidate: sources.Candidate
    source: Source
    position: int
    names: list[str]
    excerpt: str
    percentile: int | None

    def rank(self) -> tuple[int, int, int, int, int]:
        day = datetime.date.fromisoformat(self.candidate["published_at"])
        return (
            -len(self.names),
            -(self.percentile if self.percentile is not None else -1),
            -day.toordinal(),
            self.source.index,
            self.position,
        )


class _FetchError(Exception):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


# Registry validation.


def _label(value: object, limit: int) -> str:
    if (
        not isinstance(value, str)
        or not value.strip()
        or value != value.strip()
        or len(value) > limit
        or any(not c.isprintable() for c in value)
    ):
        raise RegistryError()
    return value


def _integer(value: object, low: int, high: int) -> int:
    if type(value) is not int or not low <= value <= high:
        raise RegistryError()
    return value


def _flag(value: object) -> bool:
    if type(value) is not bool:
        raise RegistryError()
    return value


def compile_keyword(keyword: object) -> re.Pattern[str]:
    """Compile Brief's keyword rule: words, a trailing *, capitals exact.

    A keyword matches as a whole word or phrase; ``fault*`` matches the start
    of a word (faults, not default); a keyword written with capitals matches
    case-sensitively (``AI`` matches AI, not said); others ignore case.
    """
    text = _label(keyword, 80)
    star = text.endswith("*")
    body = (text[:-1] if star else text).strip()
    if not body or "*" in body:
        raise RegistryError()
    words = r"\s+".join(re.escape(word) for word in body.split())
    tail = r"[^\W_]*" if star else r"(?![^\W_])"
    flags = 0 if body != body.lower() else re.IGNORECASE
    return re.compile(r"(?<![^\W_])" + words + tail, flags)


def _registry_url(value: object, kind: str) -> str:
    url = _label(value, 512)
    try:
        contracts.validate_public_url(url)
    except contracts.ContractError:
        raise RegistryError() from None
    parsed = parse.urlsplit(url)
    host = parsed.hostname or ""
    try:
        ipaddress.ip_address(host)
    except ValueError:
        pass
    else:
        raise RegistryError()
    if (
        parsed.scheme != "https"
        or parsed.port is not None
        or parsed.fragment
        or (parsed.query and kind != "feed")
    ):
        raise RegistryError()
    return url


def _source(index: int, item: object, directions: frozenset[str]) -> Source:
    if not isinstance(item, dict) or not (
        _REQUIRED <= set(item) <= _REQUIRED | _OPTIONAL
    ):
        raise RegistryError()
    identifier, kind, direction = item["id"], item["kind"], item["direction"]
    if (
        not isinstance(identifier, str)
        or not _ID.fullmatch(identifier)
        or not isinstance(kind, str)
        or kind not in KINDS
        or not isinstance(direction, str)
        or direction not in directions
        or (kind == "arxiv") != ("query" in item)
    ):
        raise RegistryError()
    keywords = item.get("keywords", [])
    if not isinstance(keywords, list) or len(keywords) > 40:
        raise RegistryError()
    return Source(
        index=index,
        id=identifier,
        name=_label(item["name"], 80),
        direction=direction,
        kind=kind,
        url=_registry_url(item["url"], kind),
        query=_label(item["query"], 1000) if kind == "arxiv" else "",
        keywords=tuple(compile_keyword(word) for word in keywords),
        requires_abstract=_flag(item.get("requires_abstract", False)),
        max_seeds=_integer(item.get("max_seeds", 5), 1, 20),
        max_bytes=_integer(
            item.get("max_bytes", DEFAULT_SOURCE_BYTES),
            MIN_SOURCE_BYTES,
            MAX_SOURCE_BYTES,
        ),
        max_age_days=_integer(
            item.get("max_age_days", 4 if kind == "arxiv" else 7), 1, 30
        ),
        enabled=_flag(item.get("enabled", True)),
    )


def _strict_node(node: yaml.Node, depth: int = 0) -> None:
    if depth > 4:
        raise RegistryError()
    if isinstance(node, yaml.MappingNode):
        keys = []
        for key, value in node.value:
            if not isinstance(key, yaml.ScalarNode):
                raise RegistryError()
            keys.append(key.value)
            _strict_node(value, depth + 1)
        if len(set(keys)) != len(keys):
            raise RegistryError()
    elif isinstance(node, yaml.SequenceNode):
        for value in node.value:
            _strict_node(value, depth + 1)


def validate_registry(text: str, directions: Iterable[str]) -> list[Source]:
    """Validate a registry against the bundle's discovery directions.

    Unknown fields, anchors, aliases, tags and duplicate keys are refused, so
    a registry cannot smuggle settings the engine does not understand.

    Raises:
        RegistryError: The text is not a valid registry for these directions.
    """
    try:
        return _registry(text, frozenset(directions))
    except (
        yaml.YAMLError,
        RecursionError,
        UnicodeError,
        TypeError,
        ValueError,
    ):
        raise RegistryError() from None


def _registry(text: str, directions: frozenset[str]) -> list[Source]:
    if not isinstance(text, str) or len(text.encode()) > 100_000:
        raise RegistryError()
    for token in yaml.scan(text):
        if isinstance(
            token, (yaml.AliasToken, yaml.AnchorToken, yaml.TagToken)
        ):
            raise RegistryError()
    node = yaml.compose(text, Loader=yaml.SafeLoader)
    if node is None:
        raise RegistryError()
    _strict_node(node)
    value = yaml.safe_load(text)
    if (
        not isinstance(value, dict)
        or set(value) != {"version", "sources"}
        or type(value["version"]) is not int
        or value["version"] != 1
        or not isinstance(value["sources"], list)
        or not 1 <= len(value["sources"]) <= MAX_SOURCES
    ):
        raise RegistryError()
    result = [
        _source(index, item, directions)
        for index, item in enumerate(value["sources"])
    ]
    if len({source.id for source in result}) != len(result):
        raise RegistryError()
    return result


# Parsing. Feed text is untrusted: it becomes bounded leads, nothing else.


def _drop_blocks(text: str) -> str:
    """Drop comment, script, style and JATS title blocks in linear time.

    An unclosed block drops the rest of the text.
    """
    lowered = text.lower()
    parts = []
    position = 0
    while (match := _BLOCK.search(text, position)) is not None:
        parts.append(text[position : match.start()])
        if match[1] is None:
            end = lowered.find("-->", match.end())
            end = end + 3 if end >= 0 else -1
        else:
            end = lowered.find("</" + match[1].lower(), match.end())
            end = lowered.find(">", end) + 1 if end >= 0 else -1
        if end <= 0:
            return " ".join(parts)
        parts.append(" ")
        position = end
    parts.append(text[position:])
    return "".join(parts)


def clean_text(value: str, limit: int = 8000) -> str:
    """Return untrusted markup as one bounded line of plain text."""
    text = value[: limit * 20]
    for _ in range(2):
        text = html.unescape(_TAG.sub(" ", _drop_blocks(text)))
    text = "".join(c if c.isprintable() else " " for c in text)
    return " ".join(text.split())[:limit]


def _excerpt(text: str) -> str:
    if len(text) <= EXCERPT_CHARS:
        return text
    return text[: EXCERPT_CHARS - 1].rstrip() + "…"


def _local(tag: object) -> str:
    return tag.rsplit("}", 1)[-1] if isinstance(tag, str) else ""


def _date(value: str) -> str:
    value = value.strip()
    try:
        return datetime.date.fromisoformat(value[:10]).isoformat()
    except ValueError:
        pass
    try:
        return utils.parsedate_to_datetime(value).date().isoformat()
    except (TypeError, ValueError, IndexError, OverflowError):
        return ""


def canonical_url(value: str) -> tuple[str, str]:
    """Normalize a feed link and split an arXiv version from its abs URL.

    Tracking parameters and fragments are dropped and http becomes https, so
    the same work from two feeds shares one identity. Identity code in
    ``sources`` is unchanged; this only shapes what a feed hands over.
    """
    parsed = parse.urlsplit(value.strip())
    host = (parsed.hostname or "").lower()
    if host in _ARXIV_HOSTS and (match := _ARXIV_PATH.fullmatch(parsed.path)):
        return "https://arxiv.org/abs/" + match[1], match[2] or ""
    pairs = parse.parse_qsl(parsed.query, keep_blank_values=True)
    kept = [
        (key, item)
        for key, item in pairs
        if not key.lower().startswith("utm_")
        and key.lower() not in _TRACKING
        and not (key == "af" and item == "R")
    ]
    # Re-encode only when something was dropped; otherwise keep the bytes.
    query = parsed.query if kept == pairs else parse.urlencode(kept)
    scheme = "https" if parsed.scheme in {"http", "https"} else parsed.scheme
    return parse.urlunsplit((scheme, parsed.netloc, parsed.path, query, "")), ""


def _feed_link(element: ElementTree.Element) -> str:
    links = [child for child in element if _local(child.tag) == "link"]
    for link in links:
        if (link.text or "").strip():
            return (link.text or "").strip()
    fallback = ""
    for link in links:
        href = link.attrib.get("href", "").strip()
        if href and link.attrib.get("rel", "alternate") == "alternate":
            return href
        fallback = fallback or href
    return fallback or element.attrib.get(_RDF_ABOUT, "").strip()


def _feed_entry(element: ElementTree.Element) -> Entry | None:
    fields: dict[str, ElementTree.Element] = {}
    for child in element:
        fields.setdefault(_local(child.tag), child)
    title = fields.get("title")
    link = _feed_link(element)
    if title is None or not link:
        return None
    url, version = canonical_url(link)
    published = ""
    for name in _DATE_FIELDS:
        if name in fields and (stamp := "".join(fields[name].itertext())):
            published = _date(stamp)
            break
    doi = ""
    for name in ("doi", "identifier"):
        if name in fields:
            doi = sources.normalize_doi("".join(fields[name].itertext()))
            if doi:
                break
    body = next(
        (
            "".join(fields[name].itertext())
            for name in _BODY_FIELDS
            if name in fields and "".join(fields[name].itertext()).strip()
        ),
        "",
    )
    return Entry(
        title=clean_text("".join(title.itertext()), 1000),
        url=url,
        # An arXiv lead never carries a DOI: a 10.48550 or journal DOI could
        # disagree with an existing material's identity.
        doi="" if version or url.startswith("https://arxiv.org/") else doi,
        version=version,
        published=published,
        text=clean_text(body),
        excerpt=True,
    )


def _check_prolog(raw: bytes) -> None:
    """Refuse a DTD before the root element, or a prolog not in ASCII bytes.

    A DOCTYPE (and so any ENTITY) is only legal before the root element;
    later it is a parse error, and inside CDATA it is plain text. UTF-16/32
    bodies are refused so the byte-level check cannot be bypassed.
    """
    if b"\x00" in raw[:4] or raw.startswith((b"\xff\xfe", b"\xfe\xff")):
        raise ValueError("Unsafe feed")
    position = 3 if raw.startswith(b"\xef\xbb\xbf") else 0
    while True:
        while position < len(raw) and raw[position] in b" \t\r\n":
            position += 1
        for opener, closer in ((b"<?", b"?>"), (b"<!--", b"-->")):
            if raw.startswith(opener, position):
                end = raw.find(closer, position + len(opener))
                if end < 0:
                    raise ValueError("Malformed feed")
                position = end + len(closer)
                break
        else:
            if raw.startswith(b"<!", position):
                raise ValueError("Unsafe feed")
            return


def parse_feed(raw: bytes, *, complete: bool = True) -> list[Entry]:
    """Parse RSS 2.0, RSS 1.0 (RDF) or Atom, read from the content.

    A body cut at its byte cap (``complete=False``) keeps the items that
    closed before the cut. DOCTYPE and ENTITY declarations are refused;
    whitespace before the XML declaration (a common blog quirk) is skipped.

    Raises:
        ValueError: The body is not a safe RSS, RDF or Atom document.
    """
    _check_prolog(raw)
    raw = raw.removeprefix(b"\xef\xbb\xbf").lstrip(b" \t\r\n")
    parser: ElementTree.XMLPullParser[ElementTree.Element] = (
        ElementTree.XMLPullParser(events=("start", "end"))
    )
    entries: list[Entry] = []
    root = ""
    try:
        for offset in range(0, len(raw), 65536):
            parser.feed(raw[offset : offset + 65536])
            for item in parser.read_events():
                event, element = item[0], item[-1]
                if not isinstance(element, ElementTree.Element):
                    continue
                name = _local(element.tag)
                if event == "start":
                    if not root:
                        root = name
                        if root not in {"rss", "RDF", "feed"}:
                            raise ValueError("Not a feed")
                    continue
                if name in {"item", "entry"}:
                    entry = _feed_entry(element)
                    element.clear()
                    if entry is not None:
                        entries.append(entry)
                    if len(entries) >= MAX_ENTRIES:
                        return entries
        if complete:
            parser.close()
            list(parser.read_events())
    except ElementTree.ParseError:
        if not entries:
            raise ValueError("Malformed feed") from None
    if not root:
        raise ValueError("Not a feed")
    return entries


def _json(raw: bytes) -> Any:
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeError, ValueError, RecursionError):
        raise ValueError("Malformed JSON") from None


def parse_crossref(raw: bytes) -> list[Entry]:
    """Parse Crossref works; the abstract only feeds local filters.

    Crossref abstracts are publisher text, so they are never emitted as an
    excerpt. The date is the registration (``created``) date.

    Raises:
        ValueError: The envelope is not a Crossref works list.
    """
    value = _json(raw)
    message = value.get("message") if isinstance(value, dict) else None
    items = message.get("items") if isinstance(message, dict) else None
    if not isinstance(items, list) or len(items) > 1000:
        raise ValueError("Invalid Crossref envelope")
    entries = []
    for item in items[:MAX_ENTRIES]:
        if not isinstance(item, dict):
            continue
        doi = sources.normalize_doi(str(item.get("DOI", "")))
        titles = item.get("title")
        title = titles[0] if isinstance(titles, list) and titles else ""
        if not doi or not isinstance(title, str):
            continue
        created = item.get("created")
        parts = (
            created.get("date-parts", [[]])
            if isinstance(created, dict)
            else [[]]
        )
        published = ""
        if (
            isinstance(parts, list)
            and parts
            and isinstance(parts[0], list)
            and len(parts[0]) == 3
            and all(type(n) is int for n in parts[0])
        ):
            try:
                published = datetime.date(*parts[0]).isoformat()
            except ValueError:
                published = ""
        abstract = item.get("abstract", "")
        entries.append(
            Entry(
                title=clean_text(title, 1000),
                url="https://doi.org/" + doi,
                doi=doi,
                version="",
                published=published,
                text=clean_text(abstract if isinstance(abstract, str) else ""),
                excerpt=False,
            )
        )
    return entries


def parse_hf_daily(raw: bytes) -> list[Entry]:
    """Parse Hugging Face daily papers into arXiv leads with upvotes.

    Raises:
        ValueError: The body is not a daily papers list.
    """
    value = _json(raw)
    if not isinstance(value, list):
        raise ValueError("Invalid daily papers list")
    entries = []
    for outer in value[:MAX_ENTRIES]:
        paper = outer.get("paper") if isinstance(outer, dict) else None
        if not isinstance(paper, dict):
            continue
        match = _ARXIV_ID.fullmatch(str(paper.get("id", "")))
        title = paper.get("title")
        if match is None or not isinstance(title, str):
            continue
        upvotes = paper.get("upvotes")
        stamp = paper.get("publishedAt") or outer.get("publishedAt") or ""
        summary = paper.get("summary", "")
        entries.append(
            Entry(
                title=clean_text(title, 1000),
                url="https://arxiv.org/abs/" + match[1],
                doi="",
                version="",
                published=_date(stamp) if isinstance(stamp, str) else "",
                text=clean_text(summary if isinstance(summary, str) else ""),
                excerpt=True,
                upvotes=upvotes
                if type(upvotes) is int and upvotes >= 0
                else None,
            )
        )
    return entries


def _percentiles(entries: Sequence[Entry]) -> list[int | None]:
    """Rank upvotes within one day's list, not across days."""
    votes = [entry.upvotes for entry in entries if entry.upvotes is not None]
    result: list[int | None] = []
    for entry in entries:
        if entry.upvotes is None or not votes:
            result.append(None)
            continue
        below = sum(vote < entry.upvotes for vote in votes)
        result.append(100 * below // len(votes))
    return result


# Fetching.


async def resolve(host: str) -> list[str]:
    """Resolve one registry host's TCP addresses with the system resolver."""
    infos = await asyncio.get_running_loop().getaddrinfo(
        host, 443, type=socket.SOCK_STREAM
    )
    return [str(info[4][0]) for info in infos]


def _spacing(host: str) -> float:
    return HOST_SPACING.get(host, DEFAULT_SPACING)


def _params(source: Source, issue_date: str) -> dict[str, str] | None:
    day = datetime.date.fromisoformat(issue_date)
    since = day - datetime.timedelta(days=source.max_age_days)
    if source.kind == "arxiv":
        window = f"submittedDate:[{since:%Y%m%d}0000 TO {day:%Y%m%d}2359]"
        return {
            "search_query": f"({source.query}) AND {window}",
            "sortBy": "submittedDate",
            "sortOrder": "descending",
            "start": "0",
            "max_results": "100",
        }
    if source.kind == "crossref":
        return {
            "filter": f"from-created-date:{since},type:journal-article",
            "sort": "created",
            "order": "desc",
            "rows": "50",
            "select": "DOI,title,abstract,created",
        }
    if source.kind == "hf_daily":
        return {"date": (day - datetime.timedelta(days=1)).isoformat()}
    return None


def _parse(source: Source, raw: bytes, truncated: bool) -> list[Entry]:
    if source.kind == "crossref":
        return parse_crossref(raw)
    if source.kind == "hf_daily":
        return parse_hf_daily(raw)
    entries = parse_feed(raw, complete=not truncated)
    if source.kind == "arxiv":
        # The API reports query errors as a 200 feed with an "Error" entry
        # linking to arxiv.org/api/errors; only paper abs links are leads.
        return [
            entry
            for entry in entries
            if entry.url.startswith("https://arxiv.org/abs/")
        ]
    return entries


def _host_chains(registry: Sequence[Source]) -> list[list[Source]]:
    """Group sources by host, longest chain first.

    Long serial chains (arXiv, Crossref) take a slot before single feeds, so
    they are not the ones the internal deadline cuts.
    """
    chains: dict[str, list[Source]] = {}
    for source in registry:
        host = parse.urlsplit(source.url).hostname or ""
        chains.setdefault(host, []).append(source)
    return sorted(chains.values(), key=len, reverse=True)


def _public(address: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    if not address.is_global or address.is_multicast:
        return False
    if isinstance(address, ipaddress.IPv6Address):
        if int(address) >> 32 == 0:
            # Deprecated IPv4-compatible ::a.b.c.d is never a real host.
            return False
        if address in _NAT64:
            return ipaddress.IPv4Address(int(address) & 0xFFFFFFFF).is_global
    return True


def failed(result: sources.MetadataResult) -> bool:
    """Report whether any registry source ended with a failure code."""
    return any(
        len(parts := item.split(":")) == 2 and parts[1] in FAILURES
        for item in result.diagnostics
    )


class Researcher:
    """Fetch registry sources once per run and route their leads.

    ``transport``, ``resolver`` and ``sleep`` are injected by offline tests;
    production uses the system resolver and real pacing.
    """

    def __init__(
        self,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
        resolver: Resolver | None = None,
        sleep: Sleep | None = None,
    ) -> None:
        self.transport = transport
        self.resolver = resolver or resolve
        self.sleep = sleep or asyncio.sleep

    async def fetch(
        self,
        registry: Sequence[Source],
        issue_date: str,
        *,
        history: Sequence[Mapping[str, object]] = (),
        budget_seconds: float,
    ) -> sources.MetadataResult:
        """Fetch enabled sources within the budget; keep what finished.

        Sources still running or not started at the internal deadline are
        reported as ``deadline``. Outer cancellation still propagates.
        """
        contracts.validate_issue_date(issue_date)
        enabled = [source for source in registry if source.enabled]
        outcomes: dict[int, _Outcome] = {}
        gate = asyncio.Semaphore(HOST_CHAINS)
        async with httpx.AsyncClient(
            transport=self.transport,
            timeout=REQUEST_SECONDS,
            follow_redirects=False,
            trust_env=False,
            # A fresh connection per request: a pinned address must never
            # reuse a TLS session negotiated for another host name.
            limits=httpx.Limits(max_keepalive_connections=0),
            headers={"User-Agent": USER_AGENT, "Accept-Encoding": "identity"},
        ) as client:
            try:
                async with asyncio.timeout(max(budget_seconds, 0.001)):
                    async with asyncio.TaskGroup() as group:
                        for chain in _host_chains(enabled):
                            group.create_task(
                                self._chain(
                                    client, gate, chain, issue_date, outcomes
                                )
                            )
            except TimeoutError:
                pass
        for source in enabled:
            outcomes.setdefault(source.index, _Outcome("deadline", []))
        result = assemble(enabled, outcomes, issue_date, history)
        _LOGGER.info(
            "Researcher finished: sources=%d ok=%d failed=%d seeds=%d",
            len(enabled),
            sum(outcome.code == "ok" for outcome in outcomes.values()),
            sum(outcome.code != "ok" for outcome in outcomes.values()),
            len(result.candidates),
        )
        return result

    async def _chain(
        self,
        client: httpx.AsyncClient,
        gate: asyncio.Semaphore,
        chain: Sequence[Source],
        issue_date: str,
        outcomes: dict[int, _Outcome],
    ) -> None:
        async with gate:
            for position, source in enumerate(chain):
                if position:
                    await self.sleep(
                        _spacing(parse.urlsplit(source.url).hostname or "")
                    )
                outcomes[source.index] = await self._source(
                    client, source, issue_date
                )

    async def _source(
        self, client: httpx.AsyncClient, source: Source, issue_date: str
    ) -> _Outcome:
        try:
            raw, truncated = await self._get(client, source, issue_date)
        except _FetchError as failure:
            return _Outcome(failure.code, [])
        except (TimeoutError, httpx.TimeoutException):
            return _Outcome("timeout", [])
        except (httpx.HTTPError, OSError, UnicodeError, ValueError):
            return _Outcome("unavailable", [])
        try:
            return _Outcome("ok", _parse(source, raw, truncated), truncated)
        except (ValueError, TypeError, KeyError, RecursionError):
            return _Outcome("parse_error", [])

    async def _address(self, host: str) -> str:
        try:
            found = list(await self.resolver(host))
        except OSError:
            raise _FetchError("unavailable") from None
        addresses = []
        for value in found:
            try:
                address = ipaddress.ip_address(value)
            except ValueError:
                raise _FetchError("unsafe_address") from None
            if not _public(address):
                raise _FetchError("unsafe_address")
            addresses.append(address)
        if not addresses:
            raise _FetchError("unavailable")
        chosen = min(addresses, key=lambda address: address.version)
        return f"[{chosen}]" if chosen.version == 6 else str(chosen)

    async def _get(
        self, client: httpx.AsyncClient, source: Source, issue_date: str
    ) -> tuple[bytes, bool]:
        parsed = parse.urlsplit(source.url)
        host = parsed.hostname or ""
        raw = bytearray()
        # The resolver counts against the request time: a stalled lookup is
        # a timeout for this source, not a stalled host chain.
        async with asyncio.timeout(REQUEST_SECONDS):
            address = await self._address(host)
            target = parse.urlunsplit(
                ("https", address, parsed.path or "/", parsed.query, "")
            )
            async with client.stream(
                "GET",
                target,
                params=_params(source, issue_date),
                headers={"Host": host},
                extensions={"sni_hostname": host},
            ) as response:
                if response.status_code != 200:
                    raise _FetchError("http_error")
                async for chunk in response.aiter_bytes():
                    raw.extend(chunk)
                    if len(raw) > source.max_bytes:
                        # A feed is parsed as far as it got; JSON cannot be.
                        if source.kind in {"crossref", "hf_daily"}:
                            raise _FetchError("too_large")
                        return bytes(raw[: source.max_bytes]), True
        return bytes(raw), False


# Filtering, merging and routing.


def _basis(names: Sequence[str]) -> str:
    # Bounded so a work many feeds share still passes seed validation.
    shown = "、".join(names[:_BASIS_NAMES])
    more = "等" if len(names) > _BASIS_NAMES else ""
    return "研究员订阅源：" + shown + more + "（仅元数据，未打开原文）"


def _accept(
    source: Source,
    entry: Entry,
    since: str,
    issue_date: str,
) -> bool:
    if not since <= entry.published <= issue_date:
        return False
    text = entry.title + "\n" + entry.text
    if source.keywords and not any(k.search(text) for k in source.keywords):
        return False
    return not (source.requires_abstract and len(entry.text) < ABSTRACT_CHARS)


def _leads(
    registry: Sequence[Source],
    outcomes: Mapping[int, _Outcome],
    issue_date: str,
    history: Sequence[Mapping[str, object]],
    diagnostics: list[str],
) -> list[_Lead]:
    known: set[str] = set()
    for record in history:
        known |= sources.identity_keys(record)
    day = datetime.date.fromisoformat(issue_date)
    leads: list[_Lead] = []
    index: dict[str, _Lead] = {}
    for source in registry:
        outcome = outcomes[source.index]
        diagnostics.append(f"{source.id}:{outcome.code}")
        if outcome.truncated:
            diagnostics.append(f"{source.id}:truncated")
        since = (day - datetime.timedelta(days=source.max_age_days)).isoformat()
        undated = invalid = 0
        percentiles = _percentiles(outcome.entries)
        for position, entry in enumerate(outcome.entries):
            if not entry.published:
                undated += 1
                continue
            if not _accept(source, entry, since, issue_date):
                continue
            try:
                candidate = content.seed_view(
                    sources.metadata_candidate(
                        entry.title,
                        entry.url,
                        entry.doi,
                        entry.published,
                        "crossref_metadata"
                        if source.kind == "crossref"
                        else "rss_metadata",
                        direction=source.direction,
                        version=entry.version,
                        venue=source.name,
                        source_basis=_basis([source.name]),
                    )
                )
            except (ValueError, errors.EditorError):
                invalid += 1
                continue
            keys = sources.identity_keys(candidate)
            if keys & known:
                continue
            excerpt = _excerpt(entry.text) if entry.excerpt else ""
            existing = next((index[key] for key in keys if key in index), None)
            if existing is None:
                existing = _Lead(
                    candidate,
                    source,
                    position,
                    [source.name],
                    excerpt,
                    percentiles[position],
                )
                leads.append(existing)
            else:
                if source.name not in existing.names:
                    existing.names.append(source.name)
                existing.excerpt = existing.excerpt or excerpt
                if percentiles[position] is not None:
                    existing.percentile = max(
                        existing.percentile or 0, percentiles[position] or 0
                    )
            for key in keys:
                index.setdefault(key, existing)
        if undated:
            diagnostics.append(f"{source.id}:undated:{undated}")
        if invalid:
            diagnostics.append(f"{source.id}:invalid_items:{invalid}")
    return leads


def _route(leads: Sequence[_Lead]) -> list[_Lead]:
    """Round-robin sources within a direction, then interleave directions."""
    grouped: dict[str, dict[int, list[_Lead]]] = {}
    for lead in leads:
        grouped.setdefault(lead.candidate["direction"], {}).setdefault(
            lead.source.index, []
        ).append(lead)
    routed = []
    for direction in sorted(grouped):
        per_source = [
            sorted(items, key=_Lead.rank)[: items[0].source.max_seeds]
            for _, items in sorted(grouped[direction].items())
        ]
        ordered = [
            lead
            for batch in itertools.zip_longest(*per_source)
            for lead in sorted(
                (item for item in batch if item is not None), key=_Lead.rank
            )
        ]
        routed.append(ordered[:MAX_SEEDS_PER_DIRECTION])
    return [
        lead
        for batch in itertools.zip_longest(*routed)
        for lead in batch
        if lead is not None
    ]


def _note(lead: _Lead) -> types.Payload:
    signals = {"independent_sources": len(lead.names)}
    if lead.percentile is not None:
        signals["hf_upvote_percentile"] = lead.percentile
    return {
        "source": "、".join(lead.names[:_BASIS_NAMES]),
        "excerpt_untrusted": lead.excerpt,
        "signals": signals,
    }


def assemble(
    registry: Sequence[Source],
    outcomes: Mapping[int, _Outcome],
    issue_date: str,
    history: Sequence[Mapping[str, object]] = (),
) -> sources.MetadataResult:
    """Filter, merge, rank and route fetched entries into a bounded result."""
    diagnostics: list[str] = []
    routed = _route(
        _leads(registry, outcomes, issue_date, history, diagnostics)
    )
    candidates: list[sources.Candidate] = []
    notes: dict[str, types.Payload] = {}
    for lead in routed:
        candidate = lead.candidate.copy()
        candidate["source_basis"] = _basis(lead.names)
        candidates.append(content.seed_view(candidate))
        notes[candidate["id"]] = _note(lead)
    size = len(
        contracts.canonical_json(
            {
                "candidates": candidates,
                "notes": notes,
                "diagnostics": diagnostics,
            }
        ).encode()
    )
    trimmed = 0
    while candidates and size > MAX_ARTIFACT_BYTES - 64:
        dropped = candidates.pop()
        note = notes.pop(dropped["id"])
        size -= len(contracts.canonical_json(dropped).encode()) + len(
            contracts.canonical_json(note).encode()
        )
        trimmed += 1
    if trimmed:
        diagnostics.append(f"artifact:trimmed:{trimmed}")
    return sources.MetadataResult(candidates, diagnostics, notes)

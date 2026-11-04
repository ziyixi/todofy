"""Frozen headline-feed excerpts: the only feed text a story may cite.

At fetch time the researcher freezes, for each seeded headline group that two
or more outlets carry, one excerpt per outlet: its headline and cleaned feed
description, pinned by sha256. The pool node keeps the groups its candidates
point at, and a story whose task points at a group starts from one code-built
packet of the group's abstract-scope excerpts.

Review reads a cited excerpt as read only in a signal, only while its text
still hashes to the pin, and only beside a second outlet's excerpt from the
same group or an opened source: enough for one "据X、Y报道" paragraph. Code
also refuses a number no cited excerpt holds; other claims beyond the
excerpts are the reviewer's to catch. Body, reading and chart citations keep
the must-open rule. Excerpts are untrusted publisher text, never instructions.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
import datetime
import hashlib
import re

import newsletter.contracts as contracts
import newsletter.types as types
import newsletter.workflow.sources as sources

# Marks a packet only code builds from frozen excerpts; a writer's supplements
# are always wrapped as "story-research", so they can never pass for one.
WORKFLOW_ID = "researcher-feed"
PRODUCER_ID = "researcher"
# All frozen excerpts of one feeds artifact; lower-ranked groups drop first.
MAX_BYTES = 64 * 1024
# Outlets a group needs to be frozen, and an excerpt-only signal to stand on.
MIN_OUTLETS = 2
# Groups one story receives: a story big enough to split into several groups
# still fits.
MAX_GROUPS = 3
_FIELDS = frozenset(
    {"outlet", "url", "title", "published_at", "text", "sha256"}
)
_DIGITS = re.compile(r"\d+")
_THOUSANDS = re.compile(r"(?<=\d),(?=\d{3}\b)")
_NOTE = (
    "代码抓取头条订阅源时冻结的摘要：{names}共{count}家标题相近。"
    "每个来源是一家媒体的标题和导语，按sha256固定，不是打开过的原文；"
    "按标题聚类可能把同一议题下的不同事件误并。它们最多支持一段注明"
    "“据X、Y报道”的signal，不支持摘要以外的数字或论断；"
    "正文、阅读卡和图表引用它们时仍须打开原文。"
)


def digest(text: str) -> str:
    """Return the sha256 hex digest that pins an excerpt's exact text."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def excerpt(
    outlet: str,
    url: str,
    title: str,
    moment: datetime.datetime,
    description: str,
) -> types.Payload:
    """Freeze one outlet's report: its headline, then its description."""
    text = f"{title}\n{description}" if description else title
    return {
        "outlet": outlet,
        "url": url,
        "title": title,
        "published_at": moment.astimezone(datetime.UTC)
        .isoformat()
        .replace("+00:00", "Z"),
        "text": text,
        "sha256": digest(text),
    }


def _valid(item: object) -> bool:
    if (
        not isinstance(item, dict)
        or set(item) != _FIELDS
        or not all(isinstance(item[name], str) for name in _FIELDS)
        or not 0 < len(item["outlet"]) <= 80
        or not item["title"]
        or len(item["text"]) > 20000
        or item["sha256"] != digest(item["text"])
    ):
        return False
    try:
        contracts.validate_public_url(item["url"])
    except contracts.ContractError:
        return False
    return True


def _url_keys(urls: Iterable[str]) -> set[str]:
    return {
        key
        for url in urls
        for key in sources.identity_keys({"url": url})
        if key.startswith("url:")
    }


def covered(values: object, urls: Iterable[str]) -> list[types.Payload]:
    """Keep the intact stored groups whose reports one of ``urls`` names.

    An excerpt whose text no longer hashes to its pin is dropped; a group
    left with fewer than two outlets cannot confirm anything and goes too.
    """
    if not isinstance(values, list):
        return []
    wanted = _url_keys(urls)
    result = []
    for group in values:
        items = group.get("items") if isinstance(group, dict) else None
        if not isinstance(items, list):
            continue
        kept = [item for item in items if _valid(item)]
        if (
            len({item["outlet"] for item in kept}) >= MIN_OUTLETS
            and _url_keys(item["url"] for item in kept) & wanted
        ):
            result.append({"lead": group.get("lead", ""), "items": kept})
    return result


def packet(group: types.Payload, *, is_fixture: bool) -> types.Payload:
    """Build the code-owned packet of one group's abstract-scope excerpts.

    Its ``created_at`` is the newest report's time and its ID a hash of the
    rest, so the same excerpts always make the same packet.
    """
    items = group["items"]
    names = list(dict.fromkeys(item["outlet"] for item in items))
    body = {
        "title": items[0]["title"][:300],
        "body": _NOTE.format(names="、".join(names), count=len(names)),
        "tags": ["feed-excerpt", "headline-group"],
        "sources": [
            {
                "id": f"excerpt-{number}",
                "title": f"{item['outlet']}：{item['title']}"[:500],
                "url": item["url"],
                "excerpt": item["text"],
                "access_scope": "abstract",
                "published_at": item["published_at"],
            }
            for number, item in enumerate(items, 1)
        ],
    }
    value: types.Payload = {
        "workflow_id": WORKFLOW_ID,
        "producer_id": PRODUCER_ID,
        "content_hash": contracts.content_hash(body),
        "created_at": max(item["published_at"] for item in items),
        "is_fixture": is_fixture,
        "content": body,
    }
    return {"id": "feed-" + contracts.content_hash(value)[:32], **value}


def packets(
    groups: Sequence[types.Payload], *, is_fixture: bool
) -> list[types.Payload]:
    """Build one packet per group, skipping any that fails the contract."""
    result = []
    for group in groups:
        value = packet(group, is_fixture=is_fixture)
        try:
            contracts.validate_packet_body(value["content"])
        except contracts.ContractError:
            continue
        result.append(value)
    return result


def pins(groups: Sequence[types.Payload]) -> dict[str, tuple[str, str]]:
    """Map each frozen excerpt's URL to its pinned sha256 and its outlet."""
    return {
        item["url"]: (item["sha256"], item["outlet"])
        for group in groups
        for item in group["items"]
    }


def is_packet(value: Mapping[str, object]) -> bool:
    """Report whether code built this packet from frozen excerpts."""
    return (
        value.get("workflow_id") == WORKFLOW_ID
        and value.get("producer_id") == PRODUCER_ID
    )


def pinned(
    packets: Sequence[types.Payload], pins: Mapping[str, tuple[str, str]]
) -> dict[str, str]:
    """Return citation → outlet for excerpts that still match their pins."""
    found = {}
    for value in packets:
        if not is_packet(value):
            continue
        for source in value["content"]["sources"]:
            pin = pins.get(source["url"])
            if (
                pin is not None
                and source["access_scope"] == "abstract"
                and digest(source.get("excerpt", "")) == pin[0]
            ):
                found[f"{value['id']}/{source['id']}"] = pin[1]
    return found


def corroborated(pinned: Mapping[str, str]) -> bool:
    """Report whether two outlets back every frozen group a signal cites.

    ``pinned`` maps each cited excerpt, ``<packet>/<source>``, to its outlet.
    A packet is one headline group, so outlets from two groups, which may be
    two events, back nothing together.
    """
    outlets: dict[str, set[str]] = {}
    for ref, outlet in pinned.items():
        outlets.setdefault(ref.split("/", 1)[0], set()).add(outlet)
    return bool(outlets) and all(
        len(names) >= MIN_OUTLETS for names in outlets.values()
    )


def unsupported_numbers(
    signal: types.Payload, cited: Iterable[types.Payload]
) -> list[str]:
    """Return the digit runs a signal writes that no cited excerpt holds.

    A cheap guard for a signal resting only on excerpts: each number must
    appear in a cited excerpt's text (with or without thousands separators)
    or its report date. Spelled-out numbers and other claims stay the
    reviewer's to judge.
    """
    allowed: set[str] = set()
    for source in cited:
        text = f"{source.get('excerpt', '')} {source.get('published_at', '')}"
        for variant in (text, _THOUSANDS.sub("", text)):
            allowed.update(run.lstrip("0") for run in _DIGITS.findall(variant))
    written = " ".join(
        [
            signal.get("title", ""),
            *(item.get("text", "") for item in signal.get("paragraphs", [])),
            signal.get("limitations", ""),
        ]
    )
    return sorted(
        {
            run
            for run in _DIGITS.findall(written)
            if run.lstrip("0") not in allowed
        }
    )

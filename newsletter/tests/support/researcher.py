"""Synthetic researcher registries, feed bodies and an offline network."""

from __future__ import annotations

from collections.abc import Callable, Mapping
import json
from typing import Any

import httpx
import yaml

DAY = "2026-10-28"
DIRECTIONS = (
    "01-ai-ml",
    "02-science",
    "04-economy",
    "08-llm-architectures",
)
# Globally routable but never contacted: every test uses MockTransport.
PUBLIC = "93.184.215.14"
LONG = (
    "This synthetic abstract describes a controlled comparison in enough "
    "words to pass the abstract length check."
)


def source(**changes: object) -> dict[str, object]:
    """Build one registry entry; a feed on a synthetic host by default."""
    value: dict[str, object] = {
        "id": "synthetic-feed",
        "name": "Synthetic Journal",
        "direction": "02-science",
        "kind": "feed",
        "url": "https://feeds.example.org/rss",
    }
    value.update(changes)
    return value


def registry(*sources: Mapping[str, object]) -> str:
    """Serialize registry entries as researcher.yaml text."""
    return yaml.safe_dump(
        {"version": 1, "sources": [dict(item) for item in sources]},
        sort_keys=False,
        allow_unicode=True,
    )


def rss_item(
    title: str = "Synthetic feed item",
    link: str = "https://feeds.example.org/a/1",
    date: str = "Mon, 26 Oct 2026 10:00:00 GMT",
    description: str = LONG,
    doi: str = "",
) -> str:
    """Build one RSS 2.0 item."""
    extra = f"<prism:doi>{doi}</prism:doi>" if doi else ""
    stamp = f"<pubDate>{date}</pubDate>" if date else ""
    return (
        f"<item><title>{title}</title><link>{link}</link>{stamp}"
        f"<description>{description}</description>{extra}</item>"
    )


def rss(*items: str) -> bytes:
    """Wrap RSS 2.0 items in a channel."""
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<rss version="2.0" '
        'xmlns:prism="http://prismstandard.org/namespaces/basic/2.0/">'
        "<channel><title>Synthetic channel</title>"
        + "".join(items)
        + "</channel></rss>"
    ).encode()


def arxiv_entry(
    identifier: str = "2610.01234",
    version: str = "v2",
    title: str = "Synthetic\n      wrapped arXiv title",
    published: str = "2026-10-26T12:00:00Z",
) -> str:
    """Build one arXiv API Atom entry with several links and a DOI."""
    abs_url = f"http://arxiv.org/abs/{identifier}{version}"
    return (
        f"<entry><id>{abs_url}</id><published>{published}</published>"
        f"<updated>{published}</updated><title>{title}</title>"
        f"<summary>{LONG}</summary>"
        f"<arxiv:doi>10.48550/arXiv.{identifier}</arxiv:doi>"
        f'<link href="https://export.arxiv.org/api/self" rel="self"/>'
        f'<link title="pdf" href="http://arxiv.org/pdf/{identifier}{version}"'
        ' rel="related" type="application/pdf"/>'
        f'<link href="{abs_url}" rel="alternate" type="text/html"/>'
        "</entry>"
    )


def atom(*entries: str) -> bytes:
    """Wrap Atom entries in an arXiv-style feed."""
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<feed xmlns="http://www.w3.org/2005/Atom" '
        'xmlns:arxiv="http://arxiv.org/schemas/atom">'
        "<title>Synthetic query</title>" + "".join(entries) + "</feed>"
    ).encode()


def crossref(*items: Mapping[str, object]) -> bytes:
    """Wrap Crossref work records."""
    return json.dumps({"message": {"items": list(items)}}).encode()


def crossref_item(**changes: object) -> dict[str, object]:
    """Build one Crossref work with a JATS abstract."""
    value: dict[str, object] = {
        "DOI": "10.1234/Synthetic.Crossref",
        "title": ["Synthetic <i>Crossref</i> research"],
        "abstract": (
            "<jats:title>Abstract</jats:title><jats:p>CROSSREF ABSTRACT "
            + LONG
            + "</jats:p>"
        ),
        "created": {"date-parts": [[2026, 10, 26]]},
    }
    value.update(changes)
    return value


def hf_daily(*papers: tuple[str, int]) -> bytes:
    """Build a daily papers list from (arXiv ID, upvotes) pairs."""
    return json.dumps(
        [
            {
                "paper": {
                    "id": identifier,
                    "title": f"Synthetic popular paper {identifier}",
                    "summary": LONG,
                    "upvotes": upvotes,
                    "publishedAt": "2026-10-26T00:00:00.000Z",
                }
            }
            for identifier, upvotes in papers
        ]
    ).encode()


Route = bytes | httpx.Response | Callable[[httpx.Request], Any]


class Network:
    """Answer requests by their Host header and record what was sent."""

    def __init__(
        self,
        routes: Mapping[str, Route],
        addresses: Mapping[str, list[str]] | None = None,
    ) -> None:
        self.routes = dict(routes)
        self.addresses = dict(addresses or {})
        self.requests: list[httpx.Request] = []
        self.resolved: list[str] = []
        self.sleeps: list[float] = []

    async def resolver(self, host: str) -> list[str]:
        """Return synthetic addresses without touching DNS."""
        self.resolved.append(host)
        return self.addresses.get(host, [PUBLIC])

    async def sleep(self, seconds: float) -> None:
        """Record pacing without waiting."""
        self.sleeps.append(seconds)

    async def handle(self, request: httpx.Request) -> httpx.Response:
        """Serve the synthetic body registered for the request's host."""
        self.requests.append(request)
        route = self.routes.get(request.headers["host"], b"")
        if callable(route):
            result = route(request)
            if hasattr(result, "__await__"):
                result = await result
            route = result
        if isinstance(route, httpx.Response):
            return route
        return httpx.Response(200, content=route)

    def transport(self) -> httpx.MockTransport:
        """Expose the handler as an httpx transport."""
        return httpx.MockTransport(self.handle)

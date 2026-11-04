"""Synthetic researcher registries, feed bodies and an offline network."""

from __future__ import annotations

from collections.abc import Callable, Mapping
import datetime
import json
from typing import Any

import httpx
import yaml

DAY = "2026-10-28"
# The headline window closes at this time on DAY.
NOW = datetime.datetime(2026, 10, 28, 14, 0, tzinfo=datetime.UTC)
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


# A synthetic front page modelled on a real day's headline feeds: five
# outlets lead with one election in their own words, a busy war beat runs
# many different strikes past the same words (two outlets report one strike,
# three one ceasefire) and through one wire template, two earthquakes strike
# two countries, busy public figures appear in unrelated stories, and each
# outlet carries its own local stories.
OUTLETS = ("BBC", "NPR", "The Guardian", "DW", "Al Jazeera")
ELECTION = (
    (
        "Liberty Party wins majority in Freedonia parliamentary election",
        "Voters in Freedonia handed the Liberty Party a parliamentary "
        "majority, ending a decade of coalition rule.",
    ),
    (
        "Freedonia election: Liberty Party sweeps to parliamentary majority",
        "Final results show the Liberty Party with a clear majority in "
        "Freedonia's parliament.",
    ),
    (
        "Freedonia's ruling coalition ousted as Liberty Party takes majority",
        "The Liberty Party won a majority of seats in Freedonia's parliament "
        "in Sunday's vote.",
    ),
    (
        "Liberty Party leader claims victory after Freedonia election",
        "Freedonia's Liberty Party secured a parliamentary majority, "
        "official results show.",
    ),
    (
        "What the Liberty Party's majority means for Freedonia",
        "After winning a parliamentary majority, the Liberty Party must now "
        "form a government in Freedonia.",
    ),
)
WAR = (
    (
        "BBC",
        "Sylvanian drones strike Port Vell power plant",
        "Sylvania's drones hit a power plant in Port Vell overnight, "
        "officials said.",
    ),
    (
        "NPR",
        "Sylvania war: market strike in Ostrava kills nine",
        "A Sylvanian missile strike on a market in Ostrava killed nine people.",
    ),
    (
        "The Guardian",
        "Sylvania mobilises reservists as war enters third year",
        "Sylvania called up 50,000 reservists to the front.",
    ),
    (
        "DW",
        "Aid convoy shelled near Brenik as Sylvania war grinds on",
        "An aid convoy came under shelling near Brenik, the latest attack in "
        "the Sylvania war.",
    ),
    (
        "Al Jazeera",
        "Sylvanian strike damages hospital in Kellen",
        "Shelling damaged a hospital in Kellen, doctors said.",
    ),
    (
        "BBC",
        "Sylvania war: rail depot in Drava hit by rockets",
        "The depot burned for hours, railway staff said.",
    ),
    (
        "The Guardian",
        "Port Vell power plant struck by Sylvanian drones",
        "Drones hit the Port Vell power plant, cutting electricity to "
        "thousands.",
    ),
    (
        "NPR",
        "Sylvania war: talks on prisoner exchange stall",
        "Talks on a prisoner exchange in the Sylvania war stalled, mediators "
        "said.",
    ),
    (
        "DW",
        "Sylvania and Ruritania agree 30-day ceasefire",
        "Sylvania and Ruritania agreed a ceasefire in talks brokered by "
        "Andorra.",
    ),
    (
        "Al Jazeera",
        "Ruritania, Sylvania sign ceasefire deal brokered by Andorra",
        "The ceasefire between Ruritania and Sylvania takes effect at "
        "midnight.",
    ),
    (
        "NPR",
        "Ceasefire between Sylvania and Ruritania to take effect at midnight",
        "Andorra brokered the truce after months of fighting.",
    ),
)
FIGURE = (
    (
        "BBC",
        "Chancellor Ostrander announces steel tariffs",
        "Chancellor Ostrander said tariffs on imported steel would rise.",
    ),
    (
        "NPR",
        "Ostrander meets Andorran premier at summit",
        "Chancellor Ostrander met the Andorran premier at a regional summit.",
    ),
    (
        "DW",
        "Court rules against Ostrander pension reform",
        "A court struck down Chancellor Ostrander's pension reform.",
    ),
    (
        "Al Jazeera",
        "Ostrander faces protests over housing plan",
        "Protesters marched against Chancellor Ostrander's housing plan.",
    ),
)
# Wire-style headlines: one template, a different city and toll each time.
TEMPLATE_WAR = (
    (
        "BBC",
        "Sylvanian drone attack on Tarnov kills three",
        "A Sylvanian drone attack on Tarnov killed three people overnight, "
        "officials said.",
    ),
    (
        "NPR",
        "Sylvanian drone strike on Velika kills five",
        "Sylvania struck Velika with drones, killing five, officials said.",
    ),
    (
        "DW",
        "Sylvanian drones kill two in Mirov as attacks continue",
        "Sylvanian drones killed two people in the city of Mirov.",
    ),
    (
        "Al Jazeera",
        "Sylvanian drone attack kills four in Selna",
        "Four people were killed in a Sylvanian drone attack on Selna.",
    ),
)
# Two earthquakes in two countries, three outlets each.
DISASTERS = (
    (
        "BBC",
        "Magnitude 7.1 earthquake strikes off Norland's coast",
        "A powerful earthquake struck off the coast of northern Norland, "
        "prompting tsunami warnings.",
    ),
    (
        "NPR",
        "Powerful earthquake hits Norland, tsunami warning issued",
        "A magnitude 7.1 earthquake hit northern Norland.",
    ),
    (
        "DW",
        "Norland earthquake: tsunami warning after magnitude 7.1 quake",
        "Norland issued a tsunami warning after a strong earthquake.",
    ),
    (
        "Al Jazeera",
        "Magnitude 6.8 earthquake strikes Estmark, killing at least 12",
        "A strong earthquake struck southern Estmark, killing at least 12 "
        "people.",
    ),
    (
        "NPR",
        "Deadly earthquake hits southern Estmark",
        "At least 12 people were killed when a strong earthquake hit Estmark.",
    ),
    (
        "BBC",
        "Earthquake in Estmark kills at least 12",
        "A magnitude 6.8 earthquake struck southern Estmark.",
    ),
)
# A leader always named in full with her title, in unrelated stories.
FULL_NAME = (
    (
        "BBC",
        "Prime Minister Lena Varga announces hospital funding boost",
        "Prime Minister Lena Varga said hospitals would get extra money.",
    ),
    (
        "The Guardian",
        "Lena Varga faces backbench revolt over welfare cuts",
        "Lawmakers threatened to vote against Prime Minister Lena Varga's "
        "welfare plans.",
    ),
    (
        "DW",
        "Prime Minister Lena Varga visits Kestrel for defence talks",
        "Prime Minister Lena Varga met Kestrel's chancellor to discuss "
        "defence spending.",
    ),
    (
        "Al Jazeera",
        "Varga and Halvorsen agree on migrant returns deal",
        "Prime Minister Lena Varga and Halvorsen signed a returns agreement.",
    ),
)
_LOCAL = (
    "apricot basalt cobalt dahlia ember fjord granite harbor iris jasper kelp "
    "lantern meadow nectar opal pine quartz reef saffron tundra umber violet "
    "willow xenon yarrow zephyr acorn birch cedar dune elm fern grove heath "
    "ivy juniper"
).split()


def front_page() -> dict[str, list[tuple[str, str]]]:
    """Each outlet's (title, description) items, newest first."""
    page: dict[str, list[tuple[str, str]]] = {
        outlet: [story] for outlet, story in zip(OUTLETS, ELECTION, strict=True)
    }
    for outlet, title, text in (
        WAR + FIGURE + TEMPLATE_WAR + DISASTERS + FULL_NAME
    ):
        page[outlet].append((title, text))
    for n, word in enumerate(_LOCAL):
        town = _LOCAL[(n + 7) % len(_LOCAL)]
        page[OUTLETS[n % len(OUTLETS)]].append(
            (
                f"{word.title()} festival draws record crowds in {town}ville",
                f"Organisers of the {word} festival reported record "
                "attendance this year.",
            )
        )
    return page


# A synthetic day of Wikipedia's Current events portal, in its wikitext: a
# kept category with a topic bullet, a category the reference skips, and an
# event under no topic. Invented places; the second citation of the first
# event is not public and drops.
CURRENT_EVENTS = "\n".join(
    [
        "{{Current events|year=2026|month=10|day=27|top=yes}}",
        "<!-- All news items below this line -->",
        "'''Armed conflicts and attacks'''",
        "*[[Norland–Sudria border dispute]]",
        "**Border guards of [[Norland]] and [[Sudria]] exchange fire near "
        "the [[Ostra Pass (mountain pass)|Ostra Pass]]. "
        "[https://news.example.org/border-clash (Example Wire)] "
        "[https://127.0.0.1/border (Local)]",
        "",
        "'''Arts and culture'''",
        "*A synthetic prize is awarded. [https://news.example.org/prize (X)]",
        "",
        "'''Politics and elections'''",
        "*[[Norland]]'s [[Electoral Commission of Norland|electoral "
        "commission]] confirms that voters approved the [[2026 Norland "
        "constitutional referendum|referendum]] on the {{small|draft}} "
        "constitution. [https://news.example.org/referendum (''Example "
        "Post'')]",
        "*A context bullet without a source",
        "<!-- All news items above this line -->",
    ]
)


def current_events(wikitext: str = CURRENT_EVENTS) -> bytes:
    """A MediaWiki parse API answer carrying one day's wikitext."""
    page = {"title": "Portal:Current events/2026 October 27"}
    return json.dumps({"parse": {**page, "wikitext": wikitext}}).encode()

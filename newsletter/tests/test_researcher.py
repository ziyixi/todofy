"""Test the researcher registry, parsers, fetch policy and routing offline.

Every body is synthetic; requests go to MockTransport through an injected
resolver and sleep, so no DNS, socket or real feed is touched.
"""

import asyncio
import dataclasses
import datetime
import json
import pathlib
import time
import urllib.parse as parse

import httpx
import pytest

import newsletter.contracts as contracts
import newsletter.workflow.content as content
import newsletter.workflow.researcher as researcher
import newsletter.workflow.sources as sources
import tests.support.researcher as fake

DAY = fake.DAY
DIRECTIONS = fake.DIRECTIONS


def load(*entries):
    return researcher.validate_registry(fake.registry(*entries), DIRECTIONS)


def run(network, registry, *, budget=60.0, history=()):
    return researcher.Researcher(
        transport=network.transport(),
        resolver=network.resolver,
        sleep=network.sleep,
        clock=lambda: fake.NOW,
    ).fetch(registry, DAY, history=history, budget_seconds=budget)


def headline_registry(**changes):
    return load(
        *[
            fake.source(
                id=f"outlet-{n}",
                name=name,
                direction="04-economy",
                url=f"https://outlet{n}.example.org/rss",
                max_seeds=4,
                max_age_days=2,
                role="headline",
                **changes,
            )
            for n, name in enumerate(fake.OUTLETS)
        ]
    )


def headline_entry(outlet, number, title, text, *, minutes=None):
    """Entry ``number`` of an outlet; earlier entries and outlets are newer."""
    moment = fake.NOW - datetime.timedelta(
        minutes=minutes if minutes is not None else 30 * number + 5 * outlet
    )
    return researcher.Entry(
        title=title,
        url=f"https://outlet{outlet}.example.org/{number}",
        doi="",
        version="",
        published=moment.date().isoformat(),
        text=text,
        excerpt=True,
        moment=moment,
    )


def front_page_outcomes(registry, page=None):
    page = page or fake.front_page()
    return {
        source.index: researcher._Outcome(
            "ok",
            [
                headline_entry(source.index, number, title, text)
                for number, (title, text) in enumerate(page[source.name])
            ],
        )
        for source in registry
    }


# Registry validation.


def test_authored_registry_is_valid_and_bounded():
    path = pathlib.Path(__file__).resolve().parents[1] / "content-config"
    text = (path / "researcher.yaml").read_text(encoding="utf-8")
    directions = [item.stem for item in (path / "discovery").glob("*.md")]
    registry = researcher.validate_registry(text, directions)
    assert 30 <= len(registry) <= researcher.MAX_SOURCES
    assert len(text.encode()) <= 100_000
    assert "b55b29b1" in text.split("version:", 1)[0]
    assert {source.kind for source in registry} == researcher.KINDS
    by_id = {source.id: source for source in registry}
    # The upvote list follows the arXiv queries so a shared paper keeps its
    # arXiv direction.
    assert all(
        by_id["hf-daily-papers"].index > source.index
        for source in registry
        if source.kind == "arxiv" and source.direction != "02-science"
    )
    assert by_id["ahead-of-ai"].max_bytes == researcher.MAX_SOURCE_BYTES
    assert not by_id["nature"].keywords and not by_id["science"].keywords
    assert by_id["science"].requires_abstract
    # Front pages are read as one per direction, for world and economy only.
    headline = {s.direction for s in registry if s.role == "headline"}
    assert headline == {"03-world", "04-economy"}
    for direction in ("05-health", "06-technology"):
        assert len({s.name for s in registry if s.direction == direction}) >= 4


@pytest.mark.parametrize(
    "entry",
    [
        fake.source(extra=True),
        fake.source(id="Bad_Id"),
        fake.source(name=""),
        fake.source(name="tab\tname"),
        fake.source(direction="09-unknown"),
        fake.source(direction=["02-science"]),
        fake.source(kind="sitemap"),
        fake.source(url="http://feeds.example.org/rss"),
        fake.source(url="https://feeds.example.org:8443/rss"),
        fake.source(url="https://93.184.215.14/rss"),
        fake.source(url="https://feeds.example.org/rss#top"),
        fake.source(url="https://user@feeds.example.org/rss"),
        fake.source(url="https://printer.local/rss"),
        fake.source(kind="crossref", url="https://api.crossref.org/w?rows=1"),
        fake.source(kind="arxiv", url="https://export.arxiv.org/api/query"),
        fake.source(query="cat:cs.LG"),
        fake.source(keywords="seism*"),
        fake.source(keywords=["fa*ult"]),
        fake.source(keywords=[""]),
        fake.source(requires_abstract="yes"),
        fake.source(max_seeds=0),
        fake.source(max_seeds=True),
        fake.source(max_bytes=1024),
        fake.source(max_bytes=8 * 1024 * 1024),
        fake.source(max_age_days=31),
        fake.source(enabled=1),
        fake.source(role="lead"),
        fake.source(role=True),
        fake.source(
            kind="crossref",
            url="https://api.crossref.org/journals/0000-0000/works",
            role="headline",
        ),
    ],
)
def test_registry_rejects_unknown_or_unsafe_entries(entry):
    with pytest.raises(researcher.RegistryError):
        load(entry)


@pytest.mark.parametrize(
    "text",
    [
        "",
        "version: 2\nsources: []\n",
        "version: 1\nsources: []\n",
        "version: 1\nsources: {}\nextra: 1\n",
        fake.registry(fake.source(), fake.source()),
        fake.registry(*[fake.source(id=f"s{n}") for n in range(81)]),
        "version: 1\nversion: 1\nsources: []\n",
        "version: 1\nsources:\n  - &a {id: a}\n  - *a\n",
        "version: !!int 1\nsources: []\n",
        "!!python/object:builtins.exec {}",
        "x" * 100_001,
    ],
)
def test_registry_rejects_bad_documents(text):
    with pytest.raises(researcher.RegistryError):
        researcher.validate_registry(text, DIRECTIONS)


def test_registry_defaults_follow_kind():
    feed, arxiv = load(
        fake.source(),
        fake.source(
            id="synthetic-arxiv",
            kind="arxiv",
            url="https://export.arxiv.org/api/query",
            query="cat:cs.LG",
        ),
    )
    assert (feed.max_age_days, arxiv.max_age_days) == (7, 4)
    assert feed.max_seeds == 5 and feed.enabled
    assert feed.max_bytes == researcher.DEFAULT_SOURCE_BYTES


@pytest.mark.parametrize(
    ("keyword", "text", "expected"),
    [
        ("fault*", "Faults slip", True),
        ("fault*", "the default value", False),
        ("mantle", "Mantle plumes", True),
        ("mantle", "mantles", False),
        ("AI", "AI models", True),
        ("AI", "she said", False),
        ("AI", "ai models", False),
        ("machine learning", "Machine \n learning for waves", True),
        ("neural network*", "neural networks", True),
    ],
)
def test_keywords_keep_brief_semantics(keyword, text, expected):
    pattern = researcher.compile_keyword(keyword)
    assert bool(pattern.search(text)) is expected


# Parsers.


@pytest.mark.parametrize(
    ("stamp", "moment"),
    [
        ("Wed, 28 Oct 2026 06:12:31 GMT", "2026-10-28T06:12:31+00:00"),
        ("Wed, 28 Oct 2026 01:30:00 -0400", "2026-10-28T05:30:00+00:00"),
        ("2026-10-28T08:00:00Z", "2026-10-28T08:00:00+00:00"),
        ("2026-10-27", None),
        ("Wed, 28 Oct 2026 06:12:31 -0000", None),
        # In range locally, out of range in UTC.
        ("0001-01-01T00:00:00+01:00", None),
        ("Fri, 31 Dec 9999 23:59:59 -0500", None),
    ],
)
def test_feed_items_keep_a_time_only_with_a_zone(stamp, moment):
    (entry,) = researcher.parse_feed(fake.rss(fake.rss_item(date=stamp)))
    assert entry.published
    assert (entry.moment.isoformat() if entry.moment else None) == moment


async def test_an_out_of_range_date_never_fails_the_other_feeds():
    registry = load(
        fake.source(id="good", url="https://good.example.org/rss"),
        fake.source(id="bad", url="https://bad.example.org/rss"),
    )
    network = fake.Network(
        {
            "good.example.org": fake.rss(
                fake.rss_item(link="https://good.example.org/1")
            ),
            "bad.example.org": fake.rss(
                fake.rss_item(
                    link="https://bad.example.org/1",
                    date="0001-01-01T00:00:00+01:00",
                )
            ),
        }
    )
    result = await run(network, registry)
    assert result.diagnostics == ["good:ok", "bad:ok"]
    assert [c["url"] for c in result.candidates] == [
        "https://good.example.org/1"
    ]


def test_atom_with_several_links_uses_canonical_arxiv_without_doi():
    (entry,) = researcher.parse_feed(fake.atom(fake.arxiv_entry()))
    assert entry.url == "https://arxiv.org/abs/2610.01234"
    assert entry.version == "v2"
    assert entry.doi == ""
    assert entry.title == "Synthetic wrapped arXiv title"
    assert entry.published == "2026-10-26"


def test_rdf_and_rss_read_dates_dois_and_strip_markup():
    rdf = (
        b'<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" '
        b'xmlns="http://purl.org/rss/1.0/" '
        b'xmlns:dc="http://purl.org/dc/elements/1.1/">'
        b'<item rdf:about="https://www.example.org/articles/s1">'
        b"<title>Synthetic Nature research</title>"
        b"<dc:date>2026-10-26</dc:date>"
        b"<dc:identifier>doi:10.1234/S1</dc:identifier>"
        b"<description>&lt;p&gt;Untrusted &amp;amp; escaped "
        b"&lt;b&gt;markup&lt;/b&gt;&lt;/p&gt;</description>"
        b"</item></rdf:RDF>"
    )
    (entry,) = researcher.parse_feed(rdf)
    assert entry.url == "https://www.example.org/articles/s1"
    assert entry.doi == "10.1234/s1"
    assert entry.text == "Untrusted & escaped markup"
    (item,) = researcher.parse_feed(
        fake.rss(fake.rss_item(doi="10.1234/rss", date="Sat, 24 Oct 2026"))
    )
    assert item.doi == "10.1234/rss"


def test_feed_links_drop_tracking_and_upgrade_scheme():
    url, version = researcher.canonical_url(
        "http://news.example.org/a?id=7&utm_source=x&ref_src=y&at_medium=z#c"
    )
    assert (url, version) == ("https://news.example.org/a?id=7", "")
    # DW and Al Jazeera tag every feed link.
    for tagged in (
        "https://news.example.org/a?maca=en-rss-en-world-4025-rdf",
        "https://news.example.org/a?traffic_source=rss",
    ):
        assert researcher.canonical_url(tagged) == (
            "https://news.example.org/a",
            "",
        )


@pytest.mark.parametrize(
    "raw",
    [
        b'<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///private">]><rss>&x;</rss>',
        b'<!entity x "anything"><rss/>',
        b'<?xml version="1.0"?>\n<!-- note -->\n<!DOCTYPE rss><rss/>',
        '<!DOCTYPE rss [<!ENTITY x "y">]><rss>&x;</rss>'.encode("utf-16"),
        b"<rss><channel><!DOCTYPE rss></channel></rss>",
        b"<html><body><item><title>x</title></item></body></html>",
        b"not xml at all",
        b"",
    ],
)
def test_feed_parser_refuses_entities_and_non_feeds(raw):
    with pytest.raises(ValueError, match=r"[Ff]eed"):
        researcher.parse_feed(raw)


def test_truncated_feed_keeps_closed_items():
    body = fake.rss(
        fake.rss_item(link="https://feeds.example.org/a/1"),
        fake.rss_item(link="https://feeds.example.org/a/2"),
    )
    cut = body[: body.index(b"/a/2") + 2]
    entries = researcher.parse_feed(cut, complete=False)
    assert [entry.url for entry in entries] == ["https://feeds.example.org/a/1"]


def test_crossref_abstract_filters_but_is_never_an_excerpt():
    (entry,) = researcher.parse_crossref(fake.crossref(fake.crossref_item()))
    assert entry.url == "https://doi.org/10.1234/synthetic.crossref"
    assert entry.title == "Synthetic Crossref research"
    assert entry.published == "2026-10-26"
    assert not entry.excerpt and entry.text.startswith("CROSSREF ABSTRACT")


@pytest.mark.parametrize(
    "raw", [b"[]", b"{}", b'{"message":{"items":null}}', b"bad-json"]
)
def test_malformed_crossref_envelopes_fail_safely(raw):
    with pytest.raises(ValueError, match=r"Crossref|JSON"):
        researcher.parse_crossref(raw)


def test_hf_daily_becomes_arxiv_leads_with_upvotes():
    entries = researcher.parse_hf_daily(
        fake.hf_daily(("2610.00001", 50), ("not-an-id", 9), ("2610.00002", 5))
    )
    assert [entry.url for entry in entries] == [
        "https://arxiv.org/abs/2610.00001",
        "https://arxiv.org/abs/2610.00002",
    ]
    assert [entry.upvotes for entry in entries] == [50, 5]


def test_clean_text_unescapes_and_strips_tags():
    raw = "<script>alert(1)</script>&lt;i&gt;Mass&lt;/i&gt; n &lt; m\nend"
    assert researcher.clean_text(raw) == "Mass n < m end"
    assert researcher.clean_text("a<!-- x -->b<STYLE a=1>c</style >d") == (
        "a b d"
    )
    # An unclosed block drops the rest instead of leaking script text.
    assert researcher.clean_text("keep <script>drop() <b>x</b>") == "keep"


def test_clean_text_stays_linear_on_unclosed_blocks():
    # A lazy-regex strip took tens of seconds here and blocked the event
    # loop, so neither the internal deadline nor the node timeout could fire.
    started = time.monotonic()
    for opener in ("<script ", "<style>", "<!--", "<jats:title>"):
        assert researcher.clean_text("x" + opener * 20_000) == "x"
    assert len(researcher.clean_text("<a " * 50_000)) == 8000
    assert time.monotonic() - started < 2


def test_feed_quirks_cdata_doctype_text_and_leading_whitespace():
    item = fake.rss_item(
        description="<![CDATA[<pre><!DOCTYPE html><html></html></pre>"
        + fake.LONG
        + "]]>"
    )
    (entry,) = researcher.parse_feed(b"\n\n  " + fake.rss(item))
    assert entry.text == fake.LONG
    (entry,) = researcher.parse_feed(b"\xef\xbb\xbf" + fake.rss(item))
    assert entry.title == "Synthetic feed item"


# Fetch policy.


async def test_fetch_pins_checked_address_and_sends_bounded_requests():
    network = fake.Network({"feeds.example.org": fake.rss(fake.rss_item())})
    result = await run(network, load(fake.source()))
    (request,) = network.requests
    assert request.url.host == fake.PUBLIC
    assert request.headers["host"] == "feeds.example.org"
    assert request.extensions["sni_hostname"] == "feeds.example.org"
    assert request.headers["accept-encoding"] == "identity"
    assert request.headers["user-agent"] == researcher.USER_AGENT
    assert "authorization" not in request.headers
    assert "cookie" not in request.headers
    assert result.diagnostics == ["synthetic-feed:ok"]
    assert len(result.candidates) == 1


async def test_code_owns_arxiv_crossref_and_daily_parameters():
    network = fake.Network(
        {
            "export.arxiv.org": fake.atom(),
            "api.crossref.org": fake.crossref(),
            "huggingface.co": fake.hf_daily(),
        }
    )
    await run(
        network,
        load(
            fake.source(
                id="a",
                kind="arxiv",
                url="https://export.arxiv.org/api/query",
                query="cat:cs.LG",
            ),
            fake.source(
                id="c",
                kind="crossref",
                url="https://api.crossref.org/journals/0000-0000/works",
            ),
            fake.source(
                id="h", kind="hf_daily", url="https://huggingface.co/api/x"
            ),
        ),
    )
    params = {r.headers["host"]: r.url.params for r in network.requests}
    assert params["export.arxiv.org"]["search_query"] == (
        "(cat:cs.LG) AND submittedDate:[202610240000 TO 202610282359]"
    )
    assert params["export.arxiv.org"]["max_results"] == "100"
    assert params["api.crossref.org"]["filter"] == (
        "from-created-date:2026-10-21,type:journal-article"
    )
    assert "mailto" not in params["api.crossref.org"]
    assert params["huggingface.co"]["date"] == "2026-10-27"


async def test_hosts_are_serial_and_spaced_with_no_retries():
    network = fake.Network(
        {
            "export.arxiv.org": fake.atom(),
            "feeds.example.org": httpx.Response(500, content=b"private"),
        }
    )
    arxiv = [
        fake.source(
            id=f"a{n}",
            kind="arxiv",
            url="https://export.arxiv.org/api/query",
            query="cat:cs.LG",
        )
        for n in range(3)
    ]
    feeds = [fake.source(id=f"f{n}") for n in range(2)]
    result = await run(network, load(*arxiv, *feeds))
    assert sorted(network.sleeps) == [1.0, 3.0, 3.0]
    assert len(network.requests) == 5
    assert "f0:http_error" in result.diagnostics
    assert "private" not in repr(result)


async def test_at_most_four_hosts_are_fetched_at_once():
    active = peak = 0
    release = asyncio.Event()

    async def slow(request):
        nonlocal active, peak
        active += 1
        peak = max(peak, active)
        await asyncio.sleep(0)
        if active >= 4:
            release.set()
        await release.wait()
        active -= 1
        return httpx.Response(200, content=fake.rss())

    hosts = [f"h{n}.example.org" for n in range(6)]
    network = fake.Network(dict.fromkeys(hosts, slow))
    await run(
        network,
        load(
            *[
                fake.source(id=f"s{n}", url=f"https://{host}/rss")
                for n, host in enumerate(hosts)
            ]
        ),
    )
    assert peak == researcher.HOST_CHAINS
    assert len(network.requests) == 6


@pytest.mark.parametrize("status", [301, 302, 307, 308, 401, 404, 429, 500])
async def test_redirects_and_errors_are_not_followed_or_retried(status):
    network = fake.Network(
        {
            "feeds.example.org": httpx.Response(
                status,
                headers={"location": "http://169.254.169.254/latest"},
                content=b"private-error",
            )
        }
    )
    result = await run(network, load(fake.source()))
    assert len(network.requests) == 1
    assert result.diagnostics == ["synthetic-feed:http_error"]
    assert researcher.failed(result)
    assert "private-error" not in repr(result)


@pytest.mark.parametrize(
    "addresses",
    [
        ["127.0.0.1"],
        ["10.0.0.7"],
        ["192.168.1.2"],
        ["169.254.169.254"],
        ["100.64.0.1"],
        ["224.0.0.1"],
        ["::1"],
        ["fd00::1"],
        ["::ffff:10.0.0.1"],
        ["64:ff9b::a00:7"],
        ["::7f00:1"],
        [fake.PUBLIC, "10.0.0.7"],
        ["not-an-address"],
    ],
)
async def test_non_global_addresses_are_blocked_before_any_request(addresses):
    network = fake.Network(
        {"feeds.example.org": fake.rss(fake.rss_item())},
        {"feeds.example.org": addresses},
    )
    result = await run(network, load(fake.source()))
    assert network.requests == []
    assert result.diagnostics == ["synthetic-feed:unsafe_address"]
    assert not result.candidates


async def test_nat64_to_a_public_address_is_allowed():
    network = fake.Network(
        {"feeds.example.org": fake.rss(fake.rss_item())},
        {"feeds.example.org": ["64:ff9b::5db8:d70e"]},
    )
    result = await run(network, load(fake.source()))
    assert result.diagnostics == ["synthetic-feed:ok"]


async def test_ipv4_is_preferred_and_ipv6_is_bracketed():
    v6 = "2606:2800:21f:cb07:6820:80da:af6b:8b2c"
    body = fake.rss(fake.rss_item())
    network = fake.Network(
        {"feeds.example.org": body, "v6.example.org": body},
        {
            "feeds.example.org": [v6, fake.PUBLIC],
            "v6.example.org": [v6],
        },
    )
    await run(
        network,
        load(
            fake.source(),
            fake.source(id="v6", url="https://v6.example.org/rss"),
        ),
    )
    hosts = {r.headers["host"]: r.url.host for r in network.requests}
    assert hosts == {"feeds.example.org": fake.PUBLIC, "v6.example.org": v6}


async def test_resolver_failure_is_unavailable():
    async def broken(host):
        raise OSError("private resolver text")

    result = await researcher.Researcher(
        transport=fake.Network({}).transport(), resolver=broken
    ).fetch(load(fake.source()), DAY, budget_seconds=5)
    assert result.diagnostics == ["synthetic-feed:unavailable"]


async def test_one_failure_keeps_other_sources():
    def broken(request):
        raise httpx.ConnectError("private transport body")

    network = fake.Network(
        {
            "feeds.example.org": broken,
            "other.example.org": fake.rss(fake.rss_item()),
        }
    )
    result = await run(
        network,
        load(
            fake.source(),
            fake.source(id="other", url="https://other.example.org/rss"),
        ),
    )
    assert result.diagnostics == ["synthetic-feed:unavailable", "other:ok"]
    assert len(result.candidates) == 1
    assert "private" not in repr(result)


async def test_byte_caps_truncate_feeds_and_refuse_json():
    items = [
        fake.rss_item(
            title=f"Synthetic item {n}",
            link=f"https://feeds.example.org/a/{n}",
            description=fake.LONG * 100,
        )
        for n in range(20)
    ]
    big = fake.rss(*items)
    assert len(big) > researcher.MIN_SOURCE_BYTES
    network = fake.Network(
        {
            "feeds.example.org": big,
            "api.crossref.org": b"{" + b" " * researcher.MIN_SOURCE_BYTES,
        }
    )
    result = await run(
        network,
        load(
            fake.source(max_bytes=researcher.MIN_SOURCE_BYTES),
            fake.source(
                id="c",
                kind="crossref",
                url="https://api.crossref.org/journals/0000-0000/works",
                max_bytes=researcher.MIN_SOURCE_BYTES,
            ),
        ),
    )
    assert result.diagnostics[:3] == [
        "synthetic-feed:ok",
        "synthetic-feed:truncated",
        "c:too_large",
    ]
    assert 0 < len(result.candidates) < 20


async def test_request_timeout_is_a_finite_code(monkeypatch):
    monkeypatch.setattr(researcher, "REQUEST_SECONDS", 0.01)

    async def stalled(request):
        await asyncio.sleep(1)
        return httpx.Response(200)

    network = fake.Network({"feeds.example.org": stalled})
    result = await run(network, load(fake.source()))
    assert result.diagnostics == ["synthetic-feed:timeout"]


async def test_stalled_resolver_is_a_request_timeout(monkeypatch):
    monkeypatch.setattr(researcher, "REQUEST_SECONDS", 0.01)

    async def stalled(host):
        await asyncio.Event().wait()

    result = await researcher.Researcher(
        transport=fake.Network({}).transport(), resolver=stalled
    ).fetch(load(fake.source()), DAY, budget_seconds=5)
    assert result.diagnostics == ["synthetic-feed:timeout"]


def test_long_host_chains_take_a_slot_first():
    registry = load(
        fake.source(id="single", url="https://one.example.org/rss"),
        fake.source(id="a1", url="https://serial.example.org/1"),
        fake.source(id="a2", url="https://serial.example.org/2"),
    )
    chains = researcher._host_chains(registry)
    assert [[s.id for s in chain] for chain in chains] == [
        ["a1", "a2"],
        ["single"],
    ]
    # A front page's single feeds go before other single feeds.
    front = load(
        fake.source(id="single", url="https://one.example.org/rss"),
        fake.source(id="page", url="https://page.example.org/rss"),
        fake.source(id="news", url="https://two.example.org/rss"),
        fake.source(
            id="front", url="https://three.example.org/rss", role="headline"
        ),
    )
    assert [chain[0].id for chain in researcher._host_chains(front)] == [
        "front",
        "single",
        "page",
        "news",
    ]


async def test_deadline_keeps_finished_sources():
    never = asyncio.Event()

    async def stalled(request):
        await never.wait()
        return httpx.Response(200)

    network = fake.Network(
        {
            "fast.example.org": fake.rss(fake.rss_item()),
            "slow.example.org": stalled,
        }
    )
    registry = load(
        fake.source(id="fast", url="https://fast.example.org/rss"),
        fake.source(id="slow", url="https://slow.example.org/rss"),
        fake.source(id="later", url="https://slow.example.org/other"),
    )
    result = await run(network, registry, budget=0.05)
    assert result.diagnostics == ["fast:ok", "slow:deadline", "later:deadline"]
    assert len(result.candidates) == 1
    assert researcher.failed(result)


async def test_outer_cancellation_propagates():
    started = asyncio.Event()

    async def stalled(request):
        started.set()
        await asyncio.Event().wait()

    network = fake.Network({"feeds.example.org": stalled})
    task = asyncio.create_task(run(network, load(fake.source())))
    await started.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task


# Filtering, merging and routing.


async def test_arxiv_error_entries_are_not_leads():
    error = (
        "<entry><id>http://arxiv.org/api/errors#bad_query</id>"
        "<title>Error</title><summary>bad query</summary>"
        "<updated>2026-10-28T00:00:00-04:00</updated>"
        '<link href="http://arxiv.org/api/errors#bad_query" rel="alternate"/>'
        "</entry>"
    )
    network = fake.Network(
        {"export.arxiv.org": fake.atom(error, fake.arxiv_entry())}
    )
    result = await run(
        network,
        load(
            fake.source(
                kind="arxiv",
                url="https://export.arxiv.org/api/query",
                query="cat:cs.LG",
            )
        ),
    )
    assert [c["url"] for c in result.candidates] == [
        "https://arxiv.org/abs/2610.01234"
    ]


def test_source_basis_names_at_most_five_feeds():
    names = [f"Synthetic Journal Number {n:02d} " + "x" * 50 for n in range(9)]
    basis = researcher._basis(names)
    assert basis.startswith("研究员订阅源：" + names[0])
    assert names[4] in basis and names[5] not in basis
    assert basis.endswith("等（仅元数据，未打开原文）")
    assert len(basis) <= 1200


async def test_future_stale_and_undated_items_are_dropped():
    network = fake.Network(
        {
            "feeds.example.org": fake.rss(
                fake.rss_item(link="https://feeds.example.org/now"),
                fake.rss_item(
                    link="https://feeds.example.org/future",
                    date="2026-10-29",
                ),
                fake.rss_item(
                    link="https://feeds.example.org/old", date="2026-10-01"
                ),
                fake.rss_item(link="https://feeds.example.org/u1", date=""),
                fake.rss_item(link="https://feeds.example.org/u2", date="?"),
            )
        }
    )
    result = await run(network, load(fake.source()))
    assert [c["url"] for c in result.candidates] == [
        "https://feeds.example.org/now"
    ]
    assert result.diagnostics == [
        "synthetic-feed:ok",
        "synthetic-feed:undated:2",
    ]


async def test_keywords_abstracts_and_history_filter_leads():
    network = fake.Network(
        {
            "feeds.example.org": fake.rss(
                fake.rss_item(
                    title="Seismic waves", link="https://feeds.example.org/1"
                ),
                fake.rss_item(
                    title="Default settings",
                    link="https://feeds.example.org/2",
                ),
                fake.rss_item(
                    title="Faults, short",
                    link="https://feeds.example.org/3",
                    description="tiny",
                ),
                fake.rss_item(
                    title="Faults seen before",
                    link="https://feeds.example.org/4",
                ),
            )
        }
    )
    history = [{"url": "https://feeds.example.org/4", "title": "Old"}]
    result = await run(
        network,
        load(
            fake.source(keywords=["seism*", "fault*"], requires_abstract=True)
        ),
        history=history,
    )
    assert [c["url"] for c in result.candidates] == [
        "https://feeds.example.org/1"
    ]


async def test_shared_paper_merges_into_its_arxiv_direction_and_ranks_first():
    network = fake.Network(
        {
            "export.arxiv.org": fake.atom(
                fake.arxiv_entry("2610.00001", title="Plain new paper"),
                fake.arxiv_entry(
                    "2610.00002",
                    title="Popular older paper",
                    published="2026-10-25T00:00:00Z",
                ),
            ),
            "huggingface.co": fake.hf_daily(
                ("2610.00002", 90), ("2610.00003", 10)
            ),
        }
    )
    result = await run(
        network,
        load(
            fake.source(
                id="arxiv-arch",
                name="arXiv",
                direction="08-llm-architectures",
                kind="arxiv",
                url="https://export.arxiv.org/api/query",
                query="cat:cs.CL",
            ),
            fake.source(
                id="hf",
                name="Hugging Face Daily Papers",
                direction="01-ai-ml",
                kind="hf_daily",
                url="https://huggingface.co/api/daily_papers",
            ),
        ),
    )
    by_url = {c["url"]: c for c in result.candidates}
    shared = by_url["https://arxiv.org/abs/2610.00002"]
    assert shared["direction"] == "08-llm-architectures"
    assert shared["source_basis"] == (
        "研究员订阅源：arXiv、Hugging Face Daily Papers（仅元数据，未打开原文）"
    )
    assert shared["venue"] == "arXiv" and shared["doi"] == ""
    assert result.notes[shared["id"]]["signals"] == {
        "independent_sources": 2,
        "hf_upvote_percentile": 50,
    }
    arch = [
        c["url"]
        for c in result.candidates
        if c["direction"] == "08-llm-architectures"
    ]
    assert arch == [
        "https://arxiv.org/abs/2610.00002",
        "https://arxiv.org/abs/2610.00001",
    ]
    assert by_url["https://arxiv.org/abs/2610.00003"]["direction"] == (
        "01-ai-ml"
    )


async def test_source_counts_are_keyed_by_id_and_seeds_add_up():
    network = fake.Network(
        {
            # Two arXiv sources share one name and one host's answer.
            "export.arxiv.org": fake.atom(
                fake.arxiv_entry("2610.00001", title="First paper"),
                fake.arxiv_entry("2610.00002", title="Second paper"),
            ),
            "feeds.example.org": fake.rss(
                fake.rss_item(link="https://feeds.example.org/now"),
                fake.rss_item(link="https://feeds.example.org/u", date=""),
                fake.rss_item(link="https://feeds.example.org/known"),
            ),
            "down.example.org": httpx.Response(503),
        }
    )
    arxiv = {
        "name": "arXiv",
        "direction": "08-llm-architectures",
        "kind": "arxiv",
        "url": "https://export.arxiv.org/api/query",
    }
    registry = load(
        fake.source(id="arxiv-a", query="cat:cs.CL", **arxiv),
        fake.source(id="arxiv-b", query="cat:cs.LG", **arxiv),
        fake.source(),
        fake.source(id="down", url="https://down.example.org/rss"),
    )
    result = await run(
        network,
        registry,
        history=[{"url": "https://feeds.example.org/known", "title": "Old"}],
    )
    assert result.sources == [
        {
            "id": "arxiv-a",
            "code": "ok",
            "entries": 2,
            "accepted": 2,
            "seeds": 2,
            "truncated": False,
        },
        {
            "id": "arxiv-b",
            "code": "ok",
            "entries": 2,
            "accepted": 2,
            "seeds": 0,
            "truncated": False,
        },
        {
            "id": "synthetic-feed",
            "code": "ok",
            "entries": 3,
            "accepted": 1,
            "seeds": 1,
            "truncated": False,
        },
        {
            "id": "down",
            "code": "http_error",
            "entries": 0,
            "accepted": 0,
            "seeds": 0,
            "truncated": False,
        },
    ]
    assert sum(item["seeds"] for item in result.sources) == len(
        result.candidates
    )
    # The counts add a key; the diagnostic strings and failed() are as before.
    assert result.diagnostics == [
        "arxiv-a:ok",
        "arxiv-b:ok",
        "synthetic-feed:ok",
        "synthetic-feed:undated:1",
        "down:http_error",
    ]
    assert researcher.failed(result)
    assert not researcher.failed(
        sources.MetadataResult([], result.diagnostics[:4], {}, result.sources)
    )


def test_source_counts_follow_trimming_and_stay_outside_the_lead_budget(
    monkeypatch,
):
    monkeypatch.setattr(researcher, "MAX_ARTIFACT_BYTES", 3000)
    registry = load(fake.source())
    entries = [
        researcher.Entry(
            title=f"Synthetic bounded item {n}",
            url=f"https://feeds.example.org/a/{n}",
            doi="",
            version="",
            published="2026-10-27",
            text=fake.LONG,
            excerpt=True,
        )
        for n in range(5)
    ]
    outcomes = {0: researcher._Outcome("ok", entries, truncated=True)}
    result = researcher.assemble(registry, outcomes, DAY)
    monkeypatch.setattr(researcher, "_source_counts", lambda *_: [])
    without = researcher.assemble(registry, outcomes, DAY)
    assert result.candidates == without.candidates
    assert result.diagnostics == without.diagnostics
    assert result.sources == [
        {
            "id": "synthetic-feed",
            "code": "ok",
            "entries": 5,
            "accepted": 5,
            "seeds": len(result.candidates),
            "truncated": True,
        }
    ]
    assert 0 < len(result.candidates) < 5


async def test_routing_round_robins_sources_and_caps_each_direction():
    def items(host, count):
        return fake.rss(
            *[
                fake.rss_item(
                    title=f"{host} item {n}",
                    link=f"https://{host}/a/{n}",
                    date=f"2026-10-{27 - n % 5:02d}",
                )
                for n in range(count)
            ]
        )

    hosts = [f"j{n}.example.org" for n in range(6)]
    network = fake.Network(
        {
            **{host: items(host, 8) for host in hosts},
            "fed.example.org": items("fed.example.org", 3),
        }
    )
    registry = load(
        *[
            fake.source(
                id=f"j{n}", name=f"Journal {n}", url=f"https://{host}/rss"
            )
            for n, host in enumerate(hosts)
        ],
        fake.source(
            id="fed",
            name="Synthetic Bank",
            direction="04-economy",
            url="https://fed.example.org/rss",
            max_seeds=2,
        ),
    )
    result = await run(network, registry)
    science = [c for c in result.candidates if c["direction"] == "02-science"]
    assert len(science) == researcher.MAX_SEEDS_PER_DIRECTION
    # Round one takes the best item of every journal before any second item.
    assert {c["venue"] for c in science[:6]} == {
        f"Journal {n}" for n in range(6)
    }
    economy = [c for c in result.candidates if c["direction"] == "04-economy"]
    assert len(economy) == 2
    # Directions interleave, so leftover pool slots are not one direction.
    assert [c["direction"] for c in result.candidates[:4]] == [
        "02-science",
        "04-economy",
        "02-science",
        "04-economy",
    ]
    assert set(result.notes) == {c["id"] for c in result.candidates}


def test_headline_groups_rank_a_story_many_outlets_carry_first():
    # Thresholds calibrated on a real day's feeds, pinned here: five outlets'
    # differently worded election stories form one group, the war beat's
    # strikes stay apart except two reports of one strike and the ceasefire,
    # template strikes on four cities never merge, two earthquakes keep their
    # own three outlets each, and the busy public figures' unrelated stories
    # never reach a consensus.
    registry = headline_registry()
    result = researcher.assemble(
        registry, front_page_outcomes(registry), DAY, now=fake.NOW
    )
    by_title = {c["title"]: c for c in result.candidates}
    outlets = {
        c["title"]: result.notes[c["id"]]["signals"]["independent_sources"]
        for c in result.candidates
    }
    election, ceasefire = result.candidates[:2]
    assert election["title"] == fake.ELECTION[0][0]
    assert election["url"] == "https://outlet0.example.org/0"
    assert result.notes[election["id"]] == {
        "source": "BBC、NPR、The Guardian、DW、Al Jazeera",
        "excerpt_untrusted": fake.ELECTION[0][1],
        "signals": {"independent_sources": 5, "headline_window_hours": 48},
        "alternate_urls": [
            "https://outlet1.example.org/0",
            "https://outlet2.example.org/0",
            "https://outlet3.example.org/0",
        ],
    }
    assert election["source_basis"] == (
        "研究员头条订阅源：BBC、NPR、The Guardian、DW、Al Jazeera共5家标题相近"
        "（代码按标题聚类，仅元数据，未打开原文）"
    )
    assert ceasefire["title"] == "Sylvania and Ruritania agree 30-day ceasefire"
    # Two outlets on one strike join; the beat's other strikes stay apart.
    strike = "Sylvanian drones strike Port Vell power plant"
    assert "Port Vell power plant struck by Sylvanian drones" not in by_title
    norland, estmark = fake.DISASTERS[0][1], fake.DISASTERS[3][1]
    # Multi-outlet groups rank first, so these are all of them. A title that
    # names a rare city the other never mentions is another event, so the
    # template strikes and the other country's earthquake never join. Two
    # stories that name only the same figure can still pair up.
    assert {title: n for title, n in outlets.items() if n > 1} == {
        election["title"]: 5,
        ceasefire["title"]: 3,
        norland: 3,
        estmark: 3,
        strike: 2,
        fake.FULL_NAME[1][1]: 2,
    }
    assert not any(
        result.notes[c["id"]]["signals"].get("headline_echo")
        for c in result.candidates
    )
    # The five outlets' budgets cap the groups; every group is one seed.
    assert len(result.candidates) == 20
    assert result.headlines == [
        {
            "direction": "04-economy",
            "feeds": 5,
            "feeds_ok": 5,
            # 70 entries less the 12 that joined the six groups.
            "entries": 70,
            "groups": 58,
            "consensus_groups": 4,
            "max_outlets": 5,
            "top": [
                {"title": fake.ELECTION[0][0], "outlets": 5},
                {"title": ceasefire["title"], "outlets": 3},
                {"title": norland, "outlets": 3},
            ],
        }
    ]
    assert sum(item["seeds"] for item in result.sources) == 20
    for candidate in result.candidates:
        assert content.seed_view(candidate) == candidate


def test_headline_window_history_and_times():
    registry = headline_registry()
    page = fake.front_page()
    outcomes = front_page_outcomes(registry, page)
    stale = headline_entry(0, 90, "Stale synthetic headline", "", minutes=2881)
    timeless = dataclasses.replace(
        headline_entry(1, 91, "Untimed synthetic headline", ""), moment=None
    )
    outcomes[0].entries.append(stale)
    outcomes[1].entries.append(timeless)
    history = [{"url": "https://outlet0.example.org/0", "title": "Seen"}]
    result = researcher.assemble(registry, outcomes, DAY, history, now=fake.NOW)
    titles = [c["title"] for c in result.candidates]
    assert "Untimed synthetic headline" not in titles
    assert "outlet-1:undated:1" in result.diagnostics
    # 70 front-page entries and the stale one, less the seen and the stale.
    assert result.headlines[0]["entries"] == 69
    # History drops only the outlet's entry it saw, never the group.
    election = result.candidates[0]
    assert election["url"] == "https://outlet1.example.org/0"
    assert result.notes[election["id"]]["signals"]["independent_sources"] == 4
    # Without a clock only the date window applies.
    dated = researcher.assemble(registry, outcomes, DAY, history)
    assert dated.headlines[0]["entries"] == 70


def test_a_report_another_lead_carries_still_counts_its_outlet():
    # BBC's election report also runs in a plain feed, which keeps it as a
    # seed; the headline group still counts BBC.
    plain = fake.source(
        id="bbc-plain",
        name="BBC",
        direction="02-science",
        url="https://plain.example.org/rss",
    )
    registry = load(
        plain,
        *[
            fake.source(
                id=f"outlet-{n}",
                name=name,
                direction="04-economy",
                url=f"https://outlet{n}.example.org/rss",
                max_seeds=4,
                max_age_days=2,
                role="headline",
            )
            for n, name in enumerate(fake.OUTLETS)
        ],
    )
    outcomes = front_page_outcomes(registry[1:])
    bbc = outcomes[1].entries[0]
    outcomes[0] = researcher._Outcome("ok", [bbc])
    result = researcher.assemble(registry, outcomes, DAY, now=fake.NOW)
    by_url = {c["url"]: c for c in result.candidates}
    assert by_url[bbc.url]["direction"] == "02-science"
    election = next(
        c for c in result.candidates if c["direction"] == "04-economy"
    )
    note = result.notes[election["id"]]
    assert election["url"] != bbc.url
    assert note["signals"]["independent_sources"] == 5
    assert note["source"].endswith("、BBC")
    assert bbc.url not in note["alternate_urls"]
    assert result.headlines[0]["entries"] == 70


def test_a_big_story_split_in_several_groups_is_marked_an_echo():
    # The election's market and regional reactions each reach three
    # outlets but repeat the election's dominant words; an earthquake on the
    # same day does not. Consensus picks the earthquake before the echoes.
    page = {
        outlet: [story]
        for outlet, story in zip(fake.OUTLETS, fake.ELECTION, strict=True)
    }
    reactions = (
        (
            "BBC",
            "Freedonia election result lifts markets",
            "Shares in Freedonia rose after the election result.",
        ),
        (
            "NPR",
            "Markets rise after Freedonia election",
            "Freedonia shares rose as investors welcomed the election result.",
        ),
        (
            "DW",
            "Freedonia shares climb as markets cheer election result",
            "Investors in Freedonia bought shares after the election result.",
        ),
        (
            "The Guardian",
            "Neighbours welcome Freedonia election result",
            "Leaders across the region welcomed the Freedonia election result.",
        ),
        (
            "Al Jazeera",
            "Regional leaders welcome Freedonia election",
            "Leaders in the region welcomed the result of the Freedonia "
            "election.",
        ),
        (
            "BBC",
            "Freedonia election: neighbours welcome result",
            "Regional leaders welcomed Freedonia's election result.",
        ),
    )
    for outlet, title, text in reactions + fake.DISASTERS[:3]:
        page[outlet].append((title, text))
    for outlet, items in fake.front_page().items():
        page[outlet] += [item for item in items if "festival" in item[0]]
    registry = headline_registry()
    result = researcher.assemble(
        registry, front_page_outcomes(registry, page), DAY, now=fake.NOW
    )
    signals = {
        c["title"]: result.notes[c["id"]]["signals"] for c in result.candidates
    }
    consensus = {
        title: bool(value.get("headline_echo"))
        for title, value in signals.items()
        if value["independent_sources"] >= content.CONSENSUS_OUTLETS
    }
    norland = fake.DISASTERS[1][1]
    assert consensus == {
        fake.ELECTION[0][0]: False,
        norland: False,
        reactions[0][1]: True,
        reactions[3][1]: True,
    }
    picked = content.consensus_leads(result.candidates, result.notes, [], {})
    assert [lead["title"] for lead, _ in picked][:2] == [
        fake.ELECTION[0][0],
        norland,
    ]
    assert result.headlines[0]["consensus_groups"] == 4


def test_the_headline_record_counts_failed_front_pages():
    registry = headline_registry()
    outcomes = front_page_outcomes(registry)
    outcomes[2] = researcher._Outcome("timeout", [])
    result = researcher.assemble(registry, outcomes, DAY, now=fake.NOW)
    (record,) = result.headlines
    assert (record["feeds"], record["feeds_ok"]) == (5, 4)
    # Every front page failed: a record with nothing in it, not a quiet day.
    down = {index: researcher._Outcome("http_error", []) for index in outcomes}
    (empty,) = researcher.assemble(registry, down, DAY, now=fake.NOW).headlines
    assert empty == {
        "direction": "04-economy",
        "feeds": 5,
        "feeds_ok": 0,
        "entries": 0,
        "groups": 0,
        "consensus_groups": 0,
        "max_outlets": 0,
        "top": [],
    }


def test_a_directions_headline_groups_take_one_turn_per_round():
    registry = load(
        *[
            fake.source(
                id=f"outlet-{n}",
                name=name,
                direction="04-economy",
                url=f"https://outlet{n}.example.org/rss",
                max_seeds=1,
                role="headline",
            )
            for n, name in enumerate(fake.OUTLETS)
        ],
        fake.source(
            id="bank",
            name="Synthetic Bank",
            direction="04-economy",
            url="https://bank.example.org/rss",
        ),
    )
    outcomes = front_page_outcomes(registry[:5])
    outcomes[5] = researcher._Outcome(
        "ok",
        [
            researcher.Entry(
                title=f"Synthetic bank release {n}",
                url=f"https://bank.example.org/{n}",
                doi="",
                version="",
                published="2026-10-27",
                text="",
                excerpt=True,
            )
            for n in range(3)
        ],
    )
    result = researcher.assemble(registry, outcomes, DAY, now=fake.NOW)
    assert [c["title"] for c in result.candidates] == [
        fake.ELECTION[0][0],
        "Synthetic bank release 0",
        "Sylvania and Ruritania agree 30-day ceasefire",
        "Synthetic bank release 1",
        result.candidates[4]["title"],
        "Synthetic bank release 2",
        *[c["title"] for c in result.candidates[6:]],
    ]
    # Five headline feeds with one seed each: five groups.
    assert len(result.candidates) == 5 + 3


async def test_authored_headline_feeds_bring_a_major_story_from_every_outlet():
    # 03-world once had no leads and missed an election result; its headline
    # feeds now carry a story every front page leads with as one lead that
    # names every outlet and offers three other outlets' pages.
    path = pathlib.Path(__file__).resolve().parents[1] / "content-config"
    registry = researcher.validate_registry(
        (path / "researcher.yaml").read_text(encoding="utf-8"),
        [item.stem for item in (path / "discovery").glob("*.md")],
    )
    world = [s for s in registry if s.direction == "03-world"]
    economy = [s for s in registry if s.direction == "04-economy"]
    assert len({s.name for s in world}) >= 6
    assert all(s.role == "headline" and s.max_age_days <= 2 for s in world)
    assert {s.role for s in economy} == {"", "headline"}
    page = fake.front_page()
    for name, story in (("PBS NewsHour", 0), ("France 24", 1)):
        page[name] = [
            fake.ELECTION[story],
            *[(f"{name} synthetic local story {n}", "") for n in range(6)],
        ]
    assert set(page) == {s.name for s in world}

    def front_page(host, items):
        slug = host.split(".")[-2]
        stamps = [
            (fake.NOW - datetime.timedelta(minutes=10 * n + 10)).isoformat()
            for n in range(len(items))
        ]
        items = [
            *zip(items, stamps, strict=True),
            (("Old synthetic summit", ""), "2026-10-24T09:00:00+00:00"),
        ]
        if host == "rss.dw.com":  # DW serves RDF dated with dc:date
            return (
                "<rdf:RDF "
                'xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" '
                'xmlns="http://purl.org/rss/1.0/" '
                'xmlns:dc="http://purl.org/dc/elements/1.1/">'
                + "".join(
                    f'<item rdf:about="https://{slug}.example.org/{n}">'
                    f"<title>{title}</title><dc:date>{stamp}</dc:date>"
                    f"<description>{text}</description></item>"
                    for n, ((title, text), stamp) in enumerate(items)
                )
                + "</rdf:RDF>"
            ).encode()
        return fake.rss(
            *[
                fake.rss_item(
                    title=title,
                    link=f"https://{slug}.example.org/{n}",
                    date=stamp,
                    description=text,
                )
                for n, ((title, text), stamp) in enumerate(items)
            ]
        )

    network = fake.Network(
        {
            parse.urlsplit(s.url).hostname or "": front_page(
                parse.urlsplit(s.url).hostname or "", page[s.name]
            )
            for s in world
        }
    )
    result = await run(network, world)
    assert all(code.endswith(":ok") for code in result.diagnostics)
    assert {c["direction"] for c in result.candidates} == {"03-world"}
    assert len(result.candidates) <= researcher.MAX_SEEDS_PER_DIRECTION
    lead = result.candidates[0]
    note = result.notes[lead["id"]]
    assert note["signals"]["independent_sources"] == len(world)
    assert len(note["alternate_urls"]) == content.MAX_ALTERNATE_URLS
    assert "Old synthetic summit" not in [c["title"] for c in result.candidates]
    # The election, the ceasefire and the two earthquakes.
    assert result.headlines[0]["consensus_groups"] == 4


async def test_every_lead_is_a_valid_metadata_seed_and_notes_are_bounded():
    network = fake.Network(
        {
            "feeds.example.org": fake.rss(
                fake.rss_item(description="&lt;b&gt;" + "word " * 200),
                fake.rss_item(
                    title="Bad link",
                    link="http://127.0.0.1/private",
                ),
            ),
            "api.crossref.org": fake.crossref(fake.crossref_item()),
        }
    )
    result = await run(
        network,
        load(
            fake.source(),
            fake.source(
                id="c",
                name="Synthetic Crossref",
                kind="crossref",
                url="https://api.crossref.org/journals/0000-0000/works",
            ),
        ),
    )
    assert "synthetic-feed:invalid_items:1" in result.diagnostics
    for candidate in result.candidates:
        assert content.seed_view(candidate) == candidate
        assert candidate["access_scope"] == "metadata"
        assert candidate["summary"].startswith("公开出版元数据线索")
        note = result.notes[candidate["id"]]
        assert len(note["excerpt_untrusted"]) <= researcher.EXCERPT_CHARS
        assert "<" not in note["excerpt_untrusted"]
    crossref = next(
        c for c in result.candidates if c["provenance"] == "crossref_metadata"
    )
    assert result.notes[crossref["id"]]["excerpt_untrusted"] == ""
    assert "CROSSREF ABSTRACT" not in json.dumps(result.candidates)
    assert "CROSSREF ABSTRACT" not in json.dumps(result.notes)
    # Feed text stays out of every Candidate field.
    assert "word word" not in json.dumps(result.candidates)


def test_artifact_is_trimmed_to_its_byte_budget(monkeypatch):
    monkeypatch.setattr(researcher, "MAX_ARTIFACT_BYTES", 3000)
    registry = load(fake.source())
    entries = [
        researcher.Entry(
            title=f"Synthetic bounded item {n}",
            url=f"https://feeds.example.org/a/{n}",
            doi="",
            version="",
            published="2026-10-27",
            text=fake.LONG,
            excerpt=True,
        )
        for n in range(5)
    ]
    outcomes = {0: researcher._Outcome("ok", entries)}
    result = researcher.assemble(registry, outcomes, DAY)
    body = {
        "candidates": result.candidates,
        "notes": result.notes,
        "diagnostics": result.diagnostics,
    }
    assert len(contracts.canonical_json(body).encode()) <= 3000
    assert result.diagnostics[-1].startswith("artifact:trimmed:")
    assert 0 < len(result.candidates) < 5


def test_disabled_sources_are_not_fetched_or_reported():
    registry = load(fake.source(enabled=False))
    result = researcher.assemble(
        [s for s in registry if s.enabled], {}, DAY, ()
    )
    assert result == sources.MetadataResult([], [], {})

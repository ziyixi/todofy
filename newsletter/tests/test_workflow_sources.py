"""Test Crossref/RSS with synthetic fixtures and fixed mock endpoints."""

import asyncio
import json

import httpx
import pytest

import newsletter.errors as errors
import newsletter.workflow.sources as sources

DAY = "2026-09-06"


def record(**changes):
    return {
        "DOI": "10.1234/Synthetic",
        "title": ["Synthetic journal research"],
        "type": "journal-article",
        "published-online": {"date-parts": [[2026, 9, 5]]},
        "URL": "http://127.0.0.1/never-follow-me",
        "abstract": "Untrusted unpublished clinical claim",
        **changes,
    }


def crossref(*items):
    return json.dumps({"message": {"items": list(items)}}).encode()


def rss(
    url="https://www.nature.com/articles/synthetic", published="2026-09-05"
):
    return (
        '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"\n'
        '      xmlns="http://purl.org/rss/1.0/" '
        'xmlns:dc="http://purl.org/dc/elements/1.1/">\n'
        "      <item><title>Synthetic Nature research</title>"
        f"<link>{url}</link><dc:date>{published}</dc:date>\n"
        "      <description>Unverified experimental claim must not enter "
        "a packet.</description></item>\n"
        "      </rdf:RDF>"
    ).encode()


def test_crossref_metadata_never_asserts_abstract_or_follow_up_url_access():
    result = sources.parse_crossref(crossref(record()), DAY)
    assert len(result) == 1
    item = result[0]
    assert item["url"] == "https://doi.org/10.1234/synthetic"
    assert item["published_at"] == "2026-09-05"
    assert (
        item["access_scope"] == "metadata"
        and item["provenance"] == "crossref_metadata"
    )
    assert "clinical claim" not in json.dumps(item)
    assert "127.0.0.1" not in json.dumps(item)


def test_crossref_does_not_invent_day_from_partial_date_or_use_indexed_date():
    item = record(
        **{
            "published-online": {"date-parts": [[2026, 9]]},
            "indexed": {"date-time": "2026-09-06T00:00:00Z"},
        }
    )
    assert sources.parse_crossref(crossref(item), DAY)[0]["published_at"] == ""


@pytest.mark.parametrize(
    "item",
    [
        record(DOI="invalid"),
        record(DOI=None),
        record(title=[]),
        record(title=["x" * 501]),
        record(type="book"),
        record(**{"published-online": {"date-parts": [[2026, 9, 7]]}}),
        record(**{"published-online": {"date-parts": [[2026, 13, 7]]}}),
    ],
)
def test_invalid_future_or_irrelevant_crossref_records_are_not_candidates(item):
    assert sources.parse_crossref(crossref(item), DAY) == []


@pytest.mark.parametrize(
    "raw",
    [
        b"[]",
        b"{}",
        b'{"message":null}',
        b'{"message":{"items":null}}',
        b"bad-json",
    ],
)
def test_malformed_crossref_envelopes_fail_safely(raw):
    with pytest.raises((ValueError, errors.EditorError)):
        sources.parse_crossref(raw, DAY)


def test_rss_rdf_titles_dates_and_links_are_metadata_only():
    item = sources.parse_rss(rss(), DAY)[0]
    assert (
        item["published_at"] == "2026-09-05"
        and item["access_scope"] == "metadata"
    )
    assert item["provenance"] == "rss_metadata"
    assert "experimental claim" not in json.dumps(item)


@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1/x",
        "http://169.254.169.254/metadata",
        "file:///private",
        "https://localhost/x",
    ],
)
def test_feed_links_to_unsafe_destinations_are_discarded(url):
    assert sources.parse_rss(rss(url=url), DAY) == []


def test_rss_future_date_is_not_current_evidence_and_rfc2822_is_supported():
    assert sources.parse_rss(rss(published="2026-09-07"), DAY) == []
    assert (
        sources.parse_rss(rss(published="Sat, 05 Sep 2026 16:00:00 GMT"), DAY)[
            0
        ]["published_at"]
        == "2026-09-05"
    )


@pytest.mark.parametrize(
    "raw",
    [
        b'<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///private/credentials">]><rss>&x;</rss>',
        b'<!ENTITY x "anything"><rss/>',
        b"x" * (sources.MAX_FEED_BYTES + 1),
    ],
)
def test_rss_rejects_entities_and_large_bodies_without_following_them(raw):
    with pytest.raises(ValueError, match="Unsafe or oversized RSS"):
        sources.parse_rss(raw, DAY)


@pytest.fixture
def fast_metadata(monkeypatch):
    sleeps = []

    async def sleep(seconds):
        sleeps.append(seconds)

    monkeypatch.setattr(sources.asyncio, "sleep", sleep)
    return sleeps


async def test_metadata_fetch_uses_fixed_serial_bounded_https(
    fast_metadata,
):
    requests = []

    def handler(request):
        requests.append(request)
        assert request.method == "GET"
        assert (
            "authorization" not in request.headers
            and "cookie" not in request.headers
        )
        assert request.headers["accept-encoding"] == "identity"
        if request.url.host == "api.crossref.org":
            assert request.url.params["rows"] == "5"
            assert "until-pub-date:2026-09-06" in request.url.params["filter"]
            return httpx.Response(200, content=crossref(record()))
        return httpx.Response(200, content=rss())

    result = await sources.PublicMetadataFeed(
        transport=httpx.MockTransport(handler)
    ).fetch(DAY)
    assert len(requests) == 3 and fast_metadata == [1.05]
    assert [str(r.url).split("?")[0] for r in requests] == [
        "https://api.crossref.org/journals/0028-0836/works",
        "https://api.crossref.org/journals/0036-8075/works",
        "https://www.nature.com/nature.rss",
    ]
    assert all(c["access_scope"] == "metadata" for c in result.candidates)
    assert result.diagnostics == [
        "crossref_nature:metadata_only",
        "crossref_science:metadata_only",
        "nature_rss:metadata_only",
    ]


@pytest.mark.parametrize("status", [301, 302, 307, 308, 401, 429, 500])
async def test_redirects_rate_limits_and_errors_do_not_retry_or_follow_targets(
    fast_metadata, status
):
    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(
            status,
            headers={"location": "http://169.254.169.254/credentials"},
            content=b"private-error",
        )

    result = await sources.PublicMetadataFeed(
        transport=httpx.MockTransport(handler)
    ).fetch(DAY)
    assert len(requests) == 3 and not result.candidates
    assert all(note.endswith(":unavailable") for note in result.diagnostics)
    assert "private-error" not in repr(result)


async def test_one_feed_failure_degrades_without_discarding_other_sources(
    fast_metadata,
):
    def handler(request):
        if request.url.host == "api.crossref.org":
            raise httpx.ConnectError("private transport body")
        return httpx.Response(200, content=rss())

    result = await sources.PublicMetadataFeed(
        transport=httpx.MockTransport(handler)
    ).fetch(DAY)
    assert (
        len(result.candidates) == 1
        and result.candidates[0]["provenance"] == "rss_metadata"
    )
    assert "private" not in repr(result)


async def test_stream_limits_apply_to_decoded_response(
    fast_metadata, monkeypatch
):
    monkeypatch.setattr(sources, "MAX_FEED_BYTES", 100)

    def handler(request):
        return httpx.Response(200, content=b"x" * 101)

    result = await sources.PublicMetadataFeed(
        transport=httpx.MockTransport(handler)
    ).fetch(DAY)
    assert not result.candidates and all(
        "unavailable" in note for note in result.diagnostics
    )


async def test_timeout_degrades_and_cancellation_is_not_swallowed(
    fast_metadata,
):
    async def timeout(request):
        raise TimeoutError("private")

    assert not (
        await sources.PublicMetadataFeed(
            transport=httpx.MockTransport(timeout)
        ).fetch(DAY)
    ).candidates

    async def cancel(request):
        raise asyncio.CancelledError

    with pytest.raises(asyncio.CancelledError):
        await sources.PublicMetadataFeed(
            transport=httpx.MockTransport(cancel)
        ).fetch(DAY)

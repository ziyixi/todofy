"""Tests of recall_sync.py (recall/docs/design.md §10): the contract's consumer tests (contracts/recall-archive-v1
§5) against its fixtures and a loopback fake of recall's two machine routes, then the HTTP rules, the store driver,
the loop and the configuration. All data is synthetic: the contract's fixtures and pages built from them.

    python3 -m unittest discover -s sync -p 'test_*.py'     (in recall/)

Standard library only. The consumer's rules are also compared with the generated schema's verdict when the reference
validator `jsonschema` is installed; Recall checks installs it and sets RECALL_SYNC_REQUIRE_JSONSCHEMA=1, which turns
its absence into a failure instead of a skip.
"""

import ast
import contextlib
import copy
import datetime as dt
import gzip
import hashlib
import http.server
import io
import json
import os
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.parse
from pathlib import Path

import recall_sync as sync

CONTRACT = Path(__file__).resolve().parents[2] / "contracts" / "recall-archive-v1"
FIXTURES = CONTRACT / "fixtures"
TOKEN = "synthetic-export-token-for-tests"
FEED_ID = "0b6f3c1e-7d2a-4e5b-9c8d-1a2b3c4d5e6f"
OTHER_FEED_ID = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d"
DELETED_PAGE = "3cb732b26093d5571ec48a363db593b2"
OTHER_PAGE = "f9735ed632fb5291d9bc44726777dbd8"
DAY_ONE = dt.datetime(2026, 10, 10, 2, 15, 7, tzinfo=dt.UTC)
DAY_TWO = dt.datetime(2026, 10, 11, 9, 45, 0, tzinfo=dt.UTC)
CHANGES_PATH = "/api/machine/v1/changes"
BLOBS_PATH = "/api/machine/v1/blobs/"


def fixture(*parts: str) -> dict:
    return json.loads(FIXTURES.joinpath(*parts).read_text(encoding="utf-8"))


def files_under(root: Path) -> dict[str, bytes]:
    """Every file under root (dotfiles included: a leftover temporary file would show) by its relative path."""
    return {path.relative_to(root).as_posix(): path.read_bytes() for path in sorted(root.rglob("*")) if path.is_file()}


def blobs_under(root: Path) -> dict[str, bytes]:
    """The blobs of an archive by their Blob.path."""
    return files_under(root / "blobs")


GOLDEN = FIXTURES / "archive"
FIRST_PAGE = fixture("ChangePage", "first-page.json")
GOLDEN_BLOBS = blobs_under(GOLDEN)
STAR = fixture("future", "Change", "star.json")
STAR_BLOBS = blobs_under(FIXTURES / "future")
TOMBSTONE = fixture("Change", "tombstone.json")


def synthetic_text_blob(uuid: str, text: str) -> tuple[dict, bytes]:
    """A text blob for a synthetic document: its Blob and its bytes (gzip with a fixed mtime)."""
    data = gzip.compress(text.encode(), mtime=0)
    blob = {
        "role": "text",
        "path": f"2026/10/{uuid}.txt.gz",
        "media_type": "text/plain; charset=utf-8",
        "content_encoding": "gzip",
        "sha256": hashlib.sha256(data).hexdigest(),
        "size_bytes": len(data),
    }
    return blob, data


def day_two_feed() -> tuple[list[dict], dict[str, bytes]]:
    """The feed after the owner deleted DELETED_PAGE on day two: compacted (its visit and document are gone, its
    tombstone is seq 9), then a new visit of the same page (seq 10, after the deletion: it stays) and a new document
    of the other page with its blob (seq 11)."""
    visit, document, other_visit = (copy.deepcopy(change) for change in FIRST_PAGE["changes"])
    later_visit = {
        **visit,
        "seq": 10,
        "id": "visits/2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d",
        "event_time": "2026-10-11T09:31:00Z",
    }
    later_visit["visit"] = {**visit["visit"], "start_time": "2026-10-11T09:31:00Z", "end_time": "2026-10-11T09:32:00Z"}
    uuid = "6f7e8d9c-0b1a-4c2d-8e3f-4a5b6c7d8e9f"
    text = "用 FTS5 做中文搜索\n\nA synthetic text captured on day two.\n"
    blob, data = synthetic_text_blob(uuid, text)
    new_document = {**document, "seq": 11, "id": f"documents/{uuid}", "page_id": OTHER_PAGE, "blobs": [blob]}
    new_document["document"] = {**document["document"], "visit": other_visit["id"], "text_bytes": len(text.encode())}
    return [other_visit, TOMBSTONE, later_visit, new_document], {blob["path"]: data}


class FakeRecall:
    """A loopback fake of recall's two machine routes (the contract's §1). The feed is `changes` (already compacted)
    up to `head_seq`, served at most `page_size` at a time as recall pages it; a blob is answered from `blobs`, 410 for
    a path in `gone`, else 404. `intercept(route, path)` may answer a request instead: (status, headers, body), or None
    to serve it. Every answer sets a cookie, which a consumer must never send back."""

    def __init__(self, changes=(), *, feed_id=FEED_ID, head_seq=None, blobs=None, page_size=sync.PAGE_LIMIT):
        self.changes = list(changes)
        self.feed_id = feed_id
        self.head_seq = head_seq
        self.blobs = dict(blobs or {})
        self.gone: set[str] = set()
        self.page_size = page_size
        self.intercept = lambda route, path: None
        self.requests: list[tuple[str, dict[str, str]]] = []
        fake = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                fake.requests.append((self.path, dict(self.headers)))
                status, headers, body = fake.answer(self.path, self.headers.get("Authorization"))
                self.send_response(status)
                for name, value in {"Set-Cookie": "session=synthetic", **headers}.items():
                    self.send_header(name, value)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True).start()

    @classmethod
    def serving(cls, page: dict, **options) -> "FakeRecall":
        """A feed whose first page is `page`."""
        return cls(page["changes"], feed_id=page["feed_id"], head_seq=page["head_seq"], **options)

    @property
    def origin(self) -> str:
        return f"http://127.0.0.1:{self.server.server_address[1]}"

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()

    def head(self) -> int:
        if self.head_seq is not None:
            return self.head_seq
        return max((change["seq"] for change in self.changes), default=0)

    def page(self, after: int, limit: int) -> dict:
        size = min(limit, self.page_size)
        above = [change for change in sorted(self.changes, key=lambda change: change["seq"]) if change["seq"] > after]
        served = above[:size]
        last = served[-1]["seq"] if len(served) == size else self.head()
        return {
            "version": sync.VERSION,
            "feed_id": self.feed_id,
            "changes": served,
            "last_seq": last,
            "head_seq": self.head(),
            "oldest_seq": 1,
        }

    def answer(self, target: str, authorization: str | None) -> tuple[int, dict[str, str], bytes]:
        url = urllib.parse.urlsplit(target)
        route = "changes" if url.path == CHANGES_PATH else "blob" if url.path.startswith(BLOBS_PATH) else None
        if authorization != f"Bearer {TOKEN}":
            return 401, {"WWW-Authenticate": "Bearer"}, b'{"error":{"code":401,"status":"UNAUTHENTICATED"}}'
        intercepted = self.intercept(route, url.path)
        if intercepted is not None:
            return intercepted
        if route == "changes":
            query = dict(urllib.parse.parse_qsl(url.query))
            after, limit = int(query.get("after", "0")), int(query.get("limit", "200"))
            if after > self.head():
                return 409, {}, b'{"error":{"code":409,"status":"FAILED_PRECONDITION"}}'
            return (
                200,
                {"Content-Type": "application/json"},
                json.dumps(self.page(after, limit), ensure_ascii=False).encode(),
            )
        path = url.path.removeprefix(BLOBS_PATH)
        if route == "blob" and path in self.blobs:
            return 200, {"Content-Type": "application/octet-stream"}, self.blobs[path]
        return (410, {}, b"") if path in self.gone else (404, {}, b"")

    def paths(self) -> list[str]:
        return [urllib.parse.urlsplit(path).path for path, _ in self.requests]

    def afters(self) -> list[int]:
        return [
            int(dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(path).query))["after"])
            for path, _ in self.requests
            if path.startswith(CHANGES_PATH)
        ]


class Crash(Exception):
    """The process died here."""


class CountingStore(sync.DirStore):
    """The dir driver, counting its writes and deletes per path; with `crash_at`, it dies before that many have run."""

    def __init__(self, root, crash_at: int | None = None):
        super().__init__(root)
        self.writes: list[str] = []
        self.deletes: list[str] = []
        self.crash_at = crash_at

    def _step(self) -> None:
        if self.crash_at == len(self.writes) + len(self.deletes):
            self.crash_at = None
            raise Crash

    def write_atomic(self, path, data):
        self._step()
        super().write_atomic(path, data)
        self.writes.append(path)

    def delete(self, path):
        self._step()
        super().delete(path)
        self.deletes.append(path)


class ArchiveTest(unittest.TestCase):
    """An empty archive root and a fake recall; logs are captured (LoopTest checks that they hold no data)."""

    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.output = self.enterContext(contextlib.redirect_stdout(io.StringIO()))
        self.fake = FakeRecall.serving(FIRST_PAGE, blobs=GOLDEN_BLOBS)
        self.addCleanup(self.fake.close)

    def consumer(self, *, clock=DAY_ONE, store=None, token=TOKEN, batch_bytes=sync.BATCH_BYTES) -> sync.Consumer:
        feed = sync.FeedClient(self.fake.origin, token, "nas")
        return sync.Consumer(store or sync.DirStore(self.root), feed, lambda: clock, batch_bytes)

    def catch_up(self, **options) -> int:
        return self.consumer(**options).sync()

    def assertRefused(self, error_type, code, **options) -> sync.SyncError:
        with self.assertRaises(error_type) as caught:
            self.catch_up(**options)
        self.assertEqual(caught.exception.code, code)
        return caught.exception

    def state(self) -> dict:
        return json.loads((self.root / "state.json").read_text())

    def day_lines(self, day: str) -> list[dict]:
        return [json.loads(line) for line in (self.root / "changes" / day).read_text().splitlines()]

    def assertGolden(self) -> None:
        """The archive is fixtures/archive/: the same files, the same bytes; its state.json names this fake's origin."""
        expected = files_under(GOLDEN)
        expected["state.json"] = expected["state.json"].replace(
            b"https://recall.example.com", self.fake.origin.encode()
        )
        actual = files_under(self.root)
        self.assertEqual(sorted(actual), sorted(expected))
        for path, data in expected.items():
            if path.endswith(".jsonl"):
                self.assertEqual(
                    [json.loads(line) for line in actual[path].splitlines()],
                    [json.loads(line) for line in data.splitlines()],
                    path,
                )
            self.assertEqual(actual[path], data, path)


class ConsumerContractTest(ArchiveTest):
    """The consumer tests of the contract's §5."""

    def test_the_first_page_fills_an_empty_store_as_the_golden_archive(self):
        self.assertEqual(self.fake.page(0, 500), FIRST_PAGE)
        self.assertEqual(self.catch_up(), 5)
        self.assertGolden()
        blob = FIRST_PAGE["changes"][1]["blobs"][0]["path"]
        self.assertEqual(self.fake.paths(), [CHANGES_PATH, BLOBS_PATH + blob])
        path, _ = self.fake.requests[0]
        self.assertEqual(
            urllib.parse.parse_qs(urllib.parse.urlsplit(path).query),
            {"after": ["0"], "limit": ["500"], "consumer": ["nas"]},
        )
        for _, headers in self.fake.requests:
            self.assertEqual(headers["Authorization"], f"Bearer {TOKEN}")
            self.assertNotIn("Cookie", headers)

    def test_applying_the_same_page_again_changes_nothing(self):
        self.catch_up()
        self.catch_up()  # caught up: one request, the same files
        self.assertGolden()
        # A crash before state.json: the next run applies the same page again, the blob kept already.
        (self.root / "state.json").unlink()
        self.fake.requests.clear()
        self.catch_up()
        self.assertGolden()
        self.assertEqual(self.fake.paths(), [CHANGES_PATH])

    def test_a_change_of_a_newer_kind_is_archived_whole_with_its_blob(self):
        self.fake.changes.append(STAR)
        self.fake.head_seq = STAR["seq"]
        self.fake.blobs.update(STAR_BLOBS)
        self.assertEqual(self.catch_up(), 12)
        lines = self.day_lines("2026/10/10.jsonl")
        self.assertEqual(lines[-1], STAR)
        self.assertEqual(blobs_under(self.root), {**GOLDEN_BLOBS, **STAR_BLOBS})

    def test_a_tombstone_purges_its_page_across_day_files(self):
        self.catch_up()
        self.fake.changes, blobs = day_two_feed()
        self.fake.blobs.update(blobs)
        self.fake.head_seq = 11
        self.assertEqual(self.catch_up(clock=DAY_TWO), 11)
        # Day one keeps only the other page's visit; the deleted page's document and its blob are gone.
        self.assertEqual(self.day_lines("2026/10/10.jsonl"), [FIRST_PAGE["changes"][2]])
        self.assertEqual(sorted(blobs_under(self.root)), sorted(blobs))
        # Day two holds the tombstone itself and what came after it, the same page's later visit included.
        day_two = self.day_lines("2026/10/11.jsonl")
        self.assertEqual(
            [(line["seq"], line.get("page_id")) for line in day_two], [(9, None), (10, DELETED_PAGE), (11, OTHER_PAGE)]
        )
        self.assertEqual(self.state()["synced_seq"], 11)

    def test_a_tombstone_of_one_record_removes_only_that_record(self):
        self.catch_up()
        target = FIRST_PAGE["changes"][0]["id"]
        self.fake.changes = [*FIRST_PAGE["changes"][1:], {**TOMBSTONE, "tombstone": {"target": target}}]
        self.fake.head_seq = 9
        self.catch_up()
        self.assertEqual([line["seq"] for line in self.day_lines("2026/10/10.jsonl")], [3, 5, 9])
        self.assertEqual(blobs_under(self.root), GOLDEN_BLOBS)

    def test_every_invalid_change_refuses_its_page_whole(self):
        for path in sorted((FIXTURES / "invalid" / "Change").glob("*.json")):
            with self.subTest(path.name):
                self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))
                self.fake.changes = [json.loads(path.read_text())]
                self.fake.head_seq = 9
                error = self.assertRefused(sync.SyncError, "invalid_page")
                self.assertTrue(error.at.startswith("page.changes[0]"), error.at)
                self.assertEqual(sorted(files_under(self.root)), ["VERSION"])

    def test_a_page_of_another_feed_stops_and_changes_nothing(self):
        self.catch_up()
        before = files_under(self.root)
        self.fake.feed_id = OTHER_FEED_ID
        self.fake.changes.append(TOMBSTONE)
        self.fake.head_seq = 9
        self.assertRefused(sync.Stopped, "feed_changed")
        self.assertEqual(files_under(self.root), before)

    def test_a_410_blob_is_skipped_and_a_404_blob_stops_the_run(self):
        path = FIRST_PAGE["changes"][1]["blobs"][0]["path"]
        del self.fake.blobs[path]
        self.assertRefused(sync.SyncError, "blob_http_404")
        self.assertFalse((self.root / "state.json").exists())
        # Lines go in before their blobs: the day file is there, and the next run repeats the page.
        self.assertEqual(len(self.day_lines("2026/10/10.jsonl")), 3)
        self.fake.gone.add(path)
        self.assertEqual(self.catch_up(), 5)
        self.assertEqual(blobs_under(self.root), {})
        self.assertIn('"blobs_gone": 1', self.output.getvalue())

    def test_a_digest_or_size_mismatch_stops_the_run_and_keeps_no_byte(self):
        path = FIRST_PAGE["changes"][1]["blobs"][0]["path"]
        stored = GOLDEN_BLOBS[path]
        for served in (bytes([stored[0] ^ 1]) + stored[1:], stored + b"\0", stored[:-1], b""):
            with self.subTest(size=len(served)):
                self.fake.blobs[path] = served
                self.assertRefused(sync.SyncError, "blob_digest_mismatch")
                self.assertEqual(blobs_under(self.root), {})
                self.assertFalse((self.root / "state.json").exists())

    def test_a_blob_larger_than_any_recall_writes_stops_the_run_unread(self):
        document = copy.deepcopy(FIRST_PAGE["changes"][1])
        document["blobs"][0]["size_bytes"] = sync.BLOB_MAX_BYTES + 1
        self.fake.changes[1] = document
        self.assertRefused(sync.SyncError, "blob_too_large")
        self.assertNotIn(BLOBS_PATH + document["blobs"][0]["path"], self.fake.paths())

    def test_a_crash_between_every_two_steps_ends_in_the_same_archive(self):
        day_two, day_two_blobs = day_two_feed()

        def both_days(root: Path, crash_at: int | None) -> CountingStore:
            store = CountingStore(root, crash_at)
            self.fake.changes, self.fake.head_seq = list(FIRST_PAGE["changes"]), 5
            self.fake.blobs = {**GOLDEN_BLOBS, **day_two_blobs}
            for clock, changes in ((DAY_ONE, None), (DAY_TWO, day_two)):
                if changes is not None:
                    self.fake.changes, self.fake.head_seq = changes, 11
                try:
                    self.catch_up(clock=clock, store=store)
                except Crash:
                    self.catch_up(clock=clock, store=sync.DirStore(root))
            return store

        reference = Path(self.enterContext(tempfile.TemporaryDirectory()))
        steps = both_days(reference, None)
        expected = files_under(reference)
        self.assertEqual(len(steps.writes) + len(steps.deletes), 9)
        for crash_at in range(9):
            with self.subTest(crash_at=crash_at):
                root = Path(self.enterContext(tempfile.TemporaryDirectory()))
                self.assertIsNone(both_days(root, crash_at).crash_at)  # it did crash
                self.assertEqual(files_under(root), expected)


class BatchTest(ArchiveTest):
    def setUp(self):
        super().setUp()
        self.fake.page_size = 1

    def test_a_catch_up_rewrites_the_day_file_once_per_batch(self):
        store = CountingStore(self.root)
        self.assertEqual(self.catch_up(store=store), 5)
        self.assertEqual(self.fake.afters(), [0, 2, 3])
        self.assertEqual(store.writes.count("changes/2026/10/10.jsonl"), 1)
        self.assertEqual(store.writes[-1], "state.json")
        self.assertGolden()

    def test_full_batches_are_applied_one_after_the_other(self):
        store = CountingStore(self.root)
        self.catch_up(store=store, batch_bytes=1)
        self.assertEqual(store.writes.count("changes/2026/10/10.jsonl"), 3)
        self.assertEqual(store.writes.count("state.json"), 3)
        self.assertGolden()

    def test_a_page_that_fails_after_others_applies_them_first(self):
        def third_page(route, path):
            return (503, {"Retry-After": "30"}, b"") if route == "changes" and len(self.fake.afters()) == 3 else None

        self.fake.intercept = third_page
        error = self.assertRefused(sync.SyncError, "changes_http_503")
        self.assertEqual(error.retry_after, 30)
        self.assertEqual(self.state()["synced_seq"], 3)
        self.assertEqual([line["seq"] for line in self.day_lines("2026/10/10.jsonl")], [2, 3])


class HttpRulesTest(ArchiveTest):
    def answer(self, route: str, status: int, headers: dict | None = None) -> None:
        self.fake.intercept = lambda asked, path: (status, headers or {}, b"") if asked == route else None

    def test_a_redirect_is_refused_and_never_followed(self):
        for route in ("changes", "blob"):
            with self.subTest(route=route):
                self.fake.requests.clear()
                self.answer(route, 302, {"Location": f"{self.fake.origin}/elsewhere"})
                self.assertRefused(sync.SyncError, "redirect_refused")
                self.assertNotIn("/elsewhere", self.fake.paths())
                self.assertFalse((self.root / "state.json").exists())

    def test_a_wrong_token_is_refused_until_it_changes(self):
        self.assertRefused(sync.TokenRefused, "export_token_refused", token="another-synthetic-token")
        self.assertEqual(self.catch_up(), 5)

    def test_the_cursor_answers_stop_the_archive(self):
        self.catch_up()
        self.fake.head_seq = 3  # recall's store went back to an earlier point
        self.assertRefused(sync.Stopped, "cursor_ahead")
        for status, code in ((410, "cursor_expired"), (400, "bad_request")):
            with self.subTest(status=status):
                self.answer("changes", status)
                self.assertRefused(sync.Stopped, code)

    def test_retry_after_is_honored_on_429_and_503(self):
        for status, header, expected in (
            (429, {"Retry-After": "120"}, 120),
            (503, {}, None),
            (503, {"Retry-After": "soon"}, None),
        ):
            with self.subTest(status=status, header=header):
                self.answer("changes", status, header)
                error = self.assertRefused(sync.SyncError, f"changes_http_{status}")
                self.assertEqual(error.retry_after, expected)
        self.answer("blob", 503, {"Retry-After": "7"})
        self.assertEqual(self.assertRefused(sync.SyncError, "blob_http_503").retry_after, 7)

    def test_other_answers_end_the_run(self):
        self.answer("changes", 500)
        self.assertRefused(sync.SyncError, "changes_http_500")
        self.answer("blob", 500)  # blob_missing: a live record whose object is gone
        self.assertRefused(sync.SyncError, "blob_http_500")

    def test_a_page_that_is_not_json_is_refused(self):
        for body in (b"<html>", b'{"version": NaN}', b"\xff"):
            with self.subTest(body=body):
                self.fake.intercept = lambda route, path, body=body: (200, {}, body)
                self.assertEqual(self.assertRefused(sync.SyncError, "invalid_page").at, "page")

    def test_a_network_failure_ends_the_run(self):
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        feed = sync.FeedClient(f"http://127.0.0.1:{port}", TOKEN, "nas")
        with self.assertRaises(sync.SyncError) as caught:
            feed.changes(0)
        self.assertEqual(caught.exception.code, "network")


class PageRulesTest(unittest.TestCase):
    """The contract's step 2 beyond the schema: where the next page starts, and the feed."""

    def page(self, seqs=(2, 3, 5), last=5, head=5, feed_id=FEED_ID) -> dict:
        changes = [{**FIRST_PAGE["changes"][0], "seq": seq} for seq in seqs]
        return {**FIRST_PAGE, "changes": changes, "last_seq": last, "head_seq": head, "feed_id": feed_id}

    def test_a_consistent_page_passes(self):
        sync.check_page(self.page(), 0, None)
        sync.check_page(self.page(), 1, FEED_ID)
        sync.check_page(self.page(seqs=(), last=5), 5, FEED_ID)
        sync.check_page(self.page(seqs=(6,), last=6, head=9), 5, FEED_ID)

    def test_an_inconsistent_page_is_refused(self):
        cases = {
            "a change not above after": (self.page(), 2, "page.changes"),
            "changes out of order": (self.page(seqs=(3, 2, 5)), 0, "page.changes"),
            "a change beyond last_seq": (self.page(last=3, head=5), 0, "page.changes"),
            "last_seq below after": (self.page(seqs=(), last=4), 5, "page.last_seq"),
            "last_seq above head_seq": (self.page(last=6), 0, "page.last_seq"),
            "no progress below head_seq": (self.page(seqs=(), last=5, head=9), 5, "page.last_seq"),
        }
        for name, (page, after, at) in cases.items():
            with self.subTest(name), self.assertRaises(sync.SyncError) as caught:
                sync.check_page(page, after, FEED_ID)
            self.assertEqual((caught.exception.code, caught.exception.at), ("invalid_page", at))

    def test_a_page_of_another_feed_is_refused(self):
        with self.assertRaises(sync.Stopped) as caught:
            sync.check_page(self.page(feed_id=OTHER_FEED_ID), 0, FEED_ID)
        self.assertEqual(caught.exception.code, "feed_changed")


def accepted(rule, value) -> bool:
    try:
        rule(value, "value")
    except sync.Invalid:
        return False
    return True


RULES = {"ChangePage": sync.CHANGE_PAGE, "Change": sync.check_change, "ArchiveState": sync.ARCHIVE_STATE}


class FixturesTest(unittest.TestCase):
    """The contract's fixtures get the codec's verdict (proto/test/recall-archive.test.ts) from the consumer too."""

    def test_every_valid_fixture_passes(self):
        for name, rule in RULES.items():
            for path in sorted((FIXTURES / name).glob("*.json")):
                with self.subTest(f"{name}/{path.name}"):
                    self.assertTrue(accepted(rule, json.loads(path.read_text())))
        self.assertTrue(accepted(sync.check_change, STAR))
        self.assertTrue(accepted(sync.ARCHIVE_STATE, fixture("archive", "state.json")))

    def test_every_invalid_fixture_is_refused(self):
        refused = 0
        for name, rule in RULES.items():
            for path in sorted((FIXTURES / "invalid" / name).glob("*.json")):
                with self.subTest(f"{name}/{path.name}"):
                    self.assertFalse(accepted(rule, json.loads(path.read_text())))
                    refused += 1
        self.assertEqual(refused, 12)

    def test_members_and_kinds_it_does_not_know_pass_on_their_envelope(self):
        visit = copy.deepcopy(FIRST_PAGE["changes"][0])
        visit["visit"]["seen_in"] = "reader view"
        self.assertTrue(accepted(sync.check_change, {**visit, "starred": True}))
        self.assertTrue(accepted(sync.check_change, {**STAR, "kind": "highlight", "highlight": [1, 2]}))
        self.assertFalse(accepted(sync.check_change, {**STAR, "id": "stars/not-a-uuid"}))
        self.assertFalse(
            accepted(sync.check_change, {**STAR, "blobs": [{**STAR["blobs"][0], "path": "../star.html.gz"}]})
        )
        # A body of a known kind is checked wherever it is carried.
        self.assertFalse(accepted(sync.check_change, {**STAR, "visit": {"url": "javascript:alert(1)"}}))


# Values one edit away from a valid one (variants): wrong types and values at every node, plus the bounds of the
# formats' lengths and patterns.
WRONG = (
    None,
    True,
    0,
    -1,
    2.0,
    1.5,
    21601,
    65537,
    "",
    "x",
    "x" * 65,
    "x" * 1001,
    "https://example.com/" + "a" * 8200,
    "2026/10/../etc.txt.gz",
    [],
    {},
)
EXTRA_BLOB = FIRST_PAGE["changes"][1]["blobs"][0]


def variants(value):
    """Every value one edit away: each member removed, each node replaced by a wrong value, each string upper-cased or
    given a trailing newline, each list emptied, extended or repeated past its bound."""
    yield from WRONG
    if isinstance(value, str):
        yield value.upper()
        yield value + "\n"
    elif isinstance(value, dict):
        for key in value:
            yield {name: member for name, member in value.items() if name != key}
            for variant in variants(value[key]):
                yield {**value, key: variant}
    elif isinstance(value, list):
        yield []
        yield [*value, EXTRA_BLOB]
        if value:
            yield [*value, value[0]]
            yield value * 201
        for index, item in enumerate(value):
            for variant in variants(item):
                yield [*value[:index], variant, *value[index + 1 :]]


class GeneratedSchemaTest(unittest.TestCase):
    """The consumer's rules give the generated schema's verdict (recall-archive-v1.schema.json, Draft 2020-12, with
    the reference validator) on every fixture and on every value one edit away from the valid ones."""

    @classmethod
    def setUpClass(cls):
        try:
            import jsonschema
        except ModuleNotFoundError:
            if os.environ.get("RECALL_SYNC_REQUIRE_JSONSCHEMA") == "1":
                raise
            raise unittest.SkipTest("jsonschema is not installed (Recall checks installs it)") from None
        defs = json.loads((CONTRACT / "recall-archive-v1.schema.json").read_text())["$defs"]
        cls.schemas = {
            name: jsonschema.Draft202012Validator({"$defs": defs, "$ref": f"#/$defs/{name}"}) for name in RULES
        }

    def assertSameVerdict(self, name: str, value, label: str) -> None:
        expected = self.schemas[name].is_valid(value)
        if accepted(RULES[name], value) != expected:
            self.fail(
                f"{name} {label}: the schema says {'valid' if expected else 'invalid'}: {json.dumps(value)[:300]}"
            )

    def test_every_fixture(self):
        for name in RULES:
            for path in sorted([*(FIXTURES / name).glob("*.json"), *(FIXTURES / "invalid" / name).glob("*.json")]):
                self.assertSameVerdict(name, json.loads(path.read_text()), path.name)
        self.assertSameVerdict("Change", STAR, "future star")

    def test_sites_with_an_underscore_and_without_a_trailing_dot(self):
        visit = FIRST_PAGE["changes"][0]
        sites = {"my_team.example.com": True, "_x.example.com": True, "example.com.": False, "a!b.example.com": False}
        for site, valid in sites.items():
            change = {**visit, "visit": {**visit["visit"], "site": site}}
            self.assertEqual(accepted(RULES["Change"], change), valid, site)
            self.assertSameVerdict("Change", change, site)

    def test_every_value_one_edit_away(self):
        samples = {
            "Change": [*FIRST_PAGE["changes"], TOMBSTONE, STAR],
            "ChangePage": [{**FIRST_PAGE, "changes": FIRST_PAGE["changes"][:2]}],
            "ArchiveState": [fixture("ArchiveState", "synced.json")],
        }
        count = 0
        for name, values in samples.items():
            for value in values:
                for variant in variants(value):
                    self.assertSameVerdict(name, variant, "variant")
                    count += 1
        self.assertGreater(count, 2000)


class DirStoreTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.store = sync.DirStore(self.root)

    def test_the_five_operations(self):
        self.assertIsNone(self.store.read("changes/2026/10/10.jsonl"))
        self.store.write_atomic("changes/2026/10/10.jsonl", b"one\n")
        self.store.write_atomic("changes/2026/10/10.jsonl", b"two\n")
        self.assertEqual(self.store.read("changes/2026/10/10.jsonl"), b"two\n")
        mode = stat.S_IMODE((self.root / "changes/2026/10/10.jsonl").stat().st_mode)
        self.assertEqual(mode, sync.FILE_MODE)
        digest = hashlib.sha256(b"two\n").hexdigest()
        self.assertTrue(self.store.exists("changes/2026/10/10.jsonl", 4, digest))
        self.assertFalse(self.store.exists("changes/2026/10/10.jsonl", 5, digest))
        self.assertFalse(self.store.exists("changes/2026/10/10.jsonl", 4, "0" * 64))
        self.assertFalse(self.store.exists("changes/2026/10/11.jsonl", 4, digest))
        (self.root / "changes/2026/10/.left-by-a-crash.tmp").write_bytes(b"")
        self.store.write_atomic("changes/2026/09/30.jsonl", b"")
        self.assertEqual(self.store.list("changes/"), ["changes/2026/09/30.jsonl", "changes/2026/10/10.jsonl"])
        self.assertEqual(self.store.list("blobs/"), [])
        self.store.delete("changes/2026/10/10.jsonl")
        self.store.delete("changes/2026/10/10.jsonl")
        self.assertEqual(self.store.list("changes/"), ["changes/2026/09/30.jsonl"])

    def test_paths_outside_the_archive_are_refused(self):
        for path in ("../outside", "blobs/../../outside", "/etc/passwd", "a//b", "a/./b", "a\\b", "", "a/"):
            with self.subTest(path=path), self.assertRaises(ValueError):
                self.store.write_atomic(path, b"")
        self.assertEqual(list(self.root.iterdir()), [])

    def test_the_archive_root_is_never_created(self):
        missing = sync.DirStore(self.root / "not-mounted")
        with self.assertRaises(sync.SyncError) as caught:
            missing.write_atomic("VERSION", b"recall-archive-v1\n")
        self.assertEqual(caught.exception.code, "archive_root_missing")
        self.assertFalse((self.root / "not-mounted").exists())

    def test_a_failed_write_leaves_the_old_file_and_no_temporary_one(self):
        self.store.write_atomic("state.json", b"old")
        with self.assertRaises(TypeError):
            self.store.write_atomic("state.json", "not bytes")
        self.assertEqual(files_under(self.root), {"state.json": b"old"})


class ArchiveFilesTest(ArchiveTest):
    """Step 1: what the consumer finds in its archive root."""

    def test_an_archive_it_does_not_understand_stops_it(self):
        cases = {
            "archive_version": {"VERSION": b"recall-archive-v2\n"},
            "archive_invalid": {"state.json": (GOLDEN / "state.json").read_bytes()},
            "archive_state_invalid": {
                "VERSION": b"recall-archive-v1\n",
                "state.json": b'{"version": "recall-archive-v1"}',
            },
            "archive_corrupt": {"VERSION": b"recall-archive-v1\n", "changes/2026/10/10.jsonl": b'{"seq": 1}\n'},
        }
        for code, files in cases.items():
            with self.subTest(code):
                self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))
                for path, data in files.items():
                    (self.root / path).parent.mkdir(parents=True, exist_ok=True)
                    (self.root / path).write_bytes(data)
                self.assertRefused(sync.Stopped, code)

    def test_a_foreign_file_among_the_day_files_is_left_alone(self):
        self.catch_up()
        (self.root / "changes/2026/10/notes.txt").write_text("the owner's own notes")
        self.fake.changes = [*FIRST_PAGE["changes"], TOMBSTONE]
        self.fake.head_seq = 9
        self.catch_up()
        self.assertEqual((self.root / "changes/2026/10/notes.txt").read_text(), "the owner's own notes")


class Sleeps:
    """time.sleep for serve(): records each delay, calls `between` after it, and ends the loop after `count`."""

    class End(Exception):
        pass

    def __init__(self, count: int, between=lambda number: None):
        self.delays: list[float] = []
        self.count = count
        self.between = between

    def __call__(self, delay: float) -> None:
        self.delays.append(delay)
        self.between(len(self.delays))
        if len(self.delays) >= self.count:
            raise Sleeps.End


class LoopTest(ArchiveTest):
    def environ(self, **values: str) -> dict[str, str]:
        return {
            "RECALL_BASE_URL": self.fake.origin,
            "RECALL_ARCHIVE_DIR": str(self.root),
            "RECALL_EXPORT_TOKEN": TOKEN,
            **values,
        }

    def serve(self, sleeps: Sleeps, **values: str) -> None:
        config = sync.load_config(self.environ(**values))
        with self.assertRaises(Sleeps.End):
            sync.serve(config, lambda: DAY_ONE, sleeps)

    def events(self) -> list[dict]:
        return [json.loads(line) for line in self.output.getvalue().splitlines()]

    def test_it_pulls_every_interval(self):
        sleeps = Sleeps(2)
        self.serve(sleeps, RECALL_INTERVAL_SECONDS="600")
        self.assertEqual(sleeps.delays, [600, 600])
        self.assertEqual(self.fake.afters(), [0, 5])

    def test_a_stop_ends_the_pulling_for_good_and_says_so_once_an_hour(self):
        self.catch_up()
        self.fake.feed_id = OTHER_FEED_ID
        self.fake.requests.clear()
        sleeps = Sleeps(3)
        self.serve(sleeps)
        self.assertEqual(sleeps.delays, [3600, 3600, 3600])
        self.assertEqual(len(self.fake.requests), 1)
        self.assertEqual(
            [event["code"] for event in self.events() if event["event"] == "stopped"], ["feed_changed"] * 3
        )

    def test_a_refused_token_is_asked_again_once_an_hour_and_read_again(self):
        token_file = Path(self.enterContext(tempfile.TemporaryDirectory())) / "token"
        token_file.write_text("an-old-synthetic-token\n")

        def renew(number: int) -> None:
            if number == 1:
                token_file.write_text(f"{TOKEN}\n")

        sleeps = Sleeps(2, renew)
        environ = self.environ(RECALL_EXPORT_TOKEN_FILE=str(token_file))
        del environ["RECALL_EXPORT_TOKEN"]
        with self.assertRaises(Sleeps.End):
            sync.serve(sync.load_config(environ), lambda: DAY_ONE, sleeps)
        self.assertEqual(sleeps.delays, [3600, 900])
        self.assertEqual(self.state()["synced_seq"], 5)

    def test_retry_after_sets_the_next_pull(self):
        self.fake.intercept = lambda route, path: (
            (503, {"Retry-After": "120"}, b"") if len(self.fake.requests) == 1 else None
        )
        sleeps = Sleeps(2)
        self.serve(sleeps)
        self.assertEqual(sleeps.delays, [120, 900])

    def test_a_store_failure_is_logged_by_its_errno_only(self):
        (self.root / "VERSION").write_text("a file where the archive root should be")
        sleeps = Sleeps(1)
        self.serve(sleeps, RECALL_ARCHIVE_DIR=str(self.root / "VERSION" / "inside-a-file"))
        self.assertEqual(sleeps.delays, [900])
        self.assertEqual(self.events()[-1], {"event": "error", "code": "store_error", "errno": "ENOTDIR"})

    def test_the_logs_hold_codes_and_counts_only(self):
        self.serve(Sleeps(1))
        self.fake.intercept = lambda route, path: (302, {"Location": "https://elsewhere.example.net/"}, b"")
        self.serve(Sleeps(1))
        output = self.output.getvalue()
        for secret in (TOKEN, "example", "Durable", "durable", "/api/machine", FEED_ID, str(self.root)):
            self.assertNotIn(secret, output)
        self.assertEqual(
            self.events()[0], {"event": "synced", "synced_seq": 5, "caught_up": True, "changes": 3, "blobs_fetched": 1}
        )

    def test_sigterm_ends_the_loop_at_once(self):
        environ = {"PATH": os.environ.get("PATH", ""), **self.environ(RECALL_INTERVAL_SECONDS="3600")}
        process = subprocess.Popen(
            [sys.executable, "-I", "-B", sync.__file__], env=environ, stdout=subprocess.PIPE, text=True
        )
        self.addCleanup(process.kill)
        self.assertEqual(json.loads(process.stdout.readline())["event"], "synced")  # now asleep for an hour
        process.send_signal(signal.SIGTERM)
        self.assertEqual(process.wait(timeout=10), 0)
        process.stdout.close()

    def test_once_and_check(self):
        self.assertEqual(sync.main(["--check"], self.environ(), lambda: DAY_ONE), 1)  # no state.json yet
        self.assertEqual(sync.main(["--once"], self.environ(), lambda: DAY_ONE), 0)
        later = DAY_ONE + dt.timedelta(seconds=3 * 900 - 1)
        self.assertEqual(sync.main(["--check"], {"RECALL_ARCHIVE_DIR": str(self.root)}, lambda: later), 0)
        stale = DAY_ONE + dt.timedelta(seconds=3 * 900)
        self.assertEqual(sync.main(["--check"], {"RECALL_ARCHIVE_DIR": str(self.root)}, lambda: stale), 1)
        self.fake.intercept = lambda route, path: (500, {}, b"")
        self.assertEqual(sync.main(["--once"], self.environ(), lambda: DAY_ONE), 1)
        state = json.loads((GOLDEN / "state.json").read_text())
        (self.root / "state.json").write_text(json.dumps({**state, "update_time": "2026-10-10T02:15:07"}))  # no zone
        self.assertEqual(sync.main(["--check"], {"RECALL_ARCHIVE_DIR": str(self.root)}, lambda: DAY_ONE), 1)
        self.assertEqual(sync.main(["--once"], {"RECALL_ARCHIVE_DIR": str(self.root)}), 2)  # no token


class ConfigTest(unittest.TestCase):
    def test_the_defaults(self):
        config = sync.load_config({"RECALL_EXPORT_TOKEN": TOKEN})
        self.assertEqual(
            (config.origin, config.archive_dir, config.consumer, config.interval, config.token()),
            ("https://recall.ziyixi.science", "/archive", "nas", 900, TOKEN),
        )

    def test_https_only_but_to_the_loopback(self):
        for url, origin in (
            ("https://Recall.Example.com/", "https://recall.example.com"),
            ("https://recall.example.com:8443", "https://recall.example.com:8443"),
            ("http://127.0.0.1:8787", "http://127.0.0.1:8787"),
            ("http://localhost", "http://localhost"),
        ):
            self.assertEqual(sync.origin_of(url), origin)
        for url in (
            "http://recall.example.com",
            "https://recall.example.com/api",
            "https://user:pass@recall.example.com",
            "https://recall.example.com?x=1",
            "https://recall.example.com:99999",
            "ftp://recall.example.com",
            "recall.example.com",
        ):
            with self.subTest(url=url), self.assertRaises(sync.ConfigError):
                sync.origin_of(url)

    def test_values_that_break_their_rule(self):
        cases = {
            "consumer_invalid": {"RECALL_CONSUMER": "NAS"},
            "interval_invalid": {"RECALL_INTERVAL_SECONDS": "59"},
            "export_token_missing": {"RECALL_EXPORT_TOKEN": None},
            "export_token_ambiguous": {"RECALL_EXPORT_TOKEN_FILE": "/run/secrets/recall"},
            "export_token_invalid": {"RECALL_EXPORT_TOKEN": '"quoted"'},
            "base_url_invalid": {"RECALL_BASE_URL": "http://recall.example.com"},
        }
        for code, values in cases.items():
            environ = {
                key: value for key, value in {"RECALL_EXPORT_TOKEN": TOKEN, **values}.items() if value is not None
            }
            with self.subTest(code), self.assertRaises(sync.ConfigError) as caught:
                sync.load_config(environ)
            self.assertEqual(caught.exception.code, code)
        for interval in ("abc", "86401", "\uff19\uff10\uff10"):  # the last: 900 in full-width digits
            with self.assertRaises(sync.ConfigError):
                sync.load_config({"RECALL_EXPORT_TOKEN": TOKEN, "RECALL_INTERVAL_SECONDS": interval})
        self.assertEqual(sync.load_config({}, need_token=False).consumer, "nas")

    def test_a_token_file_is_read_for_every_run(self):
        with tempfile.NamedTemporaryFile("w", suffix=".token") as file:
            config = sync.load_config({"RECALL_EXPORT_TOKEN_FILE": file.name})
            for content, expected in ((f"{TOKEN}\n", TOKEN), ("another-synthetic-token", "another-synthetic-token")):
                Path(file.name).write_text(content)
                self.assertEqual(config.token(), expected)
            Path(file.name).write_text("with a space")
            with self.assertRaises(sync.SyncError):
                config.token()
        with self.assertRaises(sync.SyncError) as caught:
            config.token()
        self.assertEqual(caught.exception.code, "export_token_unreadable")


class StandardLibraryTest(unittest.TestCase):
    def test_the_consumer_imports_only_the_standard_library(self):
        tree = ast.parse(Path(sync.__file__).read_text())
        modules = {alias.name for node in ast.walk(tree) if isinstance(node, ast.Import) for alias in node.names}
        modules |= {node.module for node in ast.walk(tree) if isinstance(node, ast.ImportFrom) and node.module}
        self.assertTrue(modules)
        self.assertLessEqual({module.split(".")[0] for module in modules}, set(sys.stdlib_module_names))


if __name__ == "__main__":
    unittest.main()

#!/usr/bin/env python3
"""recall's reference archive consumer: pulls recall's change feed into plain files.

It is §4 of contracts/recall-archive-v1/README.md, step by step (recall/docs/design.md §7.2): read VERSION and
state.json; GET a page of changes and refuse it whole if anything is wrong; merge its changes into today's (UTC) day
file, changes/YYYY/MM/DD.jsonl, rewritten atomically; fetch every blob, checking its size and SHA-256 (410 lets it go
on without the blob, anything else stops the run); apply the page's tombstones to every day file; write state.json
last. The lines go in before their blobs, so a crash anywhere leaves state.json at the last fully applied page and the
next run repeats the rest. A long catch-up applies its pages in batches of up to BATCH_BYTES of new lines (state.json
then vouches for a whole batch), so a fresh archive of a long history does not rewrite its day file once per page.

One file, Python's standard library only (3.12+), so it runs unchanged for decades. The archive lives behind a store
driver of five operations (Store); this file ships `dir`, a mounted directory. Configuration, from the environment:

  RECALL_BASE_URL          recall's origin (https://recall.ziyixi.science); plain http only to 127.0.0.1 or localhost
  RECALL_EXPORT_TOKEN      the export token (mint-tokens.mjs writes it into recall-sync.env), or
  RECALL_EXPORT_TOKEN_FILE a file holding only the token, read again for every run
  RECALL_ARCHIVE_DIR       the archive root, a directory that must exist (/archive)
  RECALL_CONSUMER          this archive's name in recall's 设置 (nas)
  RECALL_INTERVAL_SECONDS  the pause between two catch-ups (900)

Run without arguments it pulls every interval until stopped; --once catches up once (exit 0 when caught up, 1 when
the run stopped early); --check is the container's health check (exit 0 when state.json was written within three
intervals). A 401 is retried once an hour; a page of another feed (feed_changed), 409 cursor_ahead and 410
cursor_expired stop the pulling for good: the operator starts a new archive root (the contract's §5). Logs are JSON
lines on stdout with codes, counts and seqs only, never a URL, a title, a text or the token.
"""

import argparse
import collections
import contextlib
import dataclasses
import datetime as dt
import errno
import hashlib
import http.client
import itertools
import json
import os
import re
import signal
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Mapping
from typing import NamedTuple, Protocol

VERSION = "recall-archive-v1"
# The feed's largest page (the contract's `limit` and ChangePage's maxItems).
PAGE_LIMIT = 500
# A page of 500 changes is a few MiB; anything far larger is refused unread.
PAGE_MAX_BYTES = 64 * 1024 * 1024
# recall's texts are at most 64 KiB before gzip, and no blob a newer recall plans comes near this; a larger one ends the
# run instead of being read into memory.
BLOB_MAX_BYTES = 256 * 1024 * 1024
# A batch of pages is applied with one rewrite of the day file once its new lines reach this size (or the feed is
# caught up). One page per batch in the steady state; during a catch-up from after=0 it bounds both the memory held and
# the number of times the (growing) day file is rewritten.
BATCH_BYTES = 64 * 1024 * 1024
REQUEST_TIMEOUT = 30
HOUR = 3600
USER_AGENT = "recall-sync/1 (recall-archive-v1)"
# Written files are readable by the share's other users (the owner reading the archive over SMB); the share's own
# permissions keep everyone else out.
FILE_MODE = 0o644
LOOPBACK_HOSTS = ("127.0.0.1", "localhost")
TOKEN = re.compile(r"[!-~]{1,256}")
DAY_FILE = re.compile(r"changes/[0-9]{4}/(0[1-9]|1[0-2])/(0[1-9]|[12][0-9]|3[01])\.jsonl")
PAGE_TARGET = re.compile(r"pages/([0-9a-f]{32})")


def utc_now() -> dt.datetime:
    return dt.datetime.now(dt.UTC)


def log(event: str, **fields: object) -> None:
    """One JSON line on stdout: codes, counts and seqs only."""
    print(json.dumps({"event": event, **fields}), flush=True)


class SyncError(Exception):
    """A run that ended early: nothing after the last state.json counts, and the next run starts again from it."""

    def __init__(self, code: str, *, retry_after: int | None = None, at: str | None = None):
        super().__init__(code)
        self.code = code
        self.retry_after = retry_after
        self.at = at

    def fields(self) -> dict[str, object]:
        """What the log says: the code, and where in a page a rule broke (a path of field names, never a value)."""
        return {
            "code": self.code,
            **({"at": self.at} if self.at else {}),
            **({"retry_after": self.retry_after} if self.retry_after else {}),
        }


class TokenRefused(SyncError):
    """401: recall does not take the export token; asked again once an hour, with the token read again."""


class Stopped(SyncError):
    """This archive cannot follow the feed (another feed, a cursor recall refuses, an archive it does not understand):
    nothing more is pulled into it, and the operator points the consumer at a new archive root (the contract's §5)."""


class ConfigError(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


# The schema: recall-archive-v1.schema.json, generated from proto/recall/archive/v1/archive.proto, as rules a
# consumer checks before it applies a page. Every object is open (a member it does not know is kept unread), and a
# change of a kind it does not know is checked on its envelope (the contract's §2 and §6). test_recall_sync.py gives
# every fixture and thousands of variations of them the generated schema's verdict.


class Invalid(Exception):
    """A value breaks a rule; the message is the path of the field (never its value)."""


Rule = Callable[[object, str], None]
REQUIRED, OPTIONAL = True, False


def string(pattern: str = r"[\s\S]*", max_length: int | None = None) -> Rule:
    compiled = re.compile(pattern)

    def rule(value: object, path: str) -> None:
        if (
            not isinstance(value, str)
            or (max_length is not None and len(value) > max_length)
            or not compiled.fullmatch(value)
        ):
            raise Invalid(path)

    return rule


def integer(minimum: int, maximum: int | None = None) -> Rule:
    def rule(value: object, path: str) -> None:
        # JSON Schema's integer: any number without a fraction (2.0 included), never a boolean.
        whole = (isinstance(value, int) and not isinstance(value, bool)) or (
            isinstance(value, float) and value.is_integer()
        )
        if not whole or value < minimum or (maximum is not None and value > maximum):
            raise Invalid(path)

    return rule


def boolean(value: object, path: str) -> None:
    if not isinstance(value, bool):
        raise Invalid(path)


def constant(expected: str) -> Rule:
    def rule(value: object, path: str) -> None:
        if not (isinstance(value, str) and value == expected):
            raise Invalid(path)

    return rule


def array(item: Rule, max_items: int) -> Rule:
    def rule(value: object, path: str) -> None:
        if not isinstance(value, list) or len(value) > max_items:
            raise Invalid(path)
        for index, element in enumerate(value):
            item(element, f"{path}[{index}]")

    return rule


def message(fields: Mapping[str, tuple[bool, Rule]]) -> Rule:
    def rule(value: object, path: str) -> None:
        if not isinstance(value, dict):
            raise Invalid(path)
        for name, (required, field_rule) in fields.items():
            if name in value:
                field_rule(value[name], f"{path}.{name}")
            elif required:
                raise Invalid(f"{path}.{name}")

    return rule


UUID_PATTERN = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
CONSUMER_PATTERN = r"[a-z][a-z0-9-]{0,31}"
ORIGIN_PATTERN = r"https?://[a-z0-9.-]+(:[0-9]{1,5})?"
RECORD_ID = string(rf"[a-z][a-z0-9]{{0,31}}/{UUID_PATTERN}")
PAGE_ID = string(r"[0-9a-f]{32}")
TOMBSTONE_TARGET = string(rf"pages/[0-9a-f]{{32}}|[a-z][a-z0-9]{{0,31}}/{UUID_PATTERN}")
UUID = string(UUID_PATTERN)
URL = string(r"https?://[!-~]+", 8192)
SITE = string(r"[a-z0-9_]([a-z0-9._-]{0,251}[a-z0-9_])?|\[[0-9a-f:.]{2,45}\]")
TEXT = string(r"[\s\S]*", 1000)
LABEL = string(r"[\s\S]+", 64)
ROLE = string(r"[a-z][a-z0-9_]{0,31}")
BLOB_PATH = string(rf"[0-9]{{4}}/(0[1-9]|1[0-2])/{UUID_PATTERN}([.][a-z0-9]{{1,16}}){{1,3}}")
MEDIA_TYPE = string(r"[a-z]+/[a-z0-9.+-]+(; charset=utf-8)?", 100)
SHA256 = string(r"[0-9a-f]{64}")
ORIGIN = string(ORIGIN_PATTERN)
CONSUMER = string(CONSUMER_PATTERN)
ANY_STRING = string()

BLOB = message(
    {
        "role": (REQUIRED, ROLE),
        "path": (REQUIRED, BLOB_PATH),
        "media_type": (REQUIRED, MEDIA_TYPE),
        "content_encoding": (OPTIONAL, constant("gzip")),
        "sha256": (REQUIRED, SHA256),
        "size_bytes": (REQUIRED, integer(0)),
    }
)
FOCUS_SPAN = message({"start_time": (REQUIRED, ANY_STRING), "end_time": (REQUIRED, ANY_STRING)})
VISIT = message(
    {
        "url": (REQUIRED, URL),
        "url_truncated": (OPTIONAL, boolean),
        "title": (REQUIRED, TEXT),
        "site": (REQUIRED, SITE),
        "device_id": (REQUIRED, UUID),
        "device_label": (REQUIRED, LABEL),
        "start_time": (REQUIRED, ANY_STRING),
        "end_time": (REQUIRED, ANY_STRING),
        "focus_seconds": (REQUIRED, integer(1, 21600)),
        "focus_spans": (REQUIRED, array(FOCUS_SPAN, 200)),
    }
)
DOCUMENT = message(
    {
        "visit": (REQUIRED, RECORD_ID),
        "url": (REQUIRED, URL),
        "url_truncated": (OPTIONAL, boolean),
        "title": (REQUIRED, TEXT),
        "description": (REQUIRED, TEXT),
        "site": (REQUIRED, SITE),
        "device_id": (REQUIRED, UUID),
        "device_label": (REQUIRED, LABEL),
        "capture_time": (REQUIRED, ANY_STRING),
        "text_bytes": (REQUIRED, integer(0, 65536)),
        "text_truncated": (OPTIONAL, boolean),
    }
)
TOMBSTONE = message({"target": (REQUIRED, TOMBSTONE_TARGET)})
ENVELOPE = {
    "seq": (REQUIRED, integer(1)),
    "id": (REQUIRED, RECORD_ID),
    "kind": (REQUIRED, ANY_STRING),
    "event_time": (REQUIRED, ANY_STRING),
}
CHANGE_OF_KIND = {
    "visit": message(
        {**ENVELOPE, "page_id": (REQUIRED, PAGE_ID), "blobs": (REQUIRED, array(BLOB, 0)), "visit": (REQUIRED, VISIT)}
    ),
    "document": message(
        {
            **ENVELOPE,
            "page_id": (REQUIRED, PAGE_ID),
            "blobs": (REQUIRED, array(BLOB, 8)),
            "document": (REQUIRED, DOCUMENT),
        }
    ),
    "tombstone": message({**ENVELOPE, "blobs": (REQUIRED, array(BLOB, 0)), "tombstone": (REQUIRED, TOMBSTONE)}),
}
# A kind this consumer does not know (a newer recall's `star`): its envelope, and any body of a known kind it carries.
CHANGE_OF_OTHER_KIND = message(
    {
        **ENVELOPE,
        "page_id": (OPTIONAL, PAGE_ID),
        "blobs": (REQUIRED, array(BLOB, 8)),
        "visit": (OPTIONAL, VISIT),
        "document": (OPTIONAL, DOCUMENT),
        "tombstone": (OPTIONAL, TOMBSTONE),
    }
)


def check_change(value: object, path: str) -> None:
    kind = value.get("kind") if isinstance(value, dict) else None
    rule = CHANGE_OF_KIND.get(kind) if isinstance(kind, str) else None
    (rule or CHANGE_OF_OTHER_KIND)(value, path)


CHANGE_PAGE = message(
    {
        "version": (REQUIRED, constant(VERSION)),
        "feed_id": (REQUIRED, UUID),
        "changes": (REQUIRED, array(check_change, PAGE_LIMIT)),
        "last_seq": (REQUIRED, integer(0)),
        "head_seq": (REQUIRED, integer(0)),
        "oldest_seq": (REQUIRED, integer(1)),
    }
)
ARCHIVE_STATE = message(
    {
        "version": (REQUIRED, constant(VERSION)),
        "feed_id": (REQUIRED, UUID),
        "source": (REQUIRED, ORIGIN),
        "consumer": (REQUIRED, CONSUMER),
        "synced_seq": (REQUIRED, integer(0)),
        "update_time": (REQUIRED, ANY_STRING),
    }
)


def check_page(page: object, after: int, feed_id: str | None) -> None:
    """The contract's step 2: a page is refused whole if anything is wrong, so no part of it is ever applied."""
    try:
        CHANGE_PAGE(page, "page")
    except Invalid as error:
        raise SyncError("invalid_page", at=str(error)) from None
    seqs = [int(change["seq"]) for change in page["changes"]]
    last, head = int(page["last_seq"]), int(page["head_seq"])
    # last_seq decides where the next page starts: never below `after` (nor above head_seq), and never stuck below
    # head_seq; the changes lie above `after` in seq order, none beyond last_seq.
    if not after <= last <= head or last == after < head:
        raise SyncError("invalid_page", at="page.last_seq")
    if any(seq <= previous for previous, seq in itertools.pairwise([after, *seqs])) or (seqs and seqs[-1] > last):
        raise SyncError("invalid_page", at="page.changes")
    if feed_id is not None and page["feed_id"] != feed_id:
        raise Stopped("feed_changed")


def json_value(data: bytes) -> object:
    """Strict JSON: no NaN or Infinity, which no recall writes."""

    def refuse(name: str) -> object:
        raise ValueError(name)

    return json.loads(data, parse_constant=refuse)


class BlobRef(NamedTuple):
    path: str
    size: int
    sha256: str


@dataclasses.dataclass(frozen=True)
class Line:
    """An archived change: what the consumer needs of it, and the compact JSON line it is kept as (whole)."""

    seq: int
    id: str
    page_id: str | None
    blobs: tuple[BlobRef, ...]
    target: str | None
    raw: bytes


def line_of(change: dict, raw: bytes | None = None) -> Line:
    """The line of a checked change (`raw`: the bytes it was read from a day file as, kept as they are)."""
    tombstone = change["kind"] == "tombstone"
    if raw is None:
        text = json.dumps(change, ensure_ascii=False, separators=(",", ":"))
        try:
            raw = text.encode("utf-8")
        except UnicodeEncodeError:  # a lone surrogate: the same JSON value, escaped
            raw = json.dumps(change, separators=(",", ":")).encode("ascii")
    return Line(
        seq=int(change["seq"]),
        id=change["id"],
        page_id=None if tombstone else change.get("page_id"),
        blobs=tuple(BlobRef(blob["path"], int(blob["size_bytes"]), blob["sha256"]) for blob in change["blobs"]),
        target=change["tombstone"]["target"] if tombstone else None,
        raw=raw,
    )


def archived_line(raw: bytes) -> Line:
    """A line read back from a day file, checked like a change of the feed (its blob paths among the rest)."""
    try:
        change = json_value(raw)
        check_change(change, "line")
    except (ValueError, RecursionError, Invalid):
        raise Stopped("archive_corrupt") from None
    return line_of(change, raw)


def merge(old: list[Line], new: list[Line]) -> list[Line]:
    """A day file's lines: per id only the line with the highest seq (a seq read again: the newer read), by seq."""
    latest: dict[str, Line] = {}
    for line in [*old, *new]:
        kept = latest.get(line.id)
        if kept is None or line.seq >= kept.seq:
            latest[line.id] = line
    return sorted(latest.values(), key=lambda line: line.seq)


def encode(lines: list[Line]) -> bytes:
    return b"".join(line.raw + b"\n" for line in lines)


def day_file(moment: dt.datetime) -> str:
    """The file of the changes applied on this UTC day: changes/YYYY/MM/DD.jsonl."""
    return moment.astimezone(dt.UTC).strftime("changes/%Y/%m/%d.jsonl")


def timestamp(moment: dt.datetime) -> str:
    return moment.astimezone(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


class Store(Protocol):
    """Where an archive lives (the contract's §5): five operations on paths relative to the archive root, such as
    `state.json` or `changes/2026/10/10.jsonl`, built only from the contract's formats. A WebDAV server or an
    S3-compatible bucket is another class of these five operations."""

    def read(self, path: str) -> bytes | None:
        """The file's bytes, or None when there is none."""

    def write_atomic(self, path: str, data: bytes) -> None:
        """Replaces the file whole: a reader sees its old bytes or the new ones, never a part."""

    def exists(self, path: str, size: int, sha256: str) -> bool:
        """Whether the file is there with this size and SHA-256 (lower-case hex)."""

    def delete(self, path: str) -> None:
        """Removes the file; nothing happens when it is gone already."""

    def list(self, prefix: str) -> list[str]:
        """Every file under the prefix (`changes/`), sorted."""


def fsync_directory(directory: str) -> None:
    descriptor = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    except OSError as error:
        if error.errno not in (errno.EINVAL, errno.ENOTSUP):  # a filesystem that cannot flush a directory
            raise
    finally:
        os.close(descriptor)


class DirStore:
    """The `dir` driver: a mounted directory (the NAS share, a USB disk, an SMB or NFS mount). A file is written as a
    temporary file in its directory, flushed, renamed over its name, and the directory flushed."""

    def __init__(self, root: str):
        self.root = os.path.abspath(root)

    def _path(self, path: str) -> str:
        parts = path.split("/")
        if any(part in ("", ".", "..") or "\\" in part or "\0" in part for part in parts):
            raise ValueError("not a path inside the archive")
        return os.path.join(self.root, *parts)

    def _make_directory(self, directory: str) -> None:
        """Makes a directory and its missing parents, each made durable in its own parent; never the archive root
        itself, so a share that is not mounted never becomes a directory inside the container."""
        if os.path.isdir(directory):
            return
        if directory == self.root:
            raise SyncError("archive_root_missing")
        parent = os.path.dirname(directory)
        self._make_directory(parent)
        with contextlib.suppress(FileExistsError):
            os.mkdir(directory)
        fsync_directory(parent)

    def read(self, path: str) -> bytes | None:
        try:
            with open(self._path(path), "rb") as file:
                return file.read()
        except FileNotFoundError:
            return None

    def write_atomic(self, path: str, data: bytes) -> None:
        target = self._path(path)
        directory = os.path.dirname(target)
        self._make_directory(directory)
        # A crash's leftover is a dotfile ending in .tmp: no reader's `*.jsonl` or `*.gz` takes it; list skips it.
        descriptor, temporary = tempfile.mkstemp(prefix=".", suffix=".tmp", dir=directory)
        try:
            with os.fdopen(descriptor, "wb") as file:
                file.write(data)
                file.flush()
                os.fsync(file.fileno())
            os.chmod(temporary, FILE_MODE)
            os.replace(temporary, target)
        except BaseException:
            with contextlib.suppress(FileNotFoundError):
                os.unlink(temporary)
            raise
        fsync_directory(directory)

    def exists(self, path: str, size: int, sha256: str) -> bool:
        try:
            with open(self._path(path), "rb") as file:
                return os.fstat(file.fileno()).st_size == size and hashlib.sha256(file.read()).hexdigest() == sha256
        except FileNotFoundError:
            return False

    def delete(self, path: str) -> None:
        target = self._path(path)
        try:
            os.unlink(target)
        except FileNotFoundError:
            return
        fsync_directory(os.path.dirname(target))

    def list(self, prefix: str) -> list[str]:
        found = []
        for directory, subdirectories, names in os.walk(self._path(prefix.rstrip("/"))):
            subdirectories[:] = [name for name in subdirectories if not name.startswith(".")]
            found.extend(
                os.path.relpath(os.path.join(directory, name), self.root).replace(os.sep, "/")
                for name in names
                if not name.startswith(".")
            )
        return sorted(found)


class _RefuseRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args: object, **kwargs: object) -> None:
        return None  # the 3xx then surfaces as an HTTPError: redirect_refused


# The answers of GET changes that only the operator moves past (the contract's §1).
FEED_STOPS = {400: "bad_request", 409: "cursor_ahead", 410: "cursor_expired"}


def retry_after(value: str | None) -> int | None:
    """Retry-After in seconds (recall sends seconds), within a day."""
    if value is None or not re.fullmatch(r"[0-9]{1,9}", value.strip()):
        return None
    return min(max(int(value.strip()), 1), 24 * HOUR)


class FeedClient:
    """The two routes of the contract's §1 with the export token: HTTPS only, redirects refused, no cookies, a 30 s
    timeout per request. A consumer branches on the status code only, so error bodies are never read."""

    def __init__(self, origin: str, token: str, consumer: str):
        self.origin = origin
        self.consumer = consumer
        self._token = token
        self._opener = urllib.request.build_opener(_RefuseRedirects())

    def _get(self, path: str, max_bytes: int) -> tuple[int, Mapping[str, str], bytes]:
        request = urllib.request.Request(
            self.origin + path, headers={"Authorization": f"Bearer {self._token}", "User-Agent": USER_AGENT}
        )
        try:
            with self._opener.open(request, timeout=REQUEST_TIMEOUT) as response:
                return response.status, response.headers, response.read(max_bytes + 1)
        except urllib.error.HTTPError as error:
            error.close()
            return error.code, error.headers, b""
        except (OSError, http.client.HTTPException):  # DNS, TLS, refused or reset connections, timeouts
            raise SyncError("network") from None

    def _refusal(self, route: str, status: int, headers: Mapping[str, str]) -> SyncError:
        if 300 <= status < 400:
            return SyncError("redirect_refused")
        if status == 401:
            return TokenRefused("export_token_refused")
        if route == "changes" and status in FEED_STOPS:
            return Stopped(FEED_STOPS[status])
        wait = retry_after(headers.get("Retry-After")) if status in (429, 503) else None
        return SyncError(f"{route}_http_{status}", retry_after=wait)

    def changes(self, after: int) -> object:
        """GET changes above `after`: the page as parsed JSON, not checked yet."""
        query = urllib.parse.urlencode({"after": after, "limit": PAGE_LIMIT, "consumer": self.consumer})
        status, headers, body = self._get(f"/api/machine/v1/changes?{query}", PAGE_MAX_BYTES)
        if status != 200:
            raise self._refusal("changes", status, headers)
        try:
            if len(body) > PAGE_MAX_BYTES:
                raise ValueError("too large")
            return json_value(body)
        except (ValueError, RecursionError):
            raise SyncError("invalid_page", at="page") from None

    def blob(self, path: str, size: int) -> bytes | None:
        """A blob's stored bytes (at most `size` + 1 of them are read), or None for 410 blob_deleted."""
        status, headers, body = self._get(f"/api/machine/v1/blobs/{path}", size)
        if status == 410:
            return None
        if status != 200:
            raise self._refusal("blob", status, headers)
        return body


@dataclasses.dataclass
class Batch:
    """Pages checked and not applied yet; `error` ended the pull after them (they are applied before it is raised)."""

    feed_id: str
    last_seq: int
    lines: list[Line]
    caught_up: bool
    error: SyncError | None = None


class Consumer:
    """One archive root following one feed (the contract's §4)."""

    def __init__(
        self, store: Store, feed: FeedClient, clock: Callable[[], dt.datetime] = utc_now, batch_bytes: int = BATCH_BYTES
    ):
        self.store = store
        self.feed = feed
        self.clock = clock
        self.batch_bytes = batch_bytes

    def sync(self) -> int:
        """Catches up with the feed and answers the synced seq; raises the SyncError that ended the run early."""
        feed_id, synced = self._open()
        while True:
            batch = self._pull(feed_id, synced)
            counts = self._apply(batch)
            feed_id, synced = batch.feed_id, batch.last_seq
            log("synced", synced_seq=synced, caught_up=batch.caught_up, **counts)
            if batch.error is not None:
                raise batch.error
            if batch.caught_up:
                return synced

    def _open(self) -> tuple[str | None, int]:
        """Step 1: the archive's feed and cursor; an empty store becomes an archive without a feed yet."""
        version, state = self.store.read("VERSION"), self.store.read("state.json")
        if version is None:
            if state is not None:
                raise Stopped("archive_invalid")
            self.store.write_atomic("VERSION", f"{VERSION}\n".encode())
            return None, 0
        if version.strip() != VERSION.encode():
            raise Stopped("archive_version")
        if state is None:
            return None, 0
        try:
            value = json_value(state)
            ARCHIVE_STATE(value, "state")
        except (ValueError, RecursionError, Invalid):
            raise Stopped("archive_state_invalid") from None
        return value["feed_id"], int(value["synced_seq"])

    def _pull(self, feed_id: str | None, after: int) -> Batch:
        """Step 2, page after page, until the feed is caught up or the batch is full."""
        lines: list[Line] = []
        size = pages = 0
        while True:
            try:
                page = self.feed.changes(after)
                check_page(page, after, feed_id)
            except SyncError as error:
                if pages == 0:
                    raise
                return Batch(feed_id, after, lines, caught_up=False, error=error)
            pages += 1
            feed_id, after = page["feed_id"], int(page["last_seq"])
            for change in page["changes"]:
                lines.append(line_of(change))
                size += len(lines[-1].raw)
            if after >= int(page["head_seq"]):
                return Batch(feed_id, after, lines, caught_up=True)
            if size >= self.batch_bytes:
                return Batch(feed_id, after, lines, caught_up=False)

    def _apply(self, batch: Batch) -> dict[str, int]:
        """Steps 3 to 6: today's day file, the blobs, the tombstones, then state.json."""
        counts = collections.Counter(changes=len(batch.lines))
        if batch.lines:
            today = day_file(self.clock())
            self.store.write_atomic(today, encode(merge(self._read_day(today), batch.lines)))
            for line in batch.lines:
                for blob in line.blobs:
                    counts[self._keep_blob(blob)] += 1
            tombstones = [line for line in batch.lines if line.target is not None]
            if tombstones:
                counts["purged"] = self._purge(tombstones)
        self._write_state(batch.feed_id, batch.last_seq)
        return dict(counts)

    def _read_day(self, path: str) -> list[Line]:
        data = self.store.read(path)
        return [] if data is None else [archived_line(raw.strip()) for raw in data.split(b"\n") if raw.strip()]

    def _keep_blob(self, blob: BlobRef) -> str:
        """Step 4 for one blob: kept already, fetched and checked, or gone from recall (410)."""
        path = f"blobs/{blob.path}"
        if blob.size > BLOB_MAX_BYTES:
            raise SyncError("blob_too_large")
        if self.store.exists(path, blob.size, blob.sha256):
            return "blobs_kept"
        data = self.feed.blob(blob.path, blob.size)
        if data is None:
            return "blobs_gone"
        if len(data) != blob.size or hashlib.sha256(data).hexdigest() != blob.sha256:
            raise SyncError("blob_digest_mismatch")
        self.store.write_atomic(path, data)
        return "blobs_fetched"

    def _purge(self, tombstones: list[Line]) -> int:
        """Step 5: one pass over the day files removes every line with a lower seq than a tombstone of its record or
        its page, the line's blobs first (a crash before the rewrite finds the line again). Tombstones stay."""
        pages: dict[str, int] = {}
        records: dict[str, int] = {}
        for tombstone in tombstones:
            page = PAGE_TARGET.fullmatch(tombstone.target)
            targets, key = (pages, page.group(1)) if page else (records, tombstone.target)
            targets[key] = max(targets.get(key, 0), tombstone.seq)

        def deleted(line: Line) -> bool:
            return records.get(line.id, 0) > line.seq or (
                line.page_id is not None and pages.get(line.page_id, 0) > line.seq
            )

        purged = 0
        for path in self.store.list("changes/"):
            if not DAY_FILE.fullmatch(path):
                continue
            lines = self._read_day(path)
            doomed = [line for line in lines if deleted(line)]
            if not doomed:
                continue
            for line in doomed:
                for blob in line.blobs:
                    self.store.delete(f"blobs/{blob.path}")
            self.store.write_atomic(path, encode([line for line in lines if not deleted(line)]))
            purged += len(doomed)
        return purged

    def _write_state(self, feed_id: str, synced_seq: int) -> None:
        """Step 6, last: the feed and the cursor, which vouch for everything written before."""
        state = {
            "version": VERSION,
            "feed_id": feed_id,
            "source": self.feed.origin,
            "consumer": self.feed.consumer,
            "synced_seq": synced_seq,
            "update_time": timestamp(self.clock()),
        }
        self.store.write_atomic("state.json", (json.dumps(state, indent=2, ensure_ascii=False) + "\n").encode())


@dataclasses.dataclass(frozen=True)
class Config:
    origin: str
    archive_dir: str
    consumer: str
    interval: int
    token_value: str | None
    token_file: str | None

    def token(self) -> str:
        """The export token, read again for every run, so a new token file counts without a restart."""
        if self.token_file is None:
            return self.token_value or ""
        try:
            with open(self.token_file, encoding="utf-8") as file:
                value = file.read().strip()
        except (OSError, UnicodeError):
            raise SyncError("export_token_unreadable") from None
        if not valid_token(value):
            raise SyncError("export_token_invalid")
        return value


def valid_token(value: str) -> bool:
    # A quote is an env file's quoting taken literally (Docker's env files have none).
    return bool(TOKEN.fullmatch(value)) and value[0] not in "\"'"


def origin_of(base_url: str) -> str:
    """recall's origin: HTTPS, or plain http to this machine's loopback (a local wrangler dev, the tests)."""
    parts = urllib.parse.urlsplit(base_url.strip())
    try:
        port = parts.port
    except ValueError:
        raise ConfigError("base_url_invalid") from None
    host = parts.hostname or ""
    secure = parts.scheme == "https" or (parts.scheme == "http" and host in LOOPBACK_HOSTS)
    origin = f"{parts.scheme}://{host}" + ("" if port is None else f":{port}")
    if (
        not secure
        or parts.username
        or parts.password
        or parts.path not in ("", "/")
        or parts.query
        or parts.fragment
        or not re.fullmatch(ORIGIN_PATTERN, origin)
    ):
        raise ConfigError("base_url_invalid")
    return origin


def load_config(environ: Mapping[str, str], need_token: bool = True) -> Config:
    consumer = environ.get("RECALL_CONSUMER", "nas")
    if not re.fullmatch(CONSUMER_PATTERN, consumer):
        raise ConfigError("consumer_invalid")
    interval = environ.get("RECALL_INTERVAL_SECONDS", "900")
    if not re.fullmatch(r"[0-9]{1,6}", interval) or not 60 <= int(interval) <= 24 * HOUR:
        raise ConfigError("interval_invalid")
    token_value, token_file = environ.get("RECALL_EXPORT_TOKEN"), environ.get("RECALL_EXPORT_TOKEN_FILE")
    if need_token:
        if (token_value is None) == (token_file is None):
            raise ConfigError("export_token_missing" if token_value is None else "export_token_ambiguous")
        if token_value is not None and not valid_token(token_value):
            raise ConfigError("export_token_invalid")
    return Config(
        origin=origin_of(environ.get("RECALL_BASE_URL", "https://recall.ziyixi.science")),
        archive_dir=environ.get("RECALL_ARCHIVE_DIR", "/archive"),
        consumer=consumer,
        interval=int(interval),
        token_value=token_value,
        token_file=token_file,
    )


def attempt(config: Config, clock: Callable[[], dt.datetime]) -> SyncError | None:
    """One catch-up; the error that ended it early (logged already), or None."""
    try:
        feed = FeedClient(config.origin, config.token(), config.consumer)
        Consumer(DirStore(config.archive_dir), feed, clock).sync()
        return None
    except SyncError as error:
        log("stopped" if isinstance(error, Stopped) else "error", **error.fields())
        return error
    except OSError as error:  # the store: a share not mounted, its permissions, a full disk
        log("error", code="store_error", errno=errno.errorcode.get(error.errno or 0, "unknown"))
        return SyncError("store_error")
    except Exception as error:  # a bug: its message may hold data, so only its type is logged
        log("error", code="internal", type=type(error).__name__)
        return SyncError("internal")


def exit_on_sigterm(number: int, frame: object) -> None:
    # `docker stop`: as a container's PID 1, Python would ignore SIGTERM until killed. Exiting anywhere is safe: every
    # write is atomic and state.json comes last.
    raise SystemExit(0)


def serve(
    config: Config, clock: Callable[[], dt.datetime] = utc_now, sleep: Callable[[float], None] = time.sleep
) -> None:
    while True:
        error = attempt(config, clock)
        if isinstance(error, Stopped):
            while True:  # nothing more is pulled into this archive root; it says why once an hour
                sleep(HOUR)
                log("stopped", **error.fields())
        if isinstance(error, TokenRefused):
            delay = HOUR
        elif error is not None and error.retry_after:
            delay = error.retry_after
        else:
            delay = config.interval
        sleep(delay)


def check(config: Config, clock: Callable[[], dt.datetime]) -> int:
    """The health check: 0 when state.json was written within three intervals, else 1."""
    age = None
    # TypeError: an update_time without its zone.
    with contextlib.suppress(OSError, ValueError, TypeError, RecursionError, Invalid):
        data = DirStore(config.archive_dir).read("state.json")
        if data is not None:
            state = json_value(data)
            ARCHIVE_STATE(state, "state")
            age = (clock() - dt.datetime.fromisoformat(state["update_time"])).total_seconds()
    healthy = age is not None and age < 3 * config.interval
    log("check", healthy=healthy, **({} if age is None else {"age_seconds": int(age)}))
    return 0 if healthy else 1


def main(
    argv: list[str] | None = None,
    environ: Mapping[str, str] = os.environ,
    clock: Callable[[], dt.datetime] = utc_now,
    sleep: Callable[[float], None] = time.sleep,
) -> int:
    parser = argparse.ArgumentParser(
        description="Pull recall's change feed into an archive (contracts/recall-archive-v1)."
    )
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument(
        "--once", action="store_true", help="catch up once, then exit: 0 when caught up, 1 when the run ended early"
    )
    mode.add_argument("--check", action="store_true", help="exit 0 when state.json was written within three intervals")
    args = parser.parse_args(argv)
    try:
        config = load_config(environ, need_token=not args.check)
    except ConfigError as error:
        log("config_invalid", code=error.code)
        return 2
    if args.check:
        return check(config, clock)
    if args.once:
        return 0 if attempt(config, clock) is None else 1
    signal.signal(signal.SIGTERM, exit_on_sigterm)
    serve(config, clock, sleep)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

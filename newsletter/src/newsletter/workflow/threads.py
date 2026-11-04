"""Give published stories a stable cross-day identity for later prompts.

A thread is code's grouping of the stories readers received in the last
THREAD_DAYS: a story joins the earlier thread it shares a URL, DOI, arXiv ID,
exact title or event_key with. Its key stays stable while any story keeps it:
discovery is asked to reuse a thread key as event_key, and a thread whose
oldest story left the window adopts the key its later candidates carry;
otherwise the key hashes the first story's candidate IDs. Threads only inform
prompts and annotate the pool; a thread key is never a deduplication identity
(see ``sources.THREAD_KEY``), so nothing is dropped because of them.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
import datetime
import hashlib

import newsletter.types as types
import newsletter.workflow.sources as sources

THREAD_DAYS = 30
# times_14d counts the days a thread was published in this recent window.
FREQUENT_DAYS = 14
MAX_THREADS = 100
MAX_URLS = 3
# Matching keys a frozen thread keeps, newest story first. Not prompt text.
MAX_KEYS = 24
KEY = sources.THREAD_KEY


def _new_key(story: types.Payload) -> str:
    ids = "\n".join(sorted(story["candidate_ids"]))
    return "thread-" + hashlib.sha256(ids.encode()).hexdigest()[:12]


def build(
    stories: Sequence[types.Payload],
    candidates: Mapping[str, types.Payload],
    issue_date: str,
) -> list[types.Payload]:
    """Group oldest-first published stories into threads, newest first."""
    groups: dict[str, types.Payload] = {}
    for story in stories:
        members = [
            candidates[item]
            for item in story["candidate_ids"]
            if item in candidates
        ]
        urls = [*story["source_urls"], *(item["url"] for item in members)]
        keys: set[str] = set().union(
            *(sources.identity_keys(item) for item in members),
            *(sources.identity_keys({"url": url}) for url in urls),
        )
        # Claims read today's candidate bodies, which a later pooling of the
        # same URL may overwrite; a moved claim only changes a prompt hint.
        claimed = sorted(
            {
                str(item.get("event_key", ""))
                for item in members
                if KEY.fullmatch(str(item.get("event_key", "")))
            }
        )
        key = (
            next((key for key in claimed if key in groups), "")
            or next(
                (key for key, group in groups.items() if group["keys"] & keys),
                "",
            )
            or next(iter(claimed), "")
            or _new_key(story)
        )
        group = groups.setdefault(key, {"keys": set(), "stories": []})
        group["keys"] |= keys
        group["stories"].append((story, urls, keys))
    since = (
        datetime.date.fromisoformat(issue_date)
        - datetime.timedelta(days=FREQUENT_DAYS)
    ).isoformat()
    threads = []
    for key, group in groups.items():
        newest = group["stories"][::-1]
        dates = sorted({story["issue_date"] for story, _, _ in newest})
        ordered = dict.fromkeys(
            item for _, _, story_keys in newest for item in sorted(story_keys)
        )
        threads.append(
            {
                "thread_key": key,
                "title": newest[0][0]["title"][:300],
                "first_published": dates[0],
                "last_published": dates[-1],
                "times": len(dates),
                "times_14d": sum(day >= since for day in dates),
                "urls": list(
                    dict.fromkeys(url for _, urls, _ in newest for url in urls)
                )[:MAX_URLS],
                "keys": sorted(list(ordered)[:MAX_KEYS]),
            }
        )
    threads.sort(
        key=lambda thread: (thread["last_published"], thread["thread_key"]),
        reverse=True,
    )
    return threads[:MAX_THREADS]


def annotate(
    candidates: Sequence[types.Payload],
    threads: Sequence[types.Payload],
) -> dict[str, types.Payload]:
    """Link pool candidates to a published thread; unmatched ones are absent.

    A candidate whose event_key is a thread key belongs to that thread;
    otherwise the most recent thread sharing an identity key wins.
    """
    known = {thread["thread_key"]: thread for thread in threads}
    result = {}
    for candidate in candidates:
        keys = sources.identity_keys(candidate)
        thread = known.get(candidate["event_key"]) or next(
            (thread for thread in threads if keys & set(thread["keys"])), None
        )
        if thread is not None:
            result[candidate["id"]] = {
                "thread_key": thread["thread_key"],
                "last_published": thread["last_published"],
                "times_14d": thread["times_14d"],
            }
    return result


def prompt_threads(threads: Sequence[types.Payload]) -> list[types.Payload]:
    """Show threads without the matching keys only code uses."""
    return [
        {key: value for key, value in thread.items() if key != "keys"}
        for thread in threads
    ]


def prompt_index(index: Sequence[types.Payload]) -> list[types.Payload]:
    """Show the recent candidate index without candidate IDs."""
    return [
        {key: value for key, value in record.items() if key != "id"}
        for record in index
    ]

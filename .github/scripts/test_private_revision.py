"""The scheduled reconciliation compares live private source identities with the pinned gitlink."""

import contextlib
import http.server
import io
import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import patch

import private_revision
from private_revision import Refused

PINNED, RELEASED, OTHER = "a" * 40, "b" * 40, "c" * 40
SOURCE, PARENT, SETTLED, NEWER = "d" * 40, "e" * 40, "1" * 40, "2" * 40
HOST = "synthetic-private.example.invalid"
REPOSITORY = "synthetic-owner/synthetic-repository"


def catalogue(*statuses, domains=(HOST,)):
    entries = [{"id": f"entry-{index}", "status": status} for index, status in enumerate(statuses)]
    return {
        "registry": {"entries": entries, "workers": [], "resources": []},
        "desired": {"version": 1, "zones": ["example.invalid"],
                    "workers": {"synthetic-worker": {"custom_domains": list(domains)}}},
    }


def health(url="https://" + HOST + "/healthz", **extra):
    return {"type": "public_http", "enabled": True, "url": url, "expect": [200],
            "content_type": "application/json", "outside_access": True, **extra}


class ProbeSelection(unittest.TestCase):
    def test_selects_only_enabled_health_probes_on_registered_domains(self):
        value = catalogue(
            health(),
            health(),
            health("https://" + HOST + "/healthz/freshness"),
            health("https://" + HOST + "/healthz", enabled=False),
            {"type": "link_only"},
            None,
        )
        self.assertEqual(private_revision.probe_urls(value), ["https://" + HOST + "/healthz"])

    def test_a_probe_outside_the_catalogues_own_https_domains_is_refused(self):
        for url in ("http://" + HOST + "/healthz", "https://" + HOST + ":8443/healthz",
                    "https://user@" + HOST + "/healthz", "https://" + HOST + "/healthz?x=1",
                    "https://" + HOST + "/healthz#x", "https://other.example.invalid/healthz",
                    "https://" + HOST.upper() + "/healthz"):
            with self.subTest(url=url), self.assertRaisesRegex(Refused, "^PRIVATE_REVISION_CATALOG_INVALID$"):
                private_revision.probe_urls(catalogue(health(url)))

    def test_missing_or_malformed_registrations_fail_instead_of_passing_vacuously(self):
        with self.assertRaisesRegex(Refused, "^PRIVATE_REVISION_PROBE_MISSING$"):
            private_revision.probe_urls(catalogue(health("https://" + HOST + "/healthz/freshness")))
        for value in ({}, {"registry": {"entries": []}}, catalogue(health(url=7)),
                      catalogue(health(), domains=(7,)), {"registry": {"entries": [7]}, "desired": {"workers": {}}}):
            with self.subTest(value=value), self.assertRaisesRegex(Refused, "^PRIVATE_REVISION_CATALOG_INVALID$"):
                private_revision.probe_urls(value)


class FakeService:
    """A loopback server answering each request with the next scripted response."""

    def __init__(self, responses):
        self.responses = list(responses)
        self.paths = []
        service = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802 - BaseHTTPRequestHandler's method name
                service.paths.append((self.path, self.headers.get("Authorization"), self.headers.get("Cookie")))
                status, content_type, body, headers = service.responses.pop(0)
                self.send_response(status)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(body)))
                for name, value in headers.items():
                    self.send_header(name, value)
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}/healthz"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *args):
        self.server.shutdown()
        self.server.server_close()


def answer(status=200, document=None, content_type="application/json", headers=None, body=None):
    if body is None:
        body = json.dumps(document if document is not None else {}).encode()
    return status, content_type, body, headers or {}


def identities(worker=PINNED, collector=PINNED, **extra):
    return {"status": "healthy", "worker_sha": worker, "collector_sha": collector, **extra}


class LiveSources(unittest.TestCase):
    def probe(self, *responses):
        sleeps = []
        opener = urllib.request.build_opener(private_revision._NoRedirect, urllib.request.ProxyHandler({}))
        with FakeService(responses) as service:
            try:
                return private_revision.live_sources(service.url, opener, sleeps.append), service.paths, sleeps
            except Refused as refused:
                return str(refused), service.paths, sleeps

    def test_reads_both_identities_anonymously(self):
        sources, paths, _ = self.probe(answer(document=identities(PINNED, RELEASED)))
        self.assertEqual(sources, {PINNED, RELEASED})
        self.assertEqual(paths, [("/healthz", None, None)])

    def test_a_degraded_json_answer_still_reports_identities_but_needs_both(self):
        sources, _, _ = self.probe(answer(503, identities(status="degraded")))
        self.assertEqual(sources, {PINNED})
        # A briefly unreachable collector reports no identity; it is retried like a gateway error.
        unreachable = answer(503, identities(collector="", status="degraded"))
        sources, paths, sleeps = self.probe(unreachable, answer(document=identities()))
        self.assertEqual((sources, len(paths), sleeps), ({PINNED}, 2, [10]))
        sources, paths, _ = self.probe(*[unreachable] * 3)
        self.assertEqual((sources, len(paths)), ("PRIVATE_REVISION_UNAVAILABLE", 3))

    def test_gateway_errors_retry_a_bounded_number_of_times(self):
        sources, paths, sleeps = self.probe(answer(502, body=b"gateway"), answer(504, body=b"gateway"),
                                            answer(document=identities()))
        self.assertEqual((sources, len(paths), sleeps), ({PINNED}, 3, [10, 10]))
        sources, paths, _ = self.probe(*[answer(503, content_type="text/html", body=b"<html>")] * 3)
        self.assertEqual((sources, len(paths)), ("PRIVATE_REVISION_UNAVAILABLE", 3))

    def test_redirects_other_errors_and_unexpected_bodies_are_unavailable_at_once(self):
        for response in (
            answer(302, headers={"Location": "https://login.example.invalid/"}),
            answer(404, identities()),
            answer(204, body=b""),
            answer(document=identities(), content_type="text/html"),
            answer(body=b"{" * 10),
            answer(body=b" " * (private_revision.MAX_BODY_BYTES + 1)),
            answer(document=[PINNED]),
            answer(document=identities(worker=PINNED.upper())),
            answer(document={"worker_sha": PINNED}),
        ):
            with self.subTest(response=response[:2]):
                sources, paths, _ = self.probe(response)
                self.assertEqual((sources, len(paths)), ("PRIVATE_REVISION_UNAVAILABLE", 1))

    def test_an_unreachable_service_is_unavailable_after_the_retries(self):
        with FakeService([]) as service:
            url = service.url
        sleeps = []
        with self.assertRaisesRegex(Refused, "^PRIVATE_REVISION_UNAVAILABLE$"):
            private_revision.live_sources(url, urllib.request.build_opener(urllib.request.ProxyHandler({})),
                                          sleeps.append)
        self.assertEqual(sleeps, [10, 10])


class GitHubApi(unittest.TestCase):
    def test_a_redirect_is_refused_without_sending_the_token_on(self):
        with FakeService([answer(document={})]) as target, FakeService([]) as api:
            api.responses.append(answer(302, headers={"Location": target.url}))
            environment = {"GITHUB_API_URL": api.url.removesuffix("/healthz"), "GH_TOKEN": "synthetic-token"}
            with (patch.dict("os.environ", environment), patch.object(urllib.request, "getproxies", return_value={}),
                  self.assertRaises(urllib.error.HTTPError) as raised):
                private_revision.github("/repos/" + REPOSITORY + "/deployments")
            raised.exception.close()
        self.assertEqual(api.paths, [("/repos/" + REPOSITORY + "/deployments", "Bearer synthetic-token", None)])
        self.assertEqual(target.paths, [])


class Comparison(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.catalogue = Path(directory.name) / "catalogue.json"
        self.catalogue.write_text(json.dumps(catalogue(health(), health("https://" + HOST + "/healthz/freshness"))))
        self.calls = []
        self.records = [{"id": 41, "sha": PARENT, "environment": "private",
                         "payload": {"private_sha": RELEASED, "parent_sha": PARENT}}]
        self.statuses = [{"state": "success"}, {"state": "in_progress"}]
        self.comparison = {"status": "ahead"}
        self.contents = {"type": "submodule", "sha": RELEASED}
        # The newest successful main push run of CI, at a later commit pinning the current gitlink.
        self.runs = {"workflow_runs": [self.ci_run(SETTLED)]}
        self.settled_on_source = {"status": "ahead"}
        self.release_before_settled = {"status": "ahead"}
        self.settled_contents = {"type": "submodule", "sha": PINNED}

        def git(root, *arguments):
            self.assertEqual(root, "selected-source")
            return {("ls-tree", "HEAD", "private"): f"160000 commit {PINNED}\tprivate",
                    ("rev-parse", "HEAD"): SOURCE}[arguments]

        patcher = patch.object(private_revision.private_catalog, "git", side_effect=git)
        patcher.start()
        self.addCleanup(patcher.stop)

    @staticmethod
    def ci_run(head, **extra):
        return {"head_sha": head, "head_branch": "main", "event": "push", "conclusion": "success", **extra}

    def api(self, path):
        self.calls.append(path)
        base = "/repos/" + REPOSITORY
        responses = {
            base + "/deployments?environment=private&per_page=1": self.records,
            base + "/deployments/41/statuses?per_page=10": self.statuses,
            base + f"/compare/{PARENT}...{SOURCE}?per_page=1": self.comparison,
            base + f"/contents/private?ref={PARENT}": self.contents,
            base + "/actions/workflows/ci.yml/runs?branch=main&event=push&status=success&per_page=5": self.runs,
            base + f"/compare/{NEWER}...{SOURCE}?per_page=1": {"status": "behind"},
            base + f"/compare/{SETTLED}...{SOURCE}?per_page=1": self.settled_on_source,
            base + f"/compare/{PARENT}...{SETTLED}?per_page=1": self.release_before_settled,
            base + f"/contents/private?ref={SETTLED}": self.settled_contents,
        }
        value = responses[path]
        if isinstance(value, Exception):
            raise value
        return value

    def check(self, *live):
        probes = []

        def probe(url):
            probes.append(url)
            return set(live)

        try:
            code = private_revision.check("selected-source", self.catalogue, repository=REPOSITORY,
                                          api=self.api, probe=probe)
        except Refused as refused:
            code = str(refused)
        self.assertEqual(probes, ["https://" + HOST + "/healthz"])
        return code

    def test_live_sources_at_the_pinned_gitlink_need_no_release_record(self):
        self.assertEqual(self.check(PINNED), "PRIVATE_REVISION_MATCHES_PIN")
        self.assertEqual(self.calls, [])

    def test_an_unpublished_pin_matches_the_newest_verified_release_on_this_main(self):
        self.assertEqual(self.check(RELEASED), "PRIVATE_REVISION_MATCHES_RELEASE")
        self.assertEqual(len(self.calls), 8)
        self.calls.clear()
        self.statuses = [{"state": "inactive"}, {"state": "success"}]
        self.comparison = {"status": "identical"}
        self.settled_on_source = {"status": "identical"}
        self.release_before_settled = {"status": "identical"}
        # A successful run for a newer main than this source is skipped.
        self.runs = {"workflow_runs": [self.ci_run(NEWER), self.ci_run(SETTLED)]}
        self.assertEqual(self.check(RELEASED), "PRIVATE_REVISION_MATCHES_RELEASE")

    def test_a_pin_no_successful_run_has_settled_since_the_release_is_pending(self):
        cases = [
            # The pin advanced, and no successful run has decided whether it needed a publication.
            ("settled_contents", {"type": "submodule", "sha": RELEASED}),
            ("runs", {"workflow_runs": []}),
            ("runs", {"workflow_runs": [self.ci_run(NEWER)]}),
            ("settled_on_source", {"status": "behind"}),
            # A later failed run published a source that no successful run has settled.
            ("release_before_settled", {"status": "behind"}),
        ]
        for name, value in cases:
            with self.subTest(name=name, value=value):
                original = getattr(self, name)
                setattr(self, name, value)
                try:
                    self.assertEqual(self.check(RELEASED), "PRIVATE_REVISION_RELEASE_PENDING")
                finally:
                    setattr(self, name, original)

    def test_malformed_run_answers_are_invalid(self):
        for value in ({}, {"workflow_runs": [{"head_sha": SETTLED}]}, {"workflow_runs": [self.ci_run(7)]},
                      {"workflow_runs": [self.ci_run(SETTLED, event="workflow_dispatch")]},
                      {"workflow_runs": [self.ci_run(SETTLED, conclusion="failure")]}):
            with self.subTest(value=value):
                self.runs = value
                self.assertEqual(self.check(RELEASED), "PRIVATE_REVISION_RECORD_INVALID")
        self.runs = {"workflow_runs": [self.ci_run(SETTLED)]}
        self.settled_contents = {"type": "submodule", "sha": PINNED.upper()}
        self.assertEqual(self.check(RELEASED), "PRIVATE_REVISION_RECORD_INVALID")

    def test_mixed_or_other_live_sources_are_a_mismatch(self):
        for live in ((PINNED, RELEASED), (OTHER,), (RELEASED, OTHER)):
            with self.subTest(live=live):
                self.assertEqual(self.check(*live), "PRIVATE_REVISION_MISMATCH")

    def test_an_unverified_newest_release_does_not_stand_in_for_the_pin(self):
        for states in (["failure", "success"], ["in_progress"], ["inactive"], ["error"], []):
            with self.subTest(states=states):
                self.statuses = [{"state": state} for state in states]
                self.assertEqual(self.check(RELEASED), "PRIVATE_REVISION_RELEASE_UNVERIFIED")

    def test_a_record_outside_this_main_or_its_gitlink_is_invalid(self):
        cases = [
            ("records", []),
            ("records", [{**self.records[0], "sha": OTHER}]),
            ("records", [{**self.records[0], "id": "41"}]),
            ("records", [{**self.records[0], "payload": {"private_sha": RELEASED.upper(), "parent_sha": PARENT}}]),
            ("records", [{"id": 41}]),
            ("comparison", {"status": "diverged"}),
            ("comparison", {"status": "behind"}),
            ("contents", {"type": "submodule", "sha": OTHER}),
            ("contents", {"type": "file", "sha": RELEASED}),
            ("statuses", OSError("synthetic-private-host")),
        ]
        for name, value in cases:
            with self.subTest(name=name, value=value):
                original = getattr(self, name)
                setattr(self, name, value)
                try:
                    self.assertEqual(self.check(RELEASED), "PRIVATE_REVISION_RECORD_INVALID")
                finally:
                    setattr(self, name, original)

    def test_source_and_catalogue_failures_have_fixed_codes(self):
        with self.assertRaisesRegex(Refused, "^PRIVATE_REVISION_SOURCE_INVALID$"):
            private_revision.check("selected-source", self.catalogue, repository="not a repository",
                                   api=self.api, probe=lambda url: {PINNED})
        self.catalogue.write_text("{")
        with self.assertRaisesRegex(Refused, "^PRIVATE_REVISION_CATALOG_INVALID$"):
            private_revision.check("selected-source", self.catalogue, repository=REPOSITORY,
                                   api=self.api, probe=lambda url: {PINNED})
        with patch.object(private_revision.private_catalog, "git", side_effect=ValueError("synthetic")):
            with self.assertRaisesRegex(Refused, "^PRIVATE_REVISION_SOURCE_INVALID$"):
                private_revision.check("selected-source", self.catalogue, repository=REPOSITORY,
                                       api=self.api, probe=lambda url: {PINNED})


class PublicOutput(unittest.TestCase):
    def run_main(self, outcome):
        def check(*args, **kwargs):
            if isinstance(outcome, Exception):
                raise outcome
            return outcome

        stdout, stderr = io.StringIO(), io.StringIO()
        argv = ["private_revision.py", "--source-root", ".", "--catalog-file", "synthetic.json"]
        with (patch.object(private_revision, "check", side_effect=check), patch("sys.argv", argv),
              contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr)):
            status = private_revision.main()
        return status, stdout.getvalue() + stderr.getvalue()

    def test_only_fixed_codes_reach_the_log(self):
        self.assertEqual(self.run_main("PRIVATE_REVISION_MATCHES_PIN"), (0, "::notice::PRIVATE_REVISION_MATCHES_PIN\n"))
        self.assertEqual(self.run_main("PRIVATE_REVISION_MATCHES_RELEASE"),
                         (0, "::notice::PRIVATE_REVISION_MATCHES_RELEASE\n"))
        self.assertEqual(self.run_main(Refused("PRIVATE_REVISION_MISMATCH")),
                         (1, "::error::PRIVATE_REVISION_MISMATCH\n"))
        self.assertEqual(self.run_main(RuntimeError("https://" + HOST + "/healthz")),
                         (1, "::error::PRIVATE_REVISION_CHECK_FAILED\n"))


if __name__ == "__main__":
    unittest.main()

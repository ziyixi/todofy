"""The object stops reading an owner write body at 16 KiB, even without a Content-Length.

The object also runs ingest and the alarm loop, so a chunked owner body must not be buffered
whole. Its early answer leaves the upload unfinished, which can upset wrangler's local proxy,
so this runs against its own short-lived dev server.
"""

import socket

from tests.runtime.harness import PUBLIC_HOST, Worker

CHUNK = b"x" * 16384
# wrangler's local proxy passes a chunked upload on only in large pieces (1.1 MiB unterminated never
# reached the object in a probe; 3.2 MiB did), so the upload is a few MiB, not just over 16 KiB.
CHUNKS = 200


def test_chunked_owner_body_over_the_cap_is_answered_before_it_ends(throwaway_worker: Worker) -> None:
    throwaway_worker.overview()  # the object is running, so its cold start does not count
    head = [
        "POST /api/v1/reports/recompute HTTP/1.1",
        f"Host: {PUBLIC_HOST}",
        "Connection: close",
        "Content-Type: application/json",
        "Transfer-Encoding: chunked",
        *(f"{name}: {value}" for name, value in throwaway_worker.csrf_headers().items()),
    ]
    port = int(throwaway_worker.base_url.rsplit(":", 1)[1])
    with socket.create_connection(("127.0.0.1", port), timeout=10) as sock:
        sock.sendall(("\r\n".join(head) + "\r\n\r\n").encode())
        try:
            for _ in range(CHUNKS):  # never the terminating chunk
                sock.sendall(b"%x\r\n%s\r\n" % (len(CHUNK), CHUNK))
        except (BrokenPipeError, ConnectionResetError):
            pass  # answered and closed while still uploading
        # Reading the whole body would wait for the terminating chunk forever (TimeoutError here).
        # The object answers 400 invalid_request once it has read past 16 KiB; the local proxy
        # reports that early answer as a 500 "Network connection lost" because the upload is open.
        status = int(sock.recv(64).split(b" ")[1])
    assert status in (400, 500)
    throwaway_worker.overview()  # the object still serves

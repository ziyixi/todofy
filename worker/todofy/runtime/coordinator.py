"""The single serial executor (`inbox-v1`): ingest, wake-ups and the alarm loop.

S1 spike shape: `spike_events` proves the D1 batch, WebCrypto hash, alarm and
outbound-timeout paths. S5 replaces it with the real ledger from 0001_init.sql.
"""

import json
from typing import Any
from urllib.parse import urlsplit

from workers import DurableObject, Response

from todofy.core.api_errors import ApiError
from todofy.core.contract import MAX_EVENT_BYTES
from todofy.runtime.config import var
from todofy.runtime.http import empty, error, json_response
from todofy.runtime.interop import fetch_with_timeout, now_ms, sha256_hex

SPIKE_TABLE = """
CREATE TABLE IF NOT EXISTS spike_events (
  event_id TEXT PRIMARY KEY,
  body_sha256 TEXT NOT NULL,
  body_bytes INTEGER NOT NULL,
  state TEXT NOT NULL,
  upstream_status INTEGER,
  received_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)"""


class TodofyCoordinator(DurableObject):
    def __init__(self, ctx: Any, env: Any) -> None:
        super().__init__(ctx, env)
        self.sql = ctx.storage.sql
        self.sql.exec("CREATE TABLE IF NOT EXISTS wakes (at INTEGER NOT NULL, cron TEXT NOT NULL)")
        self.schema_ready = False

    async def fetch(self, request: Any) -> Response:
        match request.method, urlsplit(request.url).path:
            case "POST", "/ingest":
                return await self.ingest(await request.bytes())
            case "POST", "/wake":
                return await self.wake(json.loads(await request.text()).get("cron", ""))
            case "GET", "/state":
                return await self.state()
        return error(404, ApiError.NOT_FOUND)

    async def db(self) -> Any:
        if not self.schema_ready:
            await self.env.DB.prepare(SPIKE_TABLE).run()
            self.schema_ready = True
        return self.env.DB

    async def ingest(self, body: bytes) -> Response:
        if len(body) > MAX_EVENT_BYTES:
            return error(413, ApiError.PAYLOAD_TOO_LARGE)
        try:
            event_id = json.loads(body)["event_id"]
        except (ValueError, TypeError, KeyError):
            return error(400, ApiError.INVALID_PAYLOAD)
        if not isinstance(event_id, str) or not event_id:
            return error(400, ApiError.INVALID_PAYLOAD)

        digest = await sha256_hex(body)
        now = now_ms()
        db = await self.db()
        results = await db.batch(
            [
                db.prepare(
                    "INSERT OR IGNORE INTO spike_events"
                    " (event_id, body_sha256, body_bytes, state, received_at, updated_at)"
                    " VALUES (?, ?, ?, 'pending', ?, ?)"
                ).bind(event_id, digest, len(body), now, now),
                db.prepare("SELECT body_sha256 FROM spike_events WHERE event_id = ?").bind(event_id),
            ]
        )
        if results[1].results[0].body_sha256 != digest:
            return error(409, ApiError.EVENT_CONFLICT)
        await self.schedule()
        return empty()

    async def wake(self, cron: str) -> Response:
        self.sql.exec("INSERT INTO wakes (at, cron) VALUES (?, ?)", now_ms(), cron)
        await self.schedule()
        return empty()

    async def state(self) -> Response:
        wakes = self.sql.exec("SELECT count(*) AS n, max(cron) AS cron FROM wakes").one()
        return json_response(
            {
                "wakes": wakes.n,
                "last_cron": wakes.cron,
                "alarm_at": await self.ctx.storage.getAlarm(),
            }
        )

    async def schedule(self) -> None:
        if await self.ctx.storage.getAlarm() is None:
            await self.ctx.storage.setAlarm(now_ms())

    async def alarm(self, alarm_info: Any = None) -> None:
        db = await self.db()
        pending = await db.prepare(
            "SELECT event_id FROM spike_events WHERE state = 'pending' ORDER BY received_at LIMIT 2"
        ).all()
        if not pending.results:
            return
        event_id = pending.results[0].event_id
        result = await fetch_with_timeout(
            f"{var(self.env, 'GEMINI_API_BASE')}/v1beta/models/spike:generateContent",
            timeout_ms=int(var(self.env, "GEMINI_TIMEOUT_MS", "60000")),
            method="POST",
            headers={"content-type": "application/json", "x-goog-api-key": var(self.env, "GEMINI_API_KEY")},
            body=json.dumps({"event_id": event_id}),
        )
        await (
            db.prepare("UPDATE spike_events SET state = ?, upstream_status = ?, updated_at = ? WHERE event_id = ?")
            .bind(result.failure or "called", result.status, now_ms(), event_id)
            .run()
        )
        if len(pending.results) > 1:
            await self.ctx.storage.setAlarm(now_ms())

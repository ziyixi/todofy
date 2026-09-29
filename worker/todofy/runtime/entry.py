"""Worker entry module: routes by Host and hands cron ticks to the coordinator."""

import json
from typing import Any
from urllib.parse import urlsplit

from workers import Response, WorkerEntrypoint

from todofy.core.api_errors import ApiError
from todofy.runtime import hooks, owner
from todofy.runtime.config import coordinator, csv, var
from todofy.runtime.coordinator import TodofyCoordinator
from todofy.runtime.http import error

__all__ = ["Default", "TodofyCoordinator"]


class Default(WorkerEntrypoint):
    async def fetch(self, request: Any) -> Response:
        url = urlsplit(request.url)
        host = (url.hostname or "").lower()
        if host == var(self.env, "TODOFY_PUBLIC_HOST").lower():
            return await owner.handle(request, self.env, url.path)
        if host in csv(self.env, "TODOFY_HOOKS_HOSTS"):
            return await hooks.handle(request, self.env, url.path)
        return error(404, ApiError.NOT_FOUND)

    async def scheduled(self, controller: Any, env: Any = None, ctx: Any = None) -> None:
        await coordinator(self.env).fetch(
            "https://coordinator/wake", method="POST", body=json.dumps({"cron": controller.cron})
        )

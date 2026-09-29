"""Entry module of the `todofy-core` Worker: it only hosts the TodofyCoordinator Durable Object.

The core has no public routes; the TypeScript gateway (`todofy`) reaches the object
through its COORDINATOR binding (docs/gateway-contract.md).
"""

from typing import Any

from workers import Response, WorkerEntrypoint

from todofy.core.api_errors import ApiError
from todofy.runtime.coordinator import TodofyCoordinator
from todofy.runtime.http import error

__all__ = ["Default", "TodofyCoordinator"]


class Default(WorkerEntrypoint):
    async def fetch(self, request: Any) -> Response:
        return error(404, ApiError.NOT_FOUND)

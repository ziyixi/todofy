"""Entry module of the `todofy-core` Worker: it only hosts the TodofyCore Durable Object.

The core has no public routes; the TypeScript gateway (`todofy`) calls the object's
RPC methods through its COORDINATOR binding (docs/gateway-contract.md).
"""

from typing import Any

from workers import Response, WorkerEntrypoint

from todofy.runtime.coordinator import TodofyCore
from todofy.runtime.http import not_found

__all__ = ["Default", "TodofyCore"]


class Default(WorkerEntrypoint):
    async def fetch(self, request: Any) -> Response:
        return not_found()

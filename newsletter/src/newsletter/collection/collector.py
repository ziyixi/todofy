"""The collector boundary and its offline fixture implementation.

Live topic discovery runs inside the workflow DAG. The direction-at-a-time
collector only backs the offline fixture pipeline used by mock mode.
"""

import dataclasses
import pathlib
from typing import Protocol

import newsletter.collection.instructions as instructions
import newsletter.types as types


@dataclasses.dataclass(frozen=True)
class ResearchResult:
    """Validated research packets and a description of the collection result."""

    packets: list[types.Payload]
    note: str


class Collector(Protocol):
    """Collect candidate materials without owning persistence or publication."""

    async def collect(
        self,
        instruction: instructions.Instruction,
        issue_date: str,
        workspace: pathlib.Path,
    ) -> ResearchResult:
        """Research one frozen direction and issue date in an isolated job."""
        ...


class MockCollector:
    """Explicit offline test adapter. Never chosen in live mode."""

    async def collect(
        self,
        instruction: instructions.Instruction,
        issue_date: str,
        workspace: pathlib.Path,
    ) -> ResearchResult:
        """Produce clearly marked synthetic material for offline tests only."""
        return ResearchResult(
            [
                {
                    "title": "MOCK / " + instruction.id,
                    "body": "这是用于验证指令采集链路的虚构材料，不是真实新"
                    "闻或研究。",
                    "sources": [
                        {
                            "id": "fixture",
                            "title": "Synthetic test source",
                            "url": "https://example.com/synthetic",
                            "excerpt": "Synthetic test only.",
                            "access_scope": "metadata",
                            "published_at": "",
                        }
                    ],
                    "tags": ["fixture", instruction.id],
                }
            ],
            "MOCK：仅验证流程，无真实搜索。",
        )

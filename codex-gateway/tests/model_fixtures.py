"""Synthetic SDK and final-result fixtures; no credentials or model connection."""

import asyncio
import uuid
from types import SimpleNamespace

from ziyixi_proto.modelrouter.inference.v1.inference_pb import Generation, Usage

from codex_gateway.modelrouter import ModelExecutor
from codex_gateway.runtime import MODEL


class FakeTurn:
    def __init__(
        self,
        number=1,
        *,
        block=False,
        tools=(),
        usage=True,
        output="answer",
        error=None,
        counters=None,
        failure_info=None,
    ):
        self.id = f"turn-{number}"
        self.thread_id = "synthetic-thread"
        self.number = number
        self.block, self.tools, self.has_usage = block, tools, usage
        self.output, self.error, self.counters = output, error, counters
        self.failure_info = failure_info
        self.interrupted = False
        self.started = asyncio.Event()

    async def interrupt(self):
        self.interrupted = True

    async def stream(self):
        self.started.set()
        if self.block:
            await asyncio.Event().wait()
        if self.error:
            raise self.error
        if self.has_usage:
            yield SimpleNamespace(
                method="thread/tokenUsage/updated",
                payload={
                    "turnId": self.id,
                    "threadId": self.thread_id,
                    "tokenUsage": {
                        "total": self.counters
                        if self.counters is not None
                        else {
                            "inputTokens": self.number * 101,
                            "outputTokens": self.number * 21,
                            "cachedInputTokens": self.number * 50,
                            "cacheWriteInputTokens": 0,
                        }
                    },
                },
            )
        for tool in self.tools:
            yield SimpleNamespace(method="item/completed", payload={"item": tool})
        if self.failure_info is not None:
            yield SimpleNamespace(
                method="turn/completed",
                payload={
                    "turn": {
                        "status": "failed",
                        "error": {
                            "message": "Synthetic private provider text https://synthetic.invalid/info",
                            "codexErrorInfo": self.failure_info,
                        },
                    }
                },
            )
            return
        yield SimpleNamespace(
            method="item/completed",
            payload={
                "item": {
                    "type": "agentMessage",
                    "phase": "final_answer",
                    "text": self.output,
                }
            },
        )
        yield SimpleNamespace(
            method="turn/completed", payload={"turn": {"status": "completed"}}
        )


class FakeSdk:
    Sandbox = SimpleNamespace(read_only="read-only")
    ApprovalMode = SimpleNamespace(deny_all="deny-all")
    CodexConfig = SimpleNamespace

    def __init__(self, *turns, account_type="chatgpt", enabled_skill=False):
        self.turns = list(turns)
        self.calls = []
        self.started = 0
        self.closed = False
        self.account_type, self.enabled_skill = account_type, enabled_skill
        self.close_started = asyncio.Event()
        self.allow_close = asyncio.Event()
        self.allow_close.set()
        self.open_started = asyncio.Event()
        self.allow_open = asyncio.Event()
        self.allow_open.set()
        self.close_raises = False
        self._client = self

    def AsyncCodex(self, config):
        self.config = config
        return self

    async def __aenter__(self):
        self.closed = False
        self.open_started.set()
        await self.allow_open.wait()
        return self

    async def close(self):
        self.close_started.set()
        await self.allow_close.wait()
        if self.close_raises:
            raise RuntimeError("Synthetic private close failure")
        self.closed = True

    async def account(self, *, refresh_token):
        assert refresh_token is False
        return SimpleNamespace(
            account=SimpleNamespace(root=SimpleNamespace(type=self.account_type))
        )

    async def request(self, method, data, *, response_model):
        assert method == "skills/list" and data["forceReload"] is True
        return SimpleNamespace(
            data=[
                SimpleNamespace(
                    cwd=data["cwds"][0],
                    errors=[],
                    skills=[SimpleNamespace(enabled=self.enabled_skill)]
                    if self.enabled_skill
                    else [],
                )
            ]
        )

    async def thread_start(self, **kwargs):
        self.started += 1
        self.thread_options = kwargs
        return SimpleNamespace(turn=self.turn)

    async def turn(self, text, **kwargs):
        self.calls.append((text, kwargs))
        return self.turns.pop(0)


class StubExecutor(ModelExecutor):
    def __init__(self, answer=None):
        super().__init__()
        self.calls = []
        self.answer = answer

    async def generate(self, request, home):
        self.calls.append((request, home))
        return self.answer or Generation(
            name=f"requests/{uuid.uuid4()}",
            model=MODEL,
            output='{"items":[]}',
            usage=Usage(
                available=True,
                billing_kind="subscription",
                input_tokens=101,
                output_tokens=23,
            ),
        )

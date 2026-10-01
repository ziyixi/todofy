"""The Python side of test/cross-language.test.ts: reads wire JSON the TypeScript codec wrote, writes it back,
and writes messages built in Python for TypeScript to read.

stdin: {"read": [{"message": "TaskIntentResult", "strict": false, "text": "<wire JSON>"}, ...]}
stdout: {"read": [{"text": "<wire JSON>", "unrecognized": [...]} | {"error": "<message>"}, ...],
         "built": [{"message": "TaskIntentResult", "text": "<wire JSON>"}, ...]}

Every text is compact JSON (``proto_test_support.compact``), the bytes the v1 contracts send and hash.
"""

import itertools
import json
import sys

from proto_test_support import compact
from ziyixi_proto.ops.v1 import ops_pb
from ziyixi_proto.prototest.v1 import prototest_pb, rules_pb
from ziyixi_proto.todofy.taskintent.v1 import task_intent_pb as pb
from ziyixi_proto.wire_json import WireJsonError, from_wire, to_wire

MESSAGES = {
    "TaskIntent": pb.TaskIntent,
    "TaskIntentRef": pb.TaskIntentRef,
    "TaskIntentResult": pb.TaskIntentResult,
    "prototest.v1.Book": prototest_pb.Book,
    "prototest.v1.BookCard": prototest_pb.BookCard,
    "prototest.v1.Parcel": rules_pb.Parcel,
    "prototest.v1.Label": rules_pb.Label,
    "prototest.v1.Note": rules_pb.Note,
    **{
        f"ops.v1.{name}": getattr(ops_pb, name)
        for name in (
            "OpsStatus",
            "GuardState",
            "SetGuardInput",
            "StartCanaryInput",
            "StartCanaryResult",
            "CanaryDelivery",
            "CanaryResult",
            "OpsReport",
            "OpsReportReceipt",
        )
    },
}


def read(request: dict) -> dict:
    try:
        result = from_wire(MESSAGES[request["message"]], json.loads(request["text"]), strict=request["strict"])
    except WireJsonError as error:
        return {"error": str(error)}
    return {
        "text": compact(to_wire(result.message, lenient=not request["strict"])),
        "unrecognized": result.unrecognized,
    }


def built() -> list[dict]:
    """Every state with every error code (and none), as Todofy's results carry them, plus Python-built inputs."""
    out = []
    for state, code in itertools.product(list(pb.State)[1:], list(pb.ErrorCode)):
        message = pb.TaskIntentResult(
            version="task-intent-v1",
            source=pb.Source.LAB,
            intent_id=f"deck-2026-09-30-g{int(state)}",
            state=state,
            recorded=state not in (pb.State.NOT_FOUND, pb.State.REJECTED),
            tasks_total=31,
            tasks_created=int(code) % 32,
            error_code=code,
            retry_after_seconds=None if code == pb.ErrorCode.UNSPECIFIED else 86400 - int(code),
            updated_at="2026-09-30T14:03:07.250Z" if int(code) % 2 else "2026-09-30T14:03:07Z",
        )
        out.append({"message": "TaskIntentResult", "text": compact(to_wire(message))})
    for mode in list(pb.Mode)[1:]:
        message = pb.TaskIntent(
            version="task-intent-v1",
            source=pb.Source.LAB,
            intent_id="deck-2026-09-30-g1",
            mode=mode,
            parent=pb.TaskIntentParent(title='论文雷达 · "合成" <示例>', description=""),
            items=(
                pb.TaskIntentItem(title="A synthetic paper", url="https://arxiv.org/abs/2609.00001"),
                pb.TaskIntentItem(title="合成标题\u2003全角", description="第一行\n第二行 \\ 反斜杠"),
            ),
        )
        out.append({"message": "TaskIntent", "text": compact(to_wire(message))})
    out.append(
        {
            "message": "TaskIntentRef",
            "text": compact(to_wire(pb.TaskIntentRef(version="task-intent-v1", source=pb.Source.LAB, intent_id="x"))),
        }
    )
    # The ops-v1 status TypeScript builds too: counters and metrics in the producer's own order (keep_order).
    status = ops_pb.OpsStatus(
        version="ops-v1",
        app="todofy",
        generated_at="2026-09-29T15:00:00Z",
        health=ops_pb.Health.DEGRADED,
        modes={"maintenance": False, "processing_paused": True, "backup_active": False},
        guard=ops_pb.GuardState(level=ops_pb.GuardLevel.NORMAL),
        signals=(
            ops_pb.Signal(
                code="gemini_budget_80",
                severity=ops_pb.Severity.WARNING,
                metrics={"percent": 82.4, "used_tokens": 2460000, "zeta": 0.0001},
            ),
        ),
        counters={"zeta": 1, "alpha": 2.5, "middle": 3865470566},
        capabilities=("canary_consumer", "guard"),
    )
    out.append({"message": "ops.v1.OpsStatus", "text": compact(to_wire(status))})
    return out


def main() -> None:
    requests = json.load(sys.stdin)
    json.dump({"read": [read(request) for request in requests["read"]], "built": built()}, sys.stdout)


if __name__ == "__main__":
    main()

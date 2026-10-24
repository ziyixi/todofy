"""Claim all pages, make one model turn, and durably report its result."""

import json
import uuid

from ziyixi_proto.mailsort.runner.v1 import mailsort_runner_service_pb as api

from mailsort_runner import classifier
from mailsort_runner.settings import EFFORT, MODEL, RunnerError, Settings
from mailsort_runner.usage import Usage


def log(**fields) -> None:
    print(json.dumps(fields, separators=(",", ":")), flush=True)


async def run(client, settings: Settings, *, classify=classifier.classify) -> int:
    run_id = str(uuid.uuid4())
    usage = Usage()
    messages = ()
    claimed = False

    def report(status, results=(), error_code=""):
        return client.report(
            api.ReportClassificationRequest(
                run_id=run_id,
                request_id=str(uuid.uuid4()),
                results=results,
                model=MODEL,
                effort=EFFORT,
                prompt_sha=classifier.PROMPT_SHA,
                input_tokens=usage.input_tokens,
                output_tokens=usage.output_tokens,
                status=status,
                error_code=error_code,
                usage_partial=usage.partial,
            )
        )

    try:
        token = ""
        seen_tokens = set()
        evaluated_at = None
        for _ in range(50):
            page = client.claim(run_id, token)
            if str(uuid.UUID(page.run_id)) != page.run_id or (claimed and page.run_id != run_id):
                raise RunnerError("claim_failed")
            run_id = page.run_id
            claimed = True
            if evaluated_at is not None and page.evaluated_at != evaluated_at:
                raise RunnerError("claim_failed")
            evaluated_at = page.evaluated_at
            messages += page.messages
            if len(messages) > 100 or len({message.message_id for message in messages}) != len(
                messages
            ):
                raise RunnerError("claim_failed")
            token = page.next_page_token
            if not token:
                break
            if token in seen_tokens:
                raise RunnerError("claim_failed")
            seen_tokens.add(token)
        else:
            raise RunnerError("claim_failed")
        log(run_id=run_id, status="running", messages=len(messages))
        if messages:
            report(api.RunStatus.RUNNING)
            results = await classify(messages, evaluated_at, settings.codex_home, usage)
        else:
            results = ()
            usage.partial = False
        accepted = report(api.RunStatus.COMPLETED, results)
        log(
            run_id=run_id,
            status="completed",
            messages=len(messages),
            accepted_count=accepted.accepted_count,
            pending_write_count=accepted.pending_write_count,
            input_tokens=usage.input_tokens,
            output_tokens=usage.output_tokens,
            usage_partial=usage.partial,
        )
        return 0
    except Exception as error:
        code = error.code if isinstance(error, RunnerError) else "runner_failed"
        if claimed:
            try:
                report(api.RunStatus.FAILED, error_code=code)
            except RunnerError:
                log(run_id=run_id, status="report_failed", error_code="report_failed")
        log(
            run_id=run_id,
            status="failed",
            error_code=code,
            messages=len(messages),
            input_tokens=usage.input_tokens,
            output_tokens=usage.output_tokens,
            usage_partial=usage.partial,
        )
        return 1

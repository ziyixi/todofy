"""One persisted pair of model routes, included in the normal D1 backup."""

import hashlib
import json
from typing import Any

from ziyixi_proto.todofy.ui.v1 import todofy_ui_service_pb as pb

from todofy.core.owner_ui import Reason, UiError
from todofy.runtime import ledger, model
from todofy.runtime.interop import now_s


def fallback_models(selected: str, *, report: bool = False) -> tuple[str, ...]:
    order = ("gemini-3.8-flash", "gemini-3.5-flash-lite") if report else ("gemini-3.5-flash-lite", "gemini-3.8-flash")
    return tuple(item for item in order if item != selected) if selected in order else ()


async def get(env: Any) -> pb.ModelSettings:
    row = await env.DB.prepare("SELECT email_model,report_model,version FROM model_settings WHERE id = 1").first()
    if row is None:
        return pb.ModelSettings(
            name="modelSettings", email_model="gemini-3.5-flash-lite", report_model="gemini-3.8-flash", etag="0"
        )
    return pb.ModelSettings(
        name="modelSettings",
        email_model=row["email_model"],
        report_model=row["report_model"],
        etag=str(row["version"]),
    )


async def catalog(env: Any) -> pb.GetModelSettingsResponse:
    choices = await model.client(env).list_models()
    return pb.GetModelSettingsResponse(settings=await get(env), models=choices.models)


async def update(env: Any, owner: str, request: pb.UpdateModelSettingsRequest) -> pb.ModelSettings:
    desired = request.settings
    if desired is None or desired.name != "modelSettings":
        raise UiError(Reason.BAD_REQUEST)
    mask = set(request.update_mask or ("email_model", "report_model"))
    if not mask or mask - {"email_model", "report_model"}:
        raise UiError(Reason.BAD_REQUEST)
    digest = hashlib.sha256(
        json.dumps([desired.email_model, desired.report_model, request.etag, sorted(mask)]).encode()
    ).hexdigest()
    claim = await ledger.find_action(env.DB, owner, request.request_id, digest)
    if claim.claim == ledger.Claim.CONFLICT:
        raise UiError(Reason.BAD_REQUEST)
    if claim.claim == ledger.Claim.REPLAY:
        return await get(env)
    current = await get(env)
    if request.etag != current.etag:
        raise UiError(Reason.ETAG_MISMATCH)
    available = {
        item.id for item in (await model.client(env).list_models()).models if item.configured and item.kind == "text"
    }
    email = desired.email_model if "email_model" in mask else current.email_model
    report = desired.report_model if "report_model" in mask else current.report_model
    if email not in available or report not in available:
        raise UiError(Reason.BAD_REQUEST)
    write = (
        env.DB.prepare(
            "INSERT INTO model_settings (id,email_model,report_model,version) VALUES (1,?,?,1) ON CONFLICT DO NOTHING"
        ).bind(email, report)
        if current.etag == "0"
        else env.DB.prepare(
            "UPDATE model_settings SET email_model = ?, report_model = ?, version = version + 1 "
            "WHERE id = 1 AND version = ?"
        ).bind(email, report, int(current.etag))
    )
    result = await env.DB.batch(
        [
            write,
            env.DB.prepare(
                "INSERT INTO owner_actions (owner,action_request_id,kind,request_hash,created_at,http_status) "
                "SELECT ?,?,'model_settings',?,?,200 WHERE changes() = 1"
            ).bind(owner, request.request_id, digest, now_s()),
        ]
    )
    if result[0].meta.changes != 1:
        raise UiError(Reason.ETAG_MISMATCH)
    return await get(env)

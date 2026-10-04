"""Generated machine HTTP bindings; authenticate before touching the lazy JSON body."""

import hmac
import os
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit

from ziyixi_proto.common.errors.v1.errors_pb import CommonReason
from ziyixi_proto.http_routes import decode_request, match_path
from ziyixi_proto.platform.runtime.v1 import runtime_service_pb as api
from ziyixi_proto.rpc_status import RpcError
from ziyixi_proto.wire_json import WireJsonError, to_wire

from .admission import Client as AdmissionClient
from .controller import Controller
from .kubernetes import DEFAULT_CA, DEFAULT_TOKEN, Client
from .resources import Renderer
from .store import Store


def _error(code, reason, message):
    return RpcError(code, reason.name, message, domain="platform.ziyixi.science")


class Router:
    def __init__(self, controller, token: str):
        self.controller, self.token = controller, token

    def authorize(self, headers):
        value = headers.get("Authorization", "")
        duplicates = (
            hasattr(headers, "getlist") and len(headers.getlist("Authorization")) != 1
        )
        if (
            not self.token
            or duplicates
            or not isinstance(value, str)
            or not hmac.compare_digest(
                value.encode("utf-8"), ("Bearer " + self.token).encode("utf-8")
            )
        ):
            raise _error(
                "UNAUTHENTICATED",
                CommonReason.UNAUTHORIZED,
                "Release machine authentication is required.",
            )

    def handle(self, method, target, headers, read_body):
        self.authorize(headers)
        parsed = urlsplit(target)
        if parsed.fragment or len(parsed.query) > 2048:
            raise _error(
                "INVALID_ARGUMENT",
                CommonReason.BAD_REQUEST,
                "The release query is invalid.",
            )
        for binding in api.HTTP_BINDINGS:
            if (
                binding.rpc
                not in {
                    "CreateRelease",
                    "GetRelease",
                    "ResumeRelease",
                    "GetReconcilePlan",
                    "ReconcileRelease",
                }
                or binding.method != method
            ):
                continue
            if match_path(binding, parsed.path) is None:
                continue
            body = read_body() if binding.method == "POST" else None
            if binding.rpc == "CreateRelease" and (
                not isinstance(body, dict) or set(body) != {"targets"}
            ):
                raise _error(
                    "INVALID_ARGUMENT",
                    CommonReason.BAD_REQUEST,
                    "Only release targets may be supplied.",
                )
            try:
                request = decode_request(
                    binding,
                    parsed.path,
                    parse_qsl(
                        parsed.query,
                        keep_blank_values=True,
                        errors="strict",
                        max_num_fields=8,
                    ),
                    body,
                )
            except (WireJsonError, ValueError):
                raise _error(
                    "INVALID_ARGUMENT",
                    CommonReason.BAD_REQUEST,
                    "The release request is invalid.",
                ) from None
            operation = {
                "CreateRelease": self.controller.create,
                "GetRelease": self.controller.get,
                "ResumeRelease": self.controller.resume,
                "GetReconcilePlan": lambda request: self.controller.plan(),
                "ReconcileRelease": self.controller.reconcile,
            }[binding.rpc]
            return 200, to_wire(operation(request))
        raise _error(
            "NOT_FOUND",
            CommonReason.NOT_FOUND,
            "The requested release resource was not found.",
        )

    def summary(self):
        return self.controller.summary()

    def plan(self):
        return self.controller.plan()

    def close(self):
        self.controller.close()


def create_router(config, read_service):
    token = os.environ.get("PLATFORM_DEPLOY_TOKEN", "")
    send_token = os.environ.get("NEWSLETTER_SEND_TOKEN", "")
    if (
        len(token) < 24
        or len(send_token) < 24
        or any(character.isspace() for character in token + send_token)
        or hmac.compare_digest(token, send_token)
    ):
        raise ValueError("invalid_machine_credentials")
    state_dir = Path(os.environ.get("PLATFORM_STATE_DIR", "/var/lib/personal-cloud"))
    if not state_dir.is_absolute():
        raise ValueError("invalid_state_directory")
    controller = Controller(
        config,
        Store(state_dir / "releases.sqlite3"),
        Client(
            config.namespace,
            token_file=os.environ.get("KUBERNETES_TOKEN_FILE", DEFAULT_TOKEN),
            ca_file=os.environ.get("KUBERNETES_CA_FILE", DEFAULT_CA),
        ),
        AdmissionClient(send_token),
        Renderer(config),
        read_service,
        process_request_id=os.environ.get("PLATFORM_RELEASE_REQUEST_ID", ""),
    )
    controller.start()
    return Router(controller, token)

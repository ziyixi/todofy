"""The runner's two machine RPCs, using generated bindings and wire types."""

import httpx
from ziyixi_proto.mailsort.runner.v1 import mailsort_runner_service_pb as api
from ziyixi_proto.wire_json import WireJsonError, from_wire, to_wire

from mailsort_runner.settings import RunnerError, Settings


class Client:
    def __init__(self, settings: Settings, *, transport=None) -> None:
        self.http = httpx.Client(
            base_url=settings.url,
            headers={"Authorization": "Bearer " + settings.token},
            timeout=90,
            follow_redirects=False,
            trust_env=False,
            transport=transport,
        )

    def close(self) -> None:
        self.http.close()

    def _call(self, rpc: str, request):
        binding = next(binding for binding in api.HTTP_BINDINGS if binding.rpc == rpc)
        try:
            response = self.http.request(
                binding.method, binding.path_template, json=to_wire(request)
            )
            if response.status_code in (401, 403):
                raise RunnerError(
                    "claim_failed" if rpc == "ClaimClassification" else "report_failed"
                )
            if response.status_code != 200:
                raise RunnerError(
                    "claim_failed" if rpc == "ClaimClassification" else "report_failed"
                )
            if len(response.content) > 512 * 1024:
                raise RunnerError(
                    "claim_failed" if rpc == "ClaimClassification" else "report_failed"
                )
            return from_wire(binding.response, response.json(), strict=True).message
        except (httpx.HTTPError, ValueError, WireJsonError):
            raise RunnerError(
                "claim_failed" if rpc == "ClaimClassification" else "report_failed"
            ) from None

    def claim(self, run_id: str, page_token: str = "") -> api.ClaimClassificationResponse:
        return self._call(
            "ClaimClassification",
            api.ClaimClassificationRequest(run_id=run_id, page_token=page_token),
        )

    def report(self, request: api.ReportClassificationRequest) -> api.ReportClassificationResponse:
        return self._call("ReportClassification", request)

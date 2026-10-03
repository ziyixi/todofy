"""AIP-193 google.rpc.Status in Google's HTTP JSON form, stdlib only.

Python twin of proto/ts/rpc-status.ts. Fixed google.rpc shapes intentionally avoid Any descriptors;
cross-runtime tests pin the code tables and bytes. Messages/reasons must be fixed safe developer text,
never provider exceptions, request parameters, private paths or credentials.
"""
from __future__ import annotations

import re

CODE = {"OK": 0, "CANCELLED": 1, "UNKNOWN": 2, "INVALID_ARGUMENT": 3,
        "DEADLINE_EXCEEDED": 4, "NOT_FOUND": 5, "ALREADY_EXISTS": 6, "PERMISSION_DENIED": 7,
        "RESOURCE_EXHAUSTED": 8, "FAILED_PRECONDITION": 9, "ABORTED": 10, "OUT_OF_RANGE": 11,
        "UNIMPLEMENTED": 12, "INTERNAL": 13, "UNAVAILABLE": 14, "DATA_LOSS": 15, "UNAUTHENTICATED": 16}
HTTP_STATUS = {"OK": 200, "CANCELLED": 499, "UNKNOWN": 500, "INVALID_ARGUMENT": 400,
               "DEADLINE_EXCEEDED": 504, "NOT_FOUND": 404, "ALREADY_EXISTS": 409,
               "PERMISSION_DENIED": 403, "RESOURCE_EXHAUSTED": 429, "FAILED_PRECONDITION": 400,
               "ABORTED": 409, "OUT_OF_RANGE": 400, "UNIMPLEMENTED": 501, "INTERNAL": 500,
               "UNAVAILABLE": 503, "DATA_LOSS": 500, "UNAUTHENTICATED": 401}


class RpcError(Exception):
    """Safe typed protocol error. HTTP 405 may override UNIMPLEMENTED's default mapping."""
    def __init__(self, code: str, reason: str, message: str, *, domain: str = "common.ziyixi.science",
                 http_status: int | None = None):
        if code not in CODE or code == "OK" or not re.fullmatch(r"[A-Z][A-Z0-9_]{0,61}[A-Z0-9]", reason):
            raise ValueError("invalid RPC error identity")
        if not re.fullmatch(r"[a-z0-9][a-z0-9.-]{0,252}\.[a-z]+", domain):
            raise ValueError("invalid RPC error domain")
        if not message or len(message) > 256 or any(ord(char) < 32 or ord(char) == 127 for char in message):
            raise ValueError("invalid RPC error message")
        if http_status is not None and http_status != 405:
            raise ValueError("unsupported RPC HTTP override")
        super().__init__(message)
        self.code, self.reason, self.domain = code, reason, domain
        self.http_status = http_status if http_status is not None else HTTP_STATUS[code]


def status_body(error: RpcError) -> dict:
    """Standard Google HTTP JSON status body; no application-specific error representation."""
    return {"error": {"code": error.http_status, "message": str(error), "status": error.code,
                      "details": [{"@type": "type.googleapis.com/google.rpc.ErrorInfo",
                                   "reason": error.reason, "domain": error.domain}]}}

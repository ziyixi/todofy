"""The closed set of HTTP error codes (OpenAPI ``ApiErrorCode``) and their UI text."""

from enum import StrEnum


class ApiError(StrEnum):
    INVALID_REQUEST = "invalid_request"
    INVALID_PAYLOAD = "invalid_payload"
    UNAUTHORIZED = "unauthorized"
    CSRF_FAILED = "csrf_failed"
    NOT_FOUND = "not_found"
    EVENT_CONFLICT = "event_conflict"
    VERSION_CONFLICT = "version_conflict"
    ACTION_NOT_ALLOWED = "action_not_allowed"
    ACTION_REQUEST_CONFLICT = "action_request_conflict"
    LENGTH_REQUIRED = "length_required"
    PAYLOAD_TOO_LARGE = "payload_too_large"
    UNSUPPORTED_MEDIA_TYPE = "unsupported_media_type"
    RATE_LIMITED = "rate_limited"
    INTERNAL_ERROR = "internal_error"
    MAINTENANCE = "maintenance"
    NOT_CONFIGURED = "not_configured"
    ACCESS_NOT_CONFIGURED = "access_not_configured"
    UNAVAILABLE = "unavailable"


MESSAGES: dict[ApiError, str] = {
    ApiError.INVALID_REQUEST: "请求参数无效",
    ApiError.INVALID_PAYLOAD: "事件内容不符合 mail.received.v1 合同",
    ApiError.UNAUTHORIZED: "未登录或凭据无效",
    ApiError.CSRF_FAILED: "页面安全令牌已失效，请刷新后重试",
    ApiError.NOT_FOUND: "找不到该资源",
    ApiError.EVENT_CONFLICT: "同一事件 ID 已收到不同内容",
    ApiError.VERSION_CONFLICT: "事件已被更新，请刷新后重试",
    ApiError.ACTION_NOT_ALLOWED: "该事件当前状态不允许此操作",
    ApiError.ACTION_REQUEST_CONFLICT: "同一操作 ID 已用于不同的请求",
    ApiError.LENGTH_REQUIRED: "请求缺少 Content-Length",
    ApiError.PAYLOAD_TOO_LARGE: "请求体超过 1 MiB",
    ApiError.UNSUPPORTED_MEDIA_TYPE: "只接受 application/json",
    ApiError.RATE_LIMITED: "请求过于频繁，请稍后再试",
    ApiError.INTERNAL_ERROR: "服务内部错误",
    ApiError.MAINTENANCE: "服务维护中，请稍后再试",
    ApiError.NOT_CONFIGURED: "服务缺少必需的密钥配置",
    ApiError.ACCESS_NOT_CONFIGURED: "Cloudflare Access 配置不完整",
    ApiError.UNAVAILABLE: "依赖服务暂时不可用，请稍后再试",
}

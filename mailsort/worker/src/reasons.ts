/**
 * The error reasons of the owner API (proto/mailsort/ui/v2/errors.proto and common/errors/v1): each reason's
 * google.rpc.Code, its developer message and its user-facing copy (the LocalizedMessage). Shared by the Worker's front
 * (authentication, CSRF: http.ts) and MailsortState's transcoder (api.ts). Exhaustive: a new ErrorReason fails the
 * typecheck until it is mapped here.
 */
import type { CommonReason } from '@ziyixi/proto/common/errors/v1/errors_pb';
import type { ErrorReason } from '@ziyixi/proto/mailsort/ui/v2/errors_pb';
import { Code, RpcError, statusBody } from '@ziyixi/proto/rpc-status';

/** ErrorInfo.domain: the API's name (MailsortUiService's default_host). */
export const API_DOMAIN = 'sort.ziyixi.science';

export type Reason = Exclude<keyof typeof ErrorReason | keyof typeof CommonReason, 'UNSPECIFIED'>;

export const REASONS: Readonly<Record<Reason, { readonly code: Code; readonly message: string; readonly zh: string }>> = {
  MODEL_FEATURE_RETIRED: { code: Code.FAILED_PRECONDITION, message: 'this former model feature is retired; historical results remain readable', zh: '旧模型回放和嵌入已停用，历史结果仍可查看' },
  UNAUTHORIZED: { code: Code.UNAUTHENTICATED, message: 'no valid Cloudflare Access login for the owner', zh: '未登录或凭据无效' },
  ACCESS_NOT_CONFIGURED: { code: Code.UNAVAILABLE, message: 'the Access settings are incomplete', zh: 'Cloudflare Access 配置不完整' },
  NOT_CONFIGURED: { code: Code.UNAVAILABLE, message: 'a required secret is missing', zh: '服务缺少必需的密钥配置' },
  CSRF_FAILED: { code: Code.PERMISSION_DENIED, message: 'the CSRF token or Origin is not valid', zh: '页面安全令牌已失效，请刷新后重试' },
  BAD_REQUEST: { code: Code.INVALID_ARGUMENT, message: 'the request is not valid', zh: '请求内容不正确' },
  NOT_FOUND: { code: Code.NOT_FOUND, message: 'no such resource', zh: '找不到这一项' },
  METHOD_NOT_ALLOWED: { code: Code.UNIMPLEMENTED, message: 'this method is not allowed on this path', zh: '不支持该请求方法' },
  UNAVAILABLE: { code: Code.UNAVAILABLE, message: 'the service is unavailable; repeat the request', zh: '服务暂时不可用，请稍后再试' },
  INTERNAL: { code: Code.INTERNAL, message: 'internal error', zh: '服务出错了，请稍后刷新页面' },
  LABEL_EXISTS: { code: Code.ALREADY_EXISTS, message: 'a label holds this ID or name, or a deleted label held the ID', zh: '已有同名或同 ID 的标签（已删除标签的 ID 也不再使用）' },
  ETAG_MISMATCH: { code: Code.ABORTED, message: 'the resource changed since the etag', zh: '这一项已在别处修改，已载入最新内容' },
  INVALID_LABEL: {
    code: Code.INVALID_ARGUMENT,
    message: 'a label ID or name breaks its rules',
    zh: '标签 ID 只能用小写字母、数字和连字符（字母开头，最多 40 个字符）；名称须为单层英文，1–40 个字符，不能含斜杠',
  },
  INVALID_SETTINGS: { code: Code.INVALID_ARGUMENT, message: 'a setting is outside its range', zh: '设置超出允许范围' },
  LIMIT_REACHED: { code: Code.FAILED_PRECONDITION, message: 'the store holds the most items it may', zh: '数量已达上限' },
  ALREADY_RESOLVED: { code: Code.FAILED_PRECONDITION, message: 'the review item is resolved', zh: '这封邮件已经处理过了' },
  NOT_UNDOABLE: { code: Code.FAILED_PRECONDITION, message: 'the ledger entry cannot be undone', zh: '这条记录不能撤销（已合并的历史记录、非本应用添加、已撤销，或 Gmail 标记已改变）' },
  GMAIL_NOT_AUTHORIZED: { code: Code.FAILED_PRECONDITION, message: 'Gmail is not authorized', zh: 'Gmail 尚未授权或授权已失效' },
  GMAIL_WRITE_NOT_ALLOWED: { code: Code.FAILED_PRECONDITION, message: 'the mode or the grant does not allow Gmail writes', zh: '当前模式或授权不允许修改 Gmail' },
  DEPENDENCY_UNAVAILABLE: { code: Code.UNAVAILABLE, message: 'Gmail or Claude did not answer; repeat the request', zh: 'Gmail 或模型暂时不可用，请稍后再试' },
  RELOAD_REQUIRED: { code: Code.FAILED_PRECONDITION, message: 'mailsort was updated: reload the page', zh: '邮件分拣已更新，请刷新页面' },
  CONSOLIDATION_ACTIVE: { code: Code.FAILED_PRECONDITION, message: 'a restored, unfinished label consolidation holds these writes', zh: '恢复的数据中有未完成的旧标签整理，除设置外的修改已暂停' },
  CONSOLIDATION_NOT_BLOCKED: { code: Code.FAILED_PRECONDITION, message: 'only a blocked consolidation can resume', zh: '这次标签整理没有暂停，无需恢复' },
  REPLAY_ACTIVE: { code: Code.FAILED_PRECONDITION, message: 'a replay evaluation is already running', zh: '回放评估正在运行，请等待它完成' },
  CONSOLIDATION_PENDING_WRITES: { code: Code.FAILED_PRECONDITION, message: 'existing mail processing and Gmail writes must finish first', zh: '当前邮件处理或 Gmail 写入还未结束，请稍后重新开始整理' },
  RESTORE_ACTIVE: { code: Code.FAILED_PRECONDITION, message: 'a backup restore is running or did not finish', zh: '正在从备份恢复（或恢复未完成），其他修改已暂停' },
  RESTORE_TARGET_NOT_EMPTY: { code: Code.FAILED_PRECONDITION, message: 'a restore only loads into an empty store', zh: '只能恢复到空的存储；当前存储已有数据，未做任何修改' },
  BACKUP_NOT_RESTORABLE: { code: Code.FAILED_PRECONDITION, message: 'the backup is missing, incomplete, unreadable or newer than this release', zh: '找不到这份备份，或它不完整、无法读取、比当前版本新' },
};

export function isReason(value: string): value is Reason {
  return Object.hasOwn(REASONS, value);
}

/** An RpcError of `reason`, with typed details (the current resource of an ETAG_MISMATCH). */
export function sortError(reason: Reason, details: RpcError['details'] = []): RpcError {
  const { code, message } = REASONS[reason];
  return new RpcError(code, reason, message, { details });
}

/** The LocalizedMessage of a reason. */
export function localize(reason: string): { locale: string; message: string } | undefined {
  return isReason(reason) ? { locale: 'zh-CN', message: REASONS[reason].zh } : undefined;
}

/** A Status response for the Worker's own refusals (before MailsortState's transcoder). */
export function errorResponse(error: RpcError, requestId: string, head = false): Response {
  const body = statusBody(error, { domain: API_DOMAIN, requestId, localized: localize(error.reason) });
  const response = new Response(head ? null : JSON.stringify(body), {
    status: error.httpStatus,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });
  for (const [name, value] of Object.entries(error.headers)) response.headers.set(name, value);
  return response;
}

/**
 * What the options page says, as data (options.ts renders it with textContent only): the upload's state, the outbox,
 * the items recall refused, the last error, and the messages of a refused save.
 */
import { DAY, ERROR_REPORTED_MS, HOUR, MINUTE } from './limits.ts';
import type { SaveAnswer, Status } from './messages.ts';

export interface Row {
  readonly label: string;
  readonly value: string;
  /** Shown in the warning color. */
  readonly warn: boolean;
}

/** `刚刚`, `3 分钟前`, `2 小时前`, `5 天前`. */
export function ago(ms: number): string {
  if (ms < MINUTE) return '刚刚';
  if (ms < HOUR) return `${String(Math.floor(ms / MINUTE))} 分钟前`;
  if (ms < DAY) return `${String(Math.floor(ms / HOUR))} 小时前`;
  return `${String(Math.floor(ms / DAY))} 天前`;
}

/** `30 秒`, `5 分钟`, `3 小时`: how long until a retry. */
export function within(ms: number): string {
  if (ms < MINUTE) return `${String(Math.max(1, Math.ceil(ms / 1000)))} 秒`;
  if (ms < HOUR) return `${String(Math.ceil(ms / MINUTE))} 分钟`;
  return `${String(Math.ceil(ms / HOUR))} 小时`;
}

function uploadRow({ now, tokenSet, upload }: Status): Row {
  const row = (value: string, warn: boolean): Row => ({ label: '状态', value, warn });
  if (!tokenSet) return row('还没有令牌：先粘贴上传令牌并保存', true);
  if (upload.tokenRefused) return row('令牌无效：recall 拒绝了它，请粘贴新的令牌', true);
  const wait = upload.nextAttemptAt - now;
  if (upload.failingSince !== 0) return row(`上传失败，${wait > 0 ? `${within(wait)}后重试` : '下次检查时重试'}（从 ${ago(now - upload.failingSince)}开始）`, true);
  if (wait > 0) return row(`recall 暂停接收，${within(wait)}后继续`, false);
  return row(upload.lastUploadAt === 0 ? '还没有上传' : `最近上传 ${ago(now - upload.lastUploadAt)}`, false);
}

export function statusRows(status: Status): Row[] {
  const rows: Row[] = [uploadRow(status), { label: '待上传', value: `${String(status.queued)} 条（移除扩展会删除还没上传的记录）`, warn: false }];
  if (status.held > 0) {
    rows.push({ label: '等待', value: `${String(status.held)} 条：扩展比 recall 新，recall 更新后会自动再上传`, warn: false });
  }
  if (status.upload.rejectedCount > 0) {
    rows.push({ label: '被拒', value: `${String(status.upload.rejectedCount)} 条已丢失：扩展可能有问题`, warn: true });
  }
  const error = status.lastError;
  if (error !== null && status.now - error.at < ERROR_REPORTED_MS) {
    rows.push({ label: '最近错误', value: `${error.code}（${ago(status.now - error.at)}）`, warn: false });
  }
  rows.push({ label: '设备 ID', value: status.deviceId, warn: false });
  return rows;
}

/** The footer: the version and the build's short commit. */
export function buildLine(status: Status): string {
  return status.versionName === '' ? `版本 ${status.version}` : `版本 ${status.version} · ${status.versionName}`;
}

export const SAVE_ERRORS: Readonly<Record<Extract<SaveAnswer, { ok: false }>['error'], string>> = {
  server_invalid: '服务器要是 https 地址（只有本机可以用 http），不带路径，例如 https://recall.ziyixi.science',
  label_invalid: '设备名称要有 1 到 64 个字',
  token_invalid: '这不是 recall 的上传令牌：它以 recall_ingest_ 开头',
  token_export: '这是归档用的导出令牌：这里要粘贴上传令牌（recall_ingest_ 开头）',
};

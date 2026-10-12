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
  return row(upload.lastUploadAt === 0 ? '尚未连接服务器' : `最近连接 ${ago(now - upload.lastUploadAt)}（可能仅心跳）`, false);
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
  if (status.capabilities !== undefined) {
    rows.push({ label: '采集环境', value: `${status.mobile ? 'Orion · iOS，仅前台记录' : '桌面浏览器'}；正文读取接口${status.capabilities.script ? '已提供' : '未提供'}，截图接口${status.capabilities.screenshot ? '已提供' : '未提供'}`, warn: !status.capabilities.script });
    rows.push({ label: '当前记录', value: status.focused ? '有网页在前台记录' : '当前未识别到可记录网页（扩展设置页不采集）', warn: false });
  }
  if (status.mobile) {
    if (status.lastFocusCheckAt !== undefined) rows.push({ label: '活动检查', value: status.lastFocusCheckAt > 0 ? ago(status.now - status.lastFocusCheckAt) : '尚未检查', warn: false });
    if (status.localVisitCount !== undefined) rows.push({ label: '本地访问', value: `${String(status.localVisitCount)} 条进行中的访问（不等于待上传数）`, warn: false });
    if (status.capture === undefined || status.capture === null) rows.push({ label: '最近采样', value: '尚未采样', warn: false });
  }
  if (status.capture !== undefined && status.capture !== null) {
    const text = { saved: '正文已保存', empty: '正文为空', failed: '正文读取失败', excluded: '页面已切换或不允许采集', unchanged: '内容未变，未重复保存' }[status.capture.text];
    const image = { webp: 'WebP', jpeg: 'JPEG', failed: '失败', excluded: '排除', none: '无' }[status.capture.screenshot];
    rows.push({ label: '最近采样', value: `${ago(status.now - status.capture.at)}：${text}；截图 ${image}`, warn: status.capture.text === 'failed' || status.capture.screenshot === 'failed' });
  }
  rows.push({ label: '设备 ID' , value: status.deviceId, warn: false });
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
  token_export: '这是读取变更 feed 用的导出口令：这里要粘贴插件口令（recall_ingest_ 开头）',
};

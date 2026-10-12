/** Orion's native permission answer is separate from settings persistence and successful capture. */
const HOSTS = { origins: ['<all_urls>'] };
const GRANTED = '浏览器报告已授权；采集结果见“最近采样”。';
let everRequested = false;
let pending = false;

function show(node: HTMLElement, text: string): void {
  if (node.isConnected) node.textContent = text;
}

export function checkWebsitePermission(node: HTMLElement): void {
  const permissions = (chrome as unknown as { permissions?: Partial<typeof chrome.permissions> }).permissions;
  show(node, '正在读取浏览器报告的网页权限…');
  if (typeof permissions?.contains !== 'function') {
    show(node, '浏览器未提供网页权限检查接口；保存时仍会尝试申请。');
    return;
  }
  const timer = setTimeout(() => {
    if (!everRequested) show(node, '网页权限检查尚未收到浏览器回复；保存时仍会尝试申请。');
  }, 12_000);
  try {
    chrome.permissions.contains(HOSTS, (granted: unknown) => {
      clearTimeout(timer);
      const failed = Boolean(chrome.runtime.lastError);
      if (everRequested) return;
      show(node, failed || typeof granted !== 'boolean'
        ? '浏览器未能确认网页权限；保存时仍会尝试申请。'
        : granted ? GRANTED : '浏览器报告尚未授权；保存时会申请网页权限。');
    });
  } catch {
    clearTimeout(timer);
    if (!everRequested) show(node, '浏览器未能确认网页权限；保存时仍会尝试申请。');
  }
}

/** Called directly on the Save submit stack, before any await or background message. */
export function requestWebsitePermission(node: HTMLElement): void {
  if (pending) return;
  everRequested = true;
  const permissions = (chrome as unknown as { permissions?: Partial<typeof chrome.permissions> }).permissions;
  if (typeof permissions?.request !== 'function') {
    show(node, '浏览器未提供网页权限申请接口；设置保存会单独进行。');
    return;
  }
  pending = true;
  show(node, '正在申请网页权限；设置保存会单独进行。');
  const timer = setTimeout(() => { show(node, '网页权限申请尚未收到浏览器回复；请同时查看设置保存结果。'); }, 12_000);
  try {
    chrome.permissions.request(HOSTS, (granted: unknown) => {
      clearTimeout(timer);
      pending = false;
      show(node, Boolean(chrome.runtime.lastError) || typeof granted !== 'boolean'
        ? '浏览器的网页权限申请失败；设置保存会单独进行。'
        : granted ? GRANTED : '浏览器没有批准本次网页权限申请；设置保存会单独进行。');
    });
  } catch {
    clearTimeout(timer);
    pending = false;
    show(node, '浏览器的网页权限申请失败；设置保存会单独进行。');
  }
}

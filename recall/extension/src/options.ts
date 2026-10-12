/**
 * The options page (options.js): recall's origin, the ingest token and the device's label, the upload's state, and
 * 立即上传 and 检查更新. Every change goes through the service worker (messages.ts), which validates it; the token is
 * never shown again once saved. Text is only ever set as text.
 */
import type { Request, SaveAnswer, SaveProgress, Status, UpdateAnswer } from './messages.ts';
import { buildLine, SAVE_ERRORS, statusRows } from './options-view.ts';

const REFRESH_MS = 30_000;
const TOAST_MS = 6000;
const SAVE_TIMEOUT_MS = 12_000;
const SAVE_PHASES: Record<SaveProgress['phase'], string> = { idle: '保存回执', device: '设备信息写入', token: '口令写入', 'upload-state': '上传状态写入' };

function send(request: { readonly type: 'status' } | { readonly type: 'flush' }): Promise<Status>;
function send(request: Extract<Request, { type: 'save' }>): Promise<SaveAnswer>;
function send(request: { readonly type: 'save-progress' }): Promise<SaveProgress>;
function send(request: { readonly type: 'check-update' }): Promise<UpdateAnswer>;
function send(request: Request): Promise<unknown> {
  return chrome.runtime.sendMessage(request);
}

function byId<T extends HTMLElement>(id: string, type: new () => T): T {
  const node = document.getElementById(id);
  if (!(node instanceof type)) throw new Error(`missing #${id}`);
  return node;
}

const form = byId('settings', HTMLFormElement);
const server = byId('server', HTMLInputElement);
const token = byId('token', HTMLInputElement);
const label = byId('label', HTMLInputElement);
const formError = byId('form-error', HTMLParagraphElement);
const rows = byId('upload-status', HTMLDListElement);
const flushButton = byId('flush', HTMLButtonElement);
const updateButton = byId('check-update', HTMLButtonElement);
const toastBox = byId('toast', HTMLDivElement);
const footer = byId('build', HTMLElement);

let toastTimer: ReturnType<typeof setTimeout> | undefined;

function toast(message: string): void {
  clearTimeout(toastTimer);
  toastBox.textContent = message;
  toastBox.hidden = false;
  toastTimer = setTimeout(() => {
    toastBox.hidden = true;
  }, TOAST_MS);
}

function render(status: Status, fillForm: boolean): void {
  if (fillForm) {
    server.value = status.server;
    label.value = status.label;
  }
  token.placeholder = status.tokenSet ? '已保存（留空保持不变）' : 'recall_ingest_…';
  rows.replaceChildren(
    ...statusRows(status).flatMap((row) => {
      const term = document.createElement('dt');
      term.textContent = row.label;
      const detail = document.createElement('dd');
      detail.textContent = row.value;
      if (row.warn) detail.className = 'warn';
      return [term, detail];
    }),
  );
  updateButton.hidden = status.mobile === true;
  footer.textContent = buildLine(status);
}

async function refresh(fillForm = false): Promise<void> {
  render(await send({ type: 'status' }), fillForm);
}

/** Runs a button's action with the button disabled; a failure is a toast. */
async function busy(button: HTMLButtonElement, action: () => Promise<void>): Promise<void> {
  button.disabled = true;
  try {
    await action();
  } catch {
    toast('扩展没有响应，请稍后再试');
  } finally {
    button.disabled = false;
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (submit === null) return;
  formError.hidden = true;
  submit.textContent = '保存中…';
  void busy(submit, async () => {
    let waitingFor = '后台响应';
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const progressTimer = setTimeout(() => {
      send({ type: 'save-progress' }).then((progress) => { waitingFor = SAVE_PHASES[progress.phase]; }).catch(() => undefined);
    }, 2000);
    try {
      const answer = await Promise.race([
        send({ type: 'save', server: server.value, label: label.value, token: token.value }),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => { reject(new Error('save_unconfirmed')); }, SAVE_TIMEOUT_MS);
        }),
      ]);
      formError.hidden = answer.ok;
      if (!answer.ok) {
        formError.textContent = SAVE_ERRORS[answer.error];
        return;
      }
      token.value = '';
      token.placeholder = '已保存（留空保持不变）';
      toast('已保存');
      // Refreshing status must not hold the Save button after persistence has been confirmed.
      refresh(true).catch(() => undefined);
    } catch {
      formError.hidden = false;
      formError.textContent = `保存尚未确认：仍在等待${waitingFor}。请重新打开设置检查；输入框里的口令暂时保留，不用重新生成。`;
    } finally {
      clearTimeout(progressTimer);
      clearTimeout(timeout);
    }
  }).finally(() => { submit.textContent = '保存'; });
});

flushButton.addEventListener('click', () => {
  void busy(flushButton, async () => {
    render(await send({ type: 'flush' }), false);
  });
});

updateButton.addEventListener('click', () => {
  void busy(updateButton, async () => {
    const answer = await send({ type: 'check-update' });
    // A reload closes this page.
    toast(answer.reloading ? '正在更新…' : '已是最新：扩展文件夹里没有更新的版本');
  });
});

refresh(true).catch(() => {
  toast('扩展没有响应，请稍后再试');
});
setInterval(() => {
  refresh().catch(() => undefined);
}, REFRESH_MS);

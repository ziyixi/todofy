// Actual built Orion background + options in isolated WebKit, using native IndexedDB.
// Only the browser extension bridge is synthetic; there is no owner profile or network upload.
/* global window, document, indexedDB */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** `folder` contains already-built extension/ and orion/ artifacts; pass existing Playwright exports. */
export async function checkOrionOptions({ webkit, expect, folder }) {
  const token = 'recall_ingest_' + 'A'.repeat(43);
  const manifest = JSON.parse(await readFile(join(folder, 'orion/manifest.json'), 'utf8'));
  const fixture = String.raw`
const shared = parent.__test;
const event = (name) => ({
  addListener(fn) {
    (shared.listeners[name] ??= []).push(fn);
  },
});
const area = {
  get(key) {
    return Promise.resolve(shared.local[key] === undefined ? {} : { [key]: structuredClone(shared.local[key]) });
  },
  set(items) {
    if (shared.stallStorage && items.device) {
      shared.storageStalled = true;
      return new Promise(() => {});
    }
    Object.assign(shared.local, structuredClone(items));
    return Promise.resolve();
  },
};
window.chrome = {
  runtime: {
    id: 'synthetic-recall-extension',
    getManifest: () => shared.manifest,
    getURL: (path) => location.origin + '/' + path,
    onStartup: event('startup'),
    onInstalled: event('installed'),
    onMessage: event('message'),
    reload() {},
    openOptionsPage: () => Promise.resolve(),
    sendMessage(request) {
      if (request.type === 'status') {
        shared.statusRequests++;
        if (shared.stallRefresh && shared.statusRequests > 1) return new Promise(() => {});
      }
      return new Promise((resolve) => {
        const listener = shared.listeners.message?.[0];
        if (!listener) throw Error('background_not_ready');
        listener(request, { id: 'synthetic-recall-extension' }, resolve);
      });
    },
  },
  storage: { local: area },
  tabs: {
    onActivated: event('activated'),
    onUpdated: event('updated'),
    onRemoved: event('removed'),
    query(query, callback) {
      shared.calls.query++;
      if (shared.stallQuery) {
        shared.queryStalled = true;
        return undefined;
      }
      queueMicrotask(() =>
        callback([
          { id: 1, windowId: 1, active: true, incognito: false, url: 'https://example.org/', title: 'Synthetic page' },
        ]),
      );
      return undefined;
    },
    get(id, callback) {
      shared.calls.get++;
      queueMicrotask(() =>
        callback({
          id,
          windowId: 1,
          active: true,
          incognito: false,
          url: 'https://example.org/',
          title: 'Synthetic page',
        }),
      );
      return undefined;
    },
    executeScript(id, details, callback) {
      shared.calls.execute++;
      queueMicrotask(() =>
        callback([{ documentId: 'synthetic-document', visible: true, url: 'https://example.org/' }]),
      );
      return undefined;
    },
    captureVisibleTab(options, callback) {
      queueMicrotask(() => callback('data:image/png;base64,synthetic'));
      return undefined;
    },
  },
  alarms: { get: () => Promise.resolve(undefined), create: () => Promise.resolve(), onAlarm: event('alarm') },
  browserAction: {
    onClicked: event('clicked'),
    setBadgeText: () => Promise.resolve(),
    setBadgeBackgroundColor: () => Promise.resolve(),
    setTitle: () => Promise.resolve(),
  },
};
if (location.pathname === '/background.html') {
  window.fetch = () => new Promise(() => {});
  shared.emit = (name, ...args) => {
    for (const listener of shared.listeners[name] ?? []) listener(...args);
  };
}
`;
  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      if (path === '/fixture.js') {
        res.setHeader('content-type', 'text/javascript');
        res.end(fixture);
        return;
      }
      if (path === '/harness.html') {
        res.setHeader('content-type', 'text/html');
        res.end(
          `<!doctype html><body><script>window.__test={manifest:${JSON.stringify(manifest)},local:{},listeners:{},calls:{query:0,get:0,execute:0},statusRequests:0};</script></body>`,
        );
        return;
      }
      if (path === '/background.html') {
        res.setHeader('content-type', 'text/html');
        res.end('<!doctype html><script src="fixture.js"></script><script src="sw.js"></script>');
        return;
      }
      if (path === '/options.html') {
        res.setHeader('content-type', 'text/html');
        const html = await readFile(join(folder, 'orion/options.html'), 'utf8');
        res.end(
          html.replace(
            '<script type="module" src="options.js">',
            '<script src="fixture.js"></script><script type="module" src="options.js">',
          ),
        );
        return;
      }
      const file = path.slice(1);
      if (!['sw.js', 'options.js', 'options.css'].includes(file)) {
        res.statusCode = 404;
        res.end();
        return;
      }
      res.setHeader('content-type', file.endsWith('.css') ? 'text/css' : 'text/javascript');
      res.end(await readFile(join(folder, 'orion', file)));
    } catch (e) {
      res.statusCode = 500;
      res.end(String(e));
    }
  });
  const browser = await webkit.launch({ headless: true });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const results = [];
  async function start() {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(base + '/harness.html');
    await page.evaluate(() => {
      const frame = document.createElement('iframe');
      frame.id = 'background';
      frame.src = '/background.html';
      document.body.append(frame);
    });
    await page.waitForFunction(() => window.__test.listeners.message?.length === 1);
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          window.__test.listeners.message[0]({ type: 'status' }, { id: 'synthetic-recall-extension' }, resolve),
        ),
    );
    await page.evaluate(() => {
      const frame = document.createElement('iframe');
      frame.id = 'options';
      frame.src = '/options.html';
      frame.style = 'width:390px;height:1000px;border:0';
      document.body.append(frame);
    });
    const options = page.frameLocator('#options');
    await expect(options.locator('#server')).toHaveValue('https://recall.ziyixi.science');
    await expect(options.locator('#label')).toHaveValue('iPhone · Orion');
    await expect(options.locator('#upload-status')).toContainText('Orion · iOS');
    return { context, page, options, errors };
  }
  async function storedToken(page) {
    return page.evaluate(
      () =>
        new Promise((resolve, reject) => {
          const request = indexedDB.open('recall');
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const db = request.result;
            const tx = db.transaction('kv', 'readonly');
            const get = tx.objectStore('kv').get('token');
            get.onerror = () => reject(get.error);
            get.onsuccess = () => resolve(get.result?.value === 'recall_ingest_' + 'A'.repeat(43));
            tx.oncomplete = () => db.close();
          };
        }),
    );
  }
  async function fillAndSave(h) {
    await h.options.locator('#token').fill(token);
    await h.options.locator('#label').fill('iPhone test');
    await h.options.locator('button[type=submit]').click();
  }
  try {
    {
      const h = await start();
      await h.page.evaluate(() => window.__test.emit('activated', { tabId: 1, windowId: 1 }));
      await h.page.waitForFunction(() => window.__test.calls.execute > 0);
      await fillAndSave(h);
      await expect(h.options.locator('#toast')).toHaveText('已保存');
      await expect(h.options.locator('button[type=submit]')).toBeEnabled();
      await expect(h.options.locator('button[type=submit]')).toHaveText('保存');
      await expect(h.options.locator('#token')).toHaveValue('');
      if (!(await storedToken(h.page))) throw Error('native_webkit_idb_token_missing');
      expect(h.errors).toEqual([]);
      results.push({
        case: 'callback-only mobile tabs + native WebKit IndexedDB',
        passed: true,
        calls: await h.page.evaluate(() => window.__test.calls),
        errors: h.errors,
      });
      await h.context.close();
    }
    {
      const h = await start();
      await h.page.evaluate(() => {
        window.__test.stallQuery = true;
        window.__test.emit('activated', { tabId: 1, windowId: 1 });
      });
      await h.page.waitForFunction(() => window.__test.queryStalled);
      await fillAndSave(h);
      await expect(h.options.locator('#toast')).toHaveText('已保存');
      await expect(h.options.locator('button[type=submit]')).toBeEnabled();
      if (!(await storedToken(h.page))) throw Error('blocked_focus_prevented_save');
      expect(h.errors).toEqual([]);
      results.push({ case: 'unanswered tabs.query does not block Save', passed: true, errors: h.errors });
      await h.context.close();
    }
    {
      const h = await start();
      await h.page.clock.install();
      await h.page.evaluate(() => {
        window.__test.stallStorage = true;
      });
      await fillAndSave(h);
      await h.page.waitForFunction(() => window.__test.storageStalled);
      await expect(h.options.locator('button[type=submit]')).toHaveText('保存中…');
      await h.page.clock.fastForward(2200);
      await h.page.clock.fastForward(10000);
      await expect(h.options.locator('#form-error')).toContainText('保存尚未确认：仍在等待设备信息写入');
      await expect(h.options.locator('button[type=submit]')).toHaveText('保存');
      await expect(h.options.locator('button[type=submit]')).toBeEnabled();
      await expect(h.options.locator('#token')).toHaveValue(token);
      expect(h.errors).toEqual([]);
      results.push({
        case: 'stalled storage produces bounded phase-specific UI and retains input',
        passed: true,
        errors: h.errors,
      });
      await h.context.close();
    }
    {
      const h = await start();
      await h.page.evaluate(() => {
        window.__test.stallRefresh = true;
      });
      await fillAndSave(h);
      await h.page.waitForFunction(() => window.__test.statusRequests > 1);
      await expect(h.options.locator('#toast')).toHaveText('已保存');
      await expect(h.options.locator('button[type=submit]')).toBeEnabled();
      await expect(h.options.locator('button[type=submit]')).toHaveText('保存');
      if (!(await storedToken(h.page))) throw Error('refresh_stall_token_missing');
      expect(h.errors).toEqual([]);
      results.push({ case: 'unanswered success refresh does not hold Save button', passed: true, errors: h.errors });
      await h.page.screenshot({ path: join(folder, 'options-webkit.png'), fullPage: true });
      await h.context.close();
    }
    return { engine: 'WebKit; synthetic MV2 API bridge; native IndexedDB', results };
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

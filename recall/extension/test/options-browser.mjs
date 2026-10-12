// Actual built Orion background + options in isolated WebKit, using native IndexedDB.
// Uploads are intercepted by a local fake consumer; no production network or owner profile is used.
/* global document, indexedDB, location, window */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { fixtureScript } from './options-browser-fixture.mjs';

/** `folder` contains already-built extension/ and orion/ artifacts; pass existing Playwright exports. */
export async function checkOrionOptions({ webkit, expect, folder }) {
  const token = 'recall_ingest_' + 'A'.repeat(43);
  const diagnosticUrl = 'https://example.org/?recall-diagnostic=1';
  const manifest = JSON.parse(await readFile(join(folder, 'orion/manifest.json'), 'utf8'));
  const fixture = fixtureScript(manifest);
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
          '<!doctype html><body><script>window.__test={local:{},listeners:{},calls:{query:0,get:0,execute:0},visibility:[],statusRequests:0};</script></body>',
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
      if (path === '/article.html') {
        res.setHeader('content-type', 'text/html');
        res.end(
          '<!doctype html><html><head><title>Actual DOM capture test</title><meta name="description" content="Synthetic description"></head><body style="background:#8ecae6;padding:20px;font:20px system-ui"><h1>Synthetic article title</h1><p id="article">Actual visible DOM text from the published capture script.</p><script src="fixture.js"></script></body></html>',
        );
        return;
      }
      if (path === '/blank.html') {
        res.setHeader('content-type', 'text/html');
        res.end('<!doctype html><title>Previous article left the foreground</title>');
        return;
      }
      const file = path.slice(1);
      if (!['sw.js', 'options.js', 'options.css', 'probe.js', 'capture.js'].includes(file)) {
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
  // Launch first: a browser startup failure must not leave the HTTP listener running.
  const browser = await webkit.launch({ headless: true });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const results = [];
  async function start(permissionCase = {}) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    await page.clock.install({ time: new Date('2026-10-12T00:00:00Z') });
    const batches = [];
    const completions = [];
    const responses = [];
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await context.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.href === diagnosticUrl) {
        await route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><title>Synthetic diagnostic page</title></head><body><h1>Synthetic diagnostic page</h1><p id="article">Synthetic public page for capture diagnostics.</p><script>${fixture}</script></body></html>` });
        return;
      }
      if (url.origin === base) {
        await route.continue();
        return;
      }
      // This URL is intercepted locally, never contacted. Reject every other remote request.
      if (url.href !== 'https://recall.ziyixi.science/api/machine/v1/batches') {
        await route.abort();
        throw Error('unexpected_remote_request');
      }
      const cors = {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'authorization,content-type',
        'access-control-allow-methods': 'POST',
      };
      if (route.request().method() === 'OPTIONS') {
        await route.fulfill({ status: 204, headers: cors });
        return;
      }
      const body = route.request().postDataBuffer();
      if (!body) throw Error('missing_gzip_body');
      const batch = JSON.parse(gunzipSync(body).toString('utf8'));
      batches.push(batch);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: cors,
        body: JSON.stringify({
          accepted_count: batch.items.length,
          rejected: [],
          denylist_patterns: [],
          denylist_etag: 'synthetic-e1',
        }),
      });
    });
    await page.goto(base + '/harness.html');
    await page.evaluate((value) => { window.__test.permissionCase = value; }, permissionCase);
    await page.evaluate(() => {
      const frame = document.createElement('iframe');
      frame.id = 'background';
      frame.hidden = true;
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
    // A real top-level page exercises the script's top-frame guard and native pagehide navigation.
    const article = await context.newPage();
    article.on('pageerror', (error) => errors.push(error.message));
    await article.exposeFunction('sendToBackground', async (request) =>
      page.evaluate(
        (request) =>
          new Promise((resolve) => {
            if (request.type === 'page-visibility') window.__test.visibility.push(request.visible);
            const listener = window.__test.listeners.message[0];
            const sender = { id: 'synthetic-recall-extension', frameId: 0, tab: window.__test.tab };
            if (listener(request, sender, resolve) !== true) resolve();
          }),
        request,
      ),
    );
    await page.exposeFunction('sendToContent', async (request) => {
      const sender = await page.evaluate(() => window.__test.omitSenderIdentity ? {} : { id: 'synthetic-recall-extension' });
      const value = await article.evaluate(
        ({ request, sender }) =>
          new Promise((resolve) => {
            const listener = window.__test.listeners.message?.[0];
            if (!listener) throw Error('content_listener_not_installed');
            if (listener(request, sender, resolve) !== true) resolve();
          }),
        { request, sender },
      );
      responses.push({ type: request.type, value });
      return value;
    });
    await article.goto(base + '/article.html');
    await article.waitForSelector('#article');
    await page.exposeFunction('executePublishedFile', async (file) => {
      const source = await readFile(join(folder, 'orion', file), 'utf8');
      const value = await article.evaluate(source);
      completions.push({ file, value });
      return value;
    });
    await page.exposeFunction('capturePublishedPage', async () => {
      const png = await article.screenshot({ type: 'png' });
      return 'data:image/png;base64,' + png.toString('base64');
    });
    await page.exposeFunction('openDiagnosticPage', async (url) => {
      if (url !== diagnosticUrl) throw Error('unexpected_diagnostic_page');
      await article.goto(url);
    });
    await page.evaluate(() => {
      window.__test.executeFile = window.executePublishedFile;
      window.__test.captureVisibleTab = window.capturePublishedPage;
      window.__test.openTestPage = window.openDiagnosticPage;
      window.__test.tab = {
        id: 1,
        windowId: 1,
        active: true,
        incognito: false,
        url: location.origin + '/article.html',
        title: 'Actual DOM capture test',
      };
    });
    const options = page.frameLocator('#options');
    await expect(options.locator('#server')).toHaveValue('https://recall.ziyixi.science');
    await expect(options.locator('#label')).toHaveValue('iPhone · Orion');
    await expect(options.locator('#upload-status')).toContainText('Orion · iOS');
    return { context, page, article, options, errors, batches, completions, responses };
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

  async function getStatus(h) {
    return h.page.evaluate(
      () =>
        new Promise((resolve) =>
          window.__test.listeners.message[0]({ type: 'status' }, { id: 'synthetic-recall-extension' }, resolve),
        ),
    );
  }
  async function getDiagnostic(h) {
    return h.page.evaluate(() => new Promise((resolve) => window.__test.listeners.message[0](
      { type: 'diagnostic-status' }, { id: 'synthetic-recall-extension' }, resolve,
    ))).then((answer) => answer.diagnostic);
  }
  async function captureCase(waitForMinute) {
    const h = await start();
    await fillAndSave(h);
    await h.page.waitForFunction(() => window.__test.local.upload?.lastUploadAt > 0);
    await h.article.bringToFront();
    await h.page.evaluate(() => {
      window.__test.injectWhileLoading = true;
      window.__test.emit('activated', { tabId: 1, windowId: 1 });
    });
    await h.page.waitForFunction(() => window.__test.loadingRefusal);
    await h.page.evaluate(() => {
      window.__test.injectWhileLoading = false;
    });
    if (waitForMinute) {
      await h.page.clock.fastForward(60000);
    } else {
      await h.page.evaluate(() => window.__test.emit('updated', 1, { status: 'complete' }));
    }
    await expect
      .poll(async () => {
        const status = await getStatus(h);
        return status.focused ? 'focused' : 'not_focused:' + (status.lastError?.code ?? 'none');
      })
      .toBe('focused');
    await h.article.locator('#article').evaluate((element) => {
      element.textContent += ' Fresh DOM after listener installation.';
    });
    await h.page.clock.fastForward(11000);
    await expect.poll(() => h.page.evaluate(() => window.__test.local.capture_status)).toMatchObject({ text: 'saved' });
    if (!waitForMinute) {
      const queued = await h.page.evaluate(
        () =>
          new Promise((resolve) => {
            const request = indexedDB.open('recall');
            request.onsuccess = () => {
              const db = request.result;
              const tx = db.transaction('outbox', 'readonly');
              const get = tx.objectStore('outbox').getAll();
              get.onsuccess = () => resolve(get.result.map((row) => JSON.parse(row.json)));
              tx.oncomplete = () => db.close();
            };
          }),
      );
      expect(queued.find((item) => item.kind === 'document')?.document.text).toContain('Actual visible DOM text');
    }
    await h.page.clock.fastForward(51000);
    await expect
      .poll(() => h.batches.flatMap((batch) => batch.items).filter((item) => item.kind === 'document').length)
      .toBe(1);
    await expect
      .poll(() => h.page.evaluate(() => window.__test.local.capture_status))
      .toMatchObject({ text: 'unchanged' });
    const document = h.batches.flatMap((batch) => batch.items).find((item) => item.kind === 'document').document;
    expect(document.text).toContain('Actual visible DOM text from the published capture script.');
    expect(document.title).toBe('Actual DOM capture test');
    expect(document.screenshot_width).toBeGreaterThan(0);
    expect(document.screenshot_jpeg_base64 || document.screenshot_webp_base64).toBeTruthy();
    expect(document.text).toContain('Fresh DOM after listener installation.');
    expect(h.completions.length).toBeGreaterThan(0);
    expect(h.completions.every(({ file }) => file === 'probe.js')).toBe(true);
    expect(h.responses.some(({ type, value }) => type === 'recall-probe' && value.visible && value.documentId)).toBe(
      true,
    );
    expect(
      h.responses.some(
        ({ type, value }) => type === 'recall-capture' && value.build === manifest.version && value.visible,
      ),
    ).toBe(true);
    expect(await h.article.evaluate(() => window.__test.listeners.message.length)).toBe(1);
    const nativeBoundary = await h.page.evaluate(() => ({
      completionDiscarded: window.__test.discardedCompletions > 0,
      defaultTopFrame: window.__test.injectionKeys.every((keys) => !keys.includes('frameId')),
      messageRequests: [...new Set(window.__test.pageRequests)],
    }));
    expect(nativeBoundary.completionDiscarded).toBe(true);
    expect(nativeBoundary.defaultTopFrame).toBe(true);
    expect(nativeBoundary.messageRequests).toEqual(expect.arrayContaining(['recall-probe', 'recall-capture']));
    await h.page.evaluate(() => {
      window.__test.tab.active = false;
    });
    await h.article.goto(base + '/blank.html');
    await h.page.waitForFunction(() => window.__test.visibility.includes(false));
    await expect.poll(() => getStatus(h)).toMatchObject({ focused: false });
    await h.page.clock.fastForward(61000);
    await expect
      .poll(() => h.batches.flatMap((batch) => batch.items).filter((item) => item.kind === 'visit').length)
      .toBe(1);
    expect(h.batches.flatMap((batch) => batch.items).filter((item) => item.kind === 'document')).toHaveLength(1);
    expect(h.errors).toEqual([]);
    results.push({
      case: waitForMinute
        ? 'automatic minute alarm recovers a missed load event'
        : 'load complete recovers initial injection refusal',
      passed: true,
      documents: 1,
      visits: 1,
      screenshotFormat: document.screenshot_jpeg_base64 ? 'jpeg' : 'webp',
      ...nativeBoundary,
    });
    await h.context.close();
  }
  try {
    {
      const h = await start();
      await h.page.evaluate(() => window.__test.emit('activated', { tabId: 1, windowId: 1 }));
      await h.page.waitForFunction(() => window.__test.calls.execute > 0);
      await fillAndSave(h);
      await expect(h.options.locator('#toast')).toHaveText('已保存');
      await expect(h.options.locator('button[type=submit]')).toBeEnabled();
      await expect(h.options.locator('button[type=submit]')).toHaveText('保存并申请网页权限');
      await expect(h.options.locator('#permission-status')).toHaveText('浏览器报告已授权；采集结果见“最近采样”。');
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
      await h.page.evaluate(() => {
        window.__test.stallStorage = true;
      });
      await fillAndSave(h);
      await h.page.waitForFunction(() => window.__test.storageStalled);
      await expect(h.options.locator('button[type=submit]')).toHaveText('保存中…');
      await h.page.clock.fastForward(2200);
      await h.page.clock.fastForward(10000);
      await expect(h.options.locator('#form-error')).toContainText('保存尚未确认：仍在等待设备信息写入');
      await expect(h.options.locator('button[type=submit]')).toHaveText('保存并申请网页权限');
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
      await expect(h.options.locator('button[type=submit]')).toHaveText('保存并申请网页权限');
      if (!(await storedToken(h.page))) throw Error('refresh_stall_token_missing');
      expect(h.errors).toEqual([]);
      results.push({ case: 'unanswered success refresh does not hold Save button', passed: true, errors: h.errors });
      await h.page.screenshot({ path: join(folder, 'options-webkit.png'), fullPage: true });
      await h.context.close();
    }
    {
      const h = await start({ initial: 'pending', request: false });
      await h.page.waitForFunction(() => typeof window.__test.answerInitialPermission === 'function');
      await h.page.clock.fastForward(12010);
      await expect(h.options.locator('#permission-status')).toHaveText('网页权限检查尚未收到浏览器回复；保存时仍会尝试申请。');
      await fillAndSave(h);
      await expect(h.options.locator('#toast')).toHaveText('已保存');
      await expect(h.options.locator('#permission-status')).toHaveText('浏览器没有批准本次网页权限申请；设置保存会单独进行。');
      await h.page.evaluate(() => window.__test.answerInitialPermission(true));
      await expect(h.options.locator('#permission-status')).toHaveText('浏览器没有批准本次网页权限申请；设置保存会单独进行。');
      expect(await h.page.evaluate(() => ({ gesture: window.__test.permissionGesture, origins: window.__test.requestedOrigins, order: window.__test.permissionOrder }))).toEqual({ gesture: true, origins: ['<all_urls>'], order: ['permission-request', 'save'] });
      expect(await storedToken(h.page)).toBe(true);
      expect(h.errors).toEqual([]);
      results.push({ case: 'Save requests permission on the submit stack; refusal and stale contains do not block persistence', passed: true });
      await h.context.close();
    }
    {
      const h = await start({ request: 'pending' });
      await fillAndSave(h);
      await expect(h.options.locator('#toast')).toHaveText('已保存');
      expect(await storedToken(h.page)).toBe(true);
      await h.page.clock.fastForward(12010);
      await expect(h.options.locator('#permission-status')).toHaveText('网页权限申请尚未收到浏览器回复；请同时查看设置保存结果。');
      await expect(h.options.locator('button[type=submit]')).toBeEnabled();
      await expect(h.options.locator('button[type=submit]')).toHaveText('保存并申请网页权限');
      await h.options.locator('button[type=submit]').click();
      await expect(h.options.locator('#toast')).toHaveText('已保存');
      expect(await h.page.evaluate(() => window.__test.permissionRequests)).toBe(1);
      await h.page.evaluate(() => window.__test.answerPermission(true));
      await expect(h.options.locator('#permission-status')).toHaveText('浏览器报告已授权；采集结果见“最近采样”。');
      expect(await storedToken(h.page)).toBe(true);
      expect(h.errors).toEqual([]);
      await h.page.screenshot({ path: join(folder, 'permission-options-webkit.png'), fullPage: true });
      results.push({ case: 'unanswered permission is bounded, does not repeat or hold Save, and accepts a late native callback', passed: true });
      await h.context.close();
    }
    {
      const h = await start({ unavailable: true });
      await expect(h.options.locator('#permission-status')).toHaveText('浏览器未提供网页权限检查接口；保存时仍会尝试申请。');
      await fillAndSave(h);
      await expect(h.options.locator('#toast')).toHaveText('已保存');
      await expect(h.options.locator('#permission-status')).toHaveText('浏览器未提供网页权限申请接口；设置保存会单独进行。');
      expect(await storedToken(h.page)).toBe(true);
      expect(h.errors).toEqual([]);
      results.push({ case: 'missing native permission namespace is explicit and does not hold Save', passed: true });
      await h.context.close();
    }
    {
      const h = await start({ request: 'error' });
      await fillAndSave(h);
      await expect(h.options.locator('#toast')).toHaveText('已保存');
      await expect(h.options.locator('#permission-status')).toHaveText('浏览器的网页权限申请失败；设置保存会单独进行。');
      expect(await storedToken(h.page)).toBe(true);
      expect(h.errors).toEqual([]);
      results.push({ case: 'native permission error is fixed copy and does not hold Save', passed: true });
      await h.context.close();
    }
    {
      const h = await start();
      await fillAndSave(h);
      await h.page.waitForFunction(() => window.__test.local.upload?.lastUploadAt > 0);
      await h.page.evaluate(() => {
        window.__test.stallQuery = true;
        return new Promise((resolve) => {
          const request = indexedDB.open('recall');
          request.onsuccess = () => {
            const db = request.result;
            const tx = db.transaction('outbox', 'readwrite');
            tx.objectStore('outbox').put({ id: '1b156876-f516-499a-8fd4-9f492ea904f0', kind: 'document', json: '{"synthetic":"not part of diagnosis"}', bytes: 38, version: 1, attempts: 0, queued: Date.now(), heldUntil: Date.now() + 600000 });
            tx.oncomplete = () => { db.close(); resolve(); };
          };
        });
      });
      await h.options.locator('#diagnostic-start').click();
      await h.page.waitForFunction(() => window.__test.queryStalled);
      await expect.poll(() => getDiagnostic(h)).toMatchObject({ state: 'running', steps: expect.arrayContaining([expect.objectContaining({ stage: 'active_tabs', state: 'pending' })]) });
      await expect(h.options.locator('#diagnostic-send')).toBeEnabled();
      await h.options.locator('#diagnostic-send').click();
      await expect(h.options.locator('#diagnostic-feedback')).toContainText('诊断已发送');
      const batch = h.batches.find((batch) => batch.diagnostic);
      expect(batch.items).toEqual([]);
      expect(batch.device.queued_count).toBe(1);
      expect(batch.diagnostic.steps).toEqual(expect.arrayContaining([
        expect.objectContaining({ stage: 'active_tabs', state: 'pending' }),
        expect.objectContaining({ stage: 'open_test_page', state: 'returned' }),
      ]));
      for (const content of [token, diagnosticUrl, 'not part of diagnosis', 'Synthetic diagnostic page']) expect(JSON.stringify(batch.diagnostic)).not.toContain(content);
      expect((await getStatus(h)).queued).toBe(1);
      await expect(h.options.locator('button[type=submit]')).toBeEnabled();
      expect(h.errors).toEqual([]);
      results.push({ case: 'hung native query still sends a bounded diagnostic, not the outbox', passed: true, stage: 'active_tabs', state: 'pending', queuedUnchanged: 1 });
      await h.context.close();
    }
    {
      const h = await start();
      await fillAndSave(h);
      await h.page.waitForFunction(() => window.__test.local.upload?.lastUploadAt > 0);
      await h.page.evaluate(() => { window.__test.omitSenderIdentity = true; });
      await h.options.locator('#diagnostic-start').click();
      await expect.poll(() => h.page.evaluate(() => window.__test.createdUrl)).toBe(diagnosticUrl);
      await expect.poll(() => getStatus(h)).toMatchObject({ focused: true });
      await h.page.clock.fastForward(11000);
      await expect.poll(() => h.page.evaluate(() => window.__test.local.capture_status)).toMatchObject({ text: 'saved' });
      await h.page.clock.fastForward(60000);
      await expect.poll(() => getDiagnostic(h)).toMatchObject({ alarmEvents: 1 });
      await expect.poll(() => getDiagnostic(h)).toMatchObject({ steps: expect.arrayContaining([expect.objectContaining({ stage: 'capture_store', state: 'returned' })]) });
      await h.options.locator('#diagnostic-send').click();
      await expect(h.options.locator('#diagnostic-feedback')).toContainText('诊断已发送');
      const report = h.batches.find((batch) => batch.diagnostic).diagnostic;
      expect(report.steps).toEqual(expect.arrayContaining([
        expect.objectContaining({ stage: 'probe_context', state: 'returned', sender_identity: 'missing' }),
        expect.objectContaining({ stage: 'capture_store', state: 'returned' }),
      ]));
      expect(report.alarm_event_count).toBe(1);
      expect(report.tab_event_count).toBeGreaterThan(0);
      expect(JSON.stringify(report)).not.toContain(token);
      expect(h.errors).toEqual([]);
      await h.page.screenshot({ path: join(folder, 'diagnostic-options-webkit.png'), fullPage: true });
      results.push({ case: 'null alarm and omitted sender ID are observable in sent diagnostic', passed: true, alarmEvents: 1, senderIdentity: 'missing' });
      await h.context.close();
    }
    await captureCase(false);
    await captureCase(true);
    return {
      version: manifest.version,
      sha: manifest.version_name,
      engine: 'WebKit; synthetic MV2 API bridge; native IndexedDB',
      results,
    };
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

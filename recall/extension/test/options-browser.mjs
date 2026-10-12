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
  async function start() {
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
      const value = await article.evaluate(
        (request) =>
          new Promise((resolve) => {
            const listener = window.__test.listeners.message?.[0];
            if (!listener) throw Error('content_listener_not_installed');
            if (listener(request, { id: 'synthetic-recall-extension' }, resolve) !== true) resolve();
          }),
        request,
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
    await page.evaluate(() => {
      window.__test.executeFile = window.executePublishedFile;
      window.__test.captureVisibleTab = window.capturePublishedPage;
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
    await expect.poll(() => getStatus(h)).toMatchObject({ focused: true });
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
      messageRequests: [...new Set(window.__test.pageRequests)],
    }));
    expect(nativeBoundary.completionDiscarded).toBe(true);
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

// Synthetic extension API bridge; actual scripts use native IndexedDB, canvas and gzip.
// chrome.storage.local is an in-memory test store; no owner data or credentials are used.
export function fixtureScript(manifest) {
  return `
/* global parent, window, location, queueMicrotask, setInterval, structuredClone */
const contentPage = location.pathname === '/article.html' || location.href === 'https://example.org/?recall-diagnostic=1';
const shared = contentPage ? (window.__test = { local: {}, listeners: {} }) : parent.__test;
const event = (name) => ({
  addListener(fn) {
    (shared.listeners[name] ??= []).push(fn);
  },
  removeListener(fn) {
    shared.listeners[name] = (shared.listeners[name] ?? []).filter((listener) => listener !== fn);
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
    getManifest: () => (${JSON.stringify(manifest)}),
    getURL: (path) => location.origin + '/' + path,
    onStartup: event('startup'),
    onInstalled: event('installed'),
    onMessage: event('message'),
    reload() {},
    openOptionsPage: () => Promise.resolve(),
    sendMessage(request, callback) {
      if (contentPage) {
        window.sendToBackground(request).then(() => callback?.());
        return undefined;
      }
      if (request.type === 'status') {
        shared.statusRequests++;
        if (shared.stallRefresh && shared.statusRequests > 1) return new Promise(() => {});
      }
      if (request.type === 'save') (shared.permissionOrder ??= []).push('save');
      return new Promise((resolve) => {
        const listener = shared.listeners.message?.[0];
        if (!listener) throw Error('background_not_ready');
        const keep = listener(request, { id: 'synthetic-recall-extension' }, resolve);
        if (keep !== true) resolve();
      });
    },
  },
  storage: { local: area },
  permissions: {
    contains(details, callback) {
      if (shared.permissionCase?.initial === 'pending') {
        shared.answerInitialPermission = callback;
        return undefined;
      }
      queueMicrotask(() => callback(false));
      return undefined;
    },
    request(details, callback) {
      shared.permissionRequests = (shared.permissionRequests ?? 0) + 1;
      shared.permissionGesture = shared.submitEvent?.isTrusted === true && shared.submitEvent.eventPhase !== 0;
      shared.requestedOrigins = details.origins;
      (shared.permissionOrder ??= []).push('permission-request');
      shared.answerPermission = callback;
      const result = shared.permissionCase?.request ?? true;
      if (result === 'pending') return undefined;
      queueMicrotask(() => {
        if (result === 'error') window.chrome.runtime.lastError = { message: 'synthetic_permission_error' };
        callback(result === 'error' ? undefined : result);
        delete window.chrome.runtime.lastError;
      });
      return undefined;
    },
  },
  tabs: {
    onActivated: event('activated'),
    onUpdated: event('updated'),
    onRemoved: event('removed'),
    create(details, callback) {
      shared.createdUrl = details.url;
      shared.tab = { ...shared.tab, url: details.url, active: true };
      shared.openTestPage(details.url).then(() => {
        callback(shared.tab);
        shared.emit('activated', { tabId: shared.tab.id, windowId: shared.tab.windowId });
        shared.emit('updated', shared.tab.id, { status: 'complete' });
      });
      return undefined;
    },
    query(query, callback) {
      shared.calls.query++;
      if (shared.stallQuery) {
        shared.queryStalled = true;
        return undefined;
      }
      queueMicrotask(() => callback(shared.tab?.active ? [shared.tab] : []));
      return undefined;
    },
    get(id, callback) {
      shared.calls.get++;
      queueMicrotask(() => callback(shared.tab));
      return undefined;
    },
    executeScript(id, details, callback) {
      shared.calls.execute++;
      (shared.injectionKeys ??= []).push(Object.keys(details));
      if (shared.injectWhileLoading) {
        shared.loadingRefusal = true;
        window.chrome.runtime.lastError = { message: 'Cannot access page while loading' };
        callback(undefined);
        delete window.chrome.runtime.lastError;
        return undefined;
      }
      shared.executeFile(details.file).then(
        () => {
          // Deliberately discard completion: Orion's observed response was unusable, its exact shape is unknown.
          shared.discardedCompletions = (shared.discardedCompletions ?? 0) + 1;
          callback(undefined);
        },
        (error) => {
          window.chrome.runtime.lastError = { message: error.message };
          callback(undefined);
          delete window.chrome.runtime.lastError;
        },
      );
      return undefined;
    },
    sendMessage(id, request, callback) {
      (shared.pageRequests ??= []).push(request.type);
      window.sendToContent(request).then(
        (value) => callback(structuredClone(value)),
        (error) => {
          window.chrome.runtime.lastError = { message: error.message };
          callback(undefined);
          delete window.chrome.runtime.lastError;
        },
      );
      return undefined;
    },
    captureVisibleTab(options, callback) {
      shared.captureVisibleTab().then(callback);
      return undefined;
    },
  },
  alarms: {
    get(name, callback) {
      if (typeof callback !== 'function') {
        shared.alarmContractError = true;
        throw Error('MV2_alarm_get_requires_callback');
      }
      // Missing alarms returned null in native Orion, not undefined.
      queueMicrotask(() => callback(shared.alarm ?? null));
      return undefined;
    },
    create(name, options) {
      shared.alarm = { name, periodInMinutes: options.periodInMinutes };
      setInterval(() => shared.emit('alarm', { name }), options.periodInMinutes * 60000);
      return undefined;
    },
    onAlarm: event('alarm'),
  },
  browserAction: {
    onClicked: event('clicked'),
    setBadgeText: () => Promise.resolve(),
    setBadgeBackgroundColor: () => Promise.resolve(),
    setTitle: () => Promise.resolve(),
  },
};
if (shared.permissionCase?.unavailable) delete window.chrome.permissions;
if (location.pathname === '/options.html') {
  document.addEventListener('submit', (event) => { shared.submitEvent = event; }, true);
}
if (location.pathname === '/background.html') {
  shared.emit = (name, ...args) => {
    for (const listener of shared.listeners[name] ?? []) listener(...args);
  };
}
`;
}

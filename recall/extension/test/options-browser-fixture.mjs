// Synthetic extension API bridge; actual scripts use native IndexedDB, canvas and gzip.
// chrome.storage.local is an in-memory test store; no owner data or credentials are used.
export function fixtureScript(manifest) {
  return `
/* global parent, window, location, queueMicrotask, setInterval, structuredClone */
const contentPage = location.pathname === '/article.html';
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
      return new Promise((resolve) => {
        const listener = shared.listeners.message?.[0];
        if (!listener) throw Error('background_not_ready');
        const keep = listener(request, { id: 'synthetic-recall-extension' }, resolve);
        if (keep !== true) resolve();
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
      queueMicrotask(() => callback(shared.alarm));
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
if (location.pathname === '/background.html') {
  shared.emit = (name, ...args) => {
    for (const listener of shared.listeners[name] ?? []) listener(...args);
  };
}
`;
}

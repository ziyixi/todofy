/// <reference lib="webworker" />

// FlowDay's service worker, served at /pwa/sw with scope / (docs/design.md "PWA"). It keeps the app shell
// available offline; data and every write need the network. It never caches an API answer, a redirect (an expired
// Cloudflare Access session redirects to its login page) or anything from another origin.
const CACHE_NAME = "flowday-v2";

const APP_SHELL = ["/", "/pwa/icon-192x192.png", "/pwa/icon-512x512.png"];

/** Only a plain same-origin 200 that was not redirected may be cached. */
function cacheable(response) {
  return Boolean(response) && response.ok && response.status === 200 && response.type === "basic" && !response.redirected;
}

async function put(request, response) {
  if (!cacheable(response)) return;
  const cache = await caches.open(CACHE_NAME);
  await cache.put(request, response);
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    Promise.all(
      APP_SHELL.map(async (path) => {
        try {
          const response = await fetch(path, { credentials: "same-origin", redirect: "manual" });
          await put(path, response);
        } catch {
          // Offline or signed out at install time: the shell is cached on the next visit.
        }
      })
    )
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  // Remove the caches of earlier versions (flowday-v1 and older).
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;

  // The API: always the network, never a cache.
  if (url.pathname.startsWith("/api/")) return;

  // Pages: network first (the HTML names the current hashed bundles), the cached shell when offline.
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          void put(event.request, response.clone());
          return response;
        })
        .catch(() => caches.match(event.request).then((cached) => cached || caches.match("/")))
    );
    return;
  }

  // Static files: stale-while-revalidate.
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const fetching = fetch(event.request)
        .then((response) => {
          void put(event.request, response.clone());
          return response;
        })
        .catch(() => cached);
      return cached || fetching;
    })
  );
});

// Installation and an explicit offline page only. Task responses, credentials and writes are never cached.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate" || new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(fetch(event.request).catch(() => new Response(`<!doctype html>
    <html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Tasks · Offline</title><style>
    body{font:16px system-ui;margin:15vh auto;padding:24px;max-width:480px;color:#252923;background:#f7f7f3}
    h1{font-size:24px}p{line-height:1.6;color:#64705b}a{color:#527a3d}
    </style><h1>Tasks is offline</h1><p>Connect to the internet, then reload to see your tasks.</p>
    <a href="/">Try again</a></html>`, {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    })));
});

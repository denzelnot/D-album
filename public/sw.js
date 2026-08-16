const CACHE = "d-album-shell-v2";
const SHELL = ["/", "/manifest.json", "/icon-192.png", "/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

// Network-first, and any successful same-origin response (the app's JS/CSS
// bundle, icons, etc.) gets cached as it's used — so after the first normal
// visit, the app itself keeps opening even with no signal at all.
// Photo data/images are handled separately by the app via IndexedDB.
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  const sameOrigin = url.origin === self.location.origin;

  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (sameOrigin && res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(event.request).then((r) => r || (sameOrigin ? caches.match("/") : undefined)))
  );
});

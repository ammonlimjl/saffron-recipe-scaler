// PrepFresh — service worker
// Cache-then-network for static assets so the app loads instantly on repeat
// visits and works offline. Backend API calls (Railway) always hit the
// network — never cached, since recipes change.

const CACHE_NAME = "prepfresh-v1";
const STATIC_ASSETS = [
  "/",
  "/index.html",
  "/style.css",
  "/app.js",
  "/manifest.json",
  "/icon.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);

  // Never cache the backend (Railway) — recipes change, plus we want fresh
  // imports on every fetch.
  if (url.hostname.includes("railway.app")) return;

  // Don't intercept cross-origin requests (Unsplash images, Google Fonts, etc.) —
  // let the browser handle those with its own caching.
  if (url.origin !== self.location.origin) return;

  // Network-first with cache fallback. Always tries fresh content; falls back
  // to cached version when offline.
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches
            .open(CACHE_NAME)
            .then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() =>
        caches
          .match(event.request)
          .then((cached) => cached || caches.match("/index.html"))
      )
  );
});

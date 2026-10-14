/* =============================================================================
 * FluentCards — service worker (web app / PWA only; inert in the extension).
 *
 * Caches the app shell so the installed icon opens offline. The dictionary
 * and translation APIs are never cached — a meaning must be live, and those
 * endpoints are cross-origin with their own caching rules.
 * ========================================================================== */
var VERSION = "fluentcards-v1";
var SHELL = [
  "./index.html",
  "./app.html",
  "./app.css",
  "./app.js",
  "./lib/storage.js",
  "./manifest.webmanifest",
  "./icons/icon16.png",
  "./icons/icon32.png",
  "./icons/icon48.png",
  "./icons/icon128.png",
  "./icons/icon192.png",
  "./icons/icon512.png",
  "./icons/icon-maskable-512.png"
];

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches
      .open(VERSION)
      .then(function (c) {
        return c.addAll(SHELL);
      })
      .then(function () {
        return self.skipWaiting();
      })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches
      .keys()
      .then(function (keys) {
        return Promise.all(
          keys
            .filter(function (k) {
              return k !== VERSION;
            })
            .map(function (k) {
              return caches.delete(k);
            })
        );
      })
      .then(function () {
        return self.clients.claim();
      })
  );
});

/* App shell: cache-first (it only changes when you update the app).
   Everything else (Wiktionary, dictionaryapi, Google Translate, YouTube):
   network-only, so meanings and translations are always fresh — fall back
   to the cached shell page when offline. */
self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;

  var url;
  try {
    url = new URL(req.url);
  } catch (err) {
    return;
  }

  /* only same-origin shell requests are cached */
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    caches.match(req).then(function (hit) {
      return (
        hit ||
        fetch(req).catch(function () {
          /* offline and not cached — hand back the app shell for navigations */
          if (req.mode === "navigate") return caches.match("./app.html");
          return new Response("", { status: 504, statusText: "offline" });
        })
      );
    })
  );
});

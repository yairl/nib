'use strict';

/* Bump ASSET_VERSION whenever the precached app shell changes (keep the
   ?v= values below in sync with the ones in index.html). Changing it renames
   the caches, so the old ones are dropped on activate. */
var ASSET_VERSION = 'v16';
var CORE_CACHE = 'nib-core-' + ASSET_VERSION;
var RUNTIME_CACHE = 'nib-runtime-' + ASSET_VERSION;

var PRECACHE = [
  '/',
  '/index.html',
  '/app.css?v=15',
  '/app.js?v=16',
  '/manifest.webmanifest',
  '/vendor/pdf.min.js',
  '/vendor/pdf-lib.min.js',
  '/vendor/pdf.worker.min.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/maskable-512.png',
  '/icons/apple-touch-icon.png',
  '/favicon-32.png',
  '/icon.svg'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CORE_CACHE)
      .then(function (c) { return c.addAll(PRECACHE); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== CORE_CACHE && k !== RUNTIME_CACHE) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;            // fonts etc. -> network
  if (url.pathname === '/healthz') return;
  if (url.pathname.indexOf('/api/') === 0) return;            // never cache data
  if (url.pathname.indexOf('/xhost-auth/') === 0) return;     // never cache auth

  // The manifest drives PWA install + OS file-handler registration, so it must
  // never be served stale. Network-first, cache only as an offline fallback.
  if (url.pathname === '/manifest.webmanifest') {
    e.respondWith(
      fetch(req).then(function (res) {
        if (res && res.status === 200) {
          var copy = res.clone();
          caches.open(RUNTIME_CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () { return caches.match(req); })
    );
    return;
  }

  // Navigations: network-first so deploys show immediately; fall back to the
  // cached shell when offline.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).catch(function () {
        return caches.match('/index.html').then(function (r) { return r || caches.match('/'); });
      })
    );
    return;
  }

  // Static assets: serve from cache, refresh in the background.
  e.respondWith(
    caches.match(req).then(function (cached) {
      var network = fetch(req).then(function (res) {
        if (res && res.status === 200 && res.type === 'basic') {
          var copy = res.clone();
          caches.open(RUNTIME_CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () { return cached; });
      return cached || network;
    })
  );
});

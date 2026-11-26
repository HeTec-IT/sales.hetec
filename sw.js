/*
 * Pencil Selling – Service Worker
 *
 * Zwei Betriebsarten:
 *  1. Release (scripts/build-release.mjs): sw-manifest.js enthält Version + vollständige Dateiliste mit Inhalts-Hashes.
 *     → Alle Dateien einer Version liegen in EINEM Cache "ps-app-<version>"; die App läuft immer komplett aus genau
 *       einer Version (keine Mischung alter und neuer Dateien). Neue Version wird im Hintergrund vollständig geladen,
 *       wartet und wird erst aktiviert, wenn die App es erlaubt (keine laufende Beratung) → keine Unterbrechung.
 *  2. Entwicklung / GitHub Pages ohne Build: kein Manifest → wie bisher network-first mit eigenem Cache.
 *
 * Nie gecacht: /api/* (Sitzung, Kundendaten, Statistik), Anmeldung, fremde Hosts, Nicht-GET.
 */
'use strict';
var MANIFEST = null;
try { importScripts('sw-manifest.js'); MANIFEST = self.__PS_PRECACHE || null; } catch (e) { MANIFEST = null; }

var PREFIX = 'ps-app-';
var LEGACY_PREFIX = 'pencil-o2-';
var VERSION = MANIFEST ? MANIFEST.version : 'dev';
var CACHE = PREFIX + VERSION;
var OCR_CACHE = 'ps-ocr-' + (MANIFEST ? MANIFEST.ocrVersion : 'dev');

function scopeUrl(p) { return new URL(p, self.registration.scope).href; }
function isApi(url) { return url.origin === self.location.origin && url.pathname.indexOf(new URL('api/', self.registration.scope).pathname) === 0; }
function isOcr(url) { return url.origin === self.location.origin && url.pathname.indexOf('/ocr/generated/') !== -1; }

self.addEventListener('install', function (e) {
  if (!MANIFEST) { e.waitUntil(self.skipWaiting()); return; }
  // Vollständige Version vorab laden. Schlägt eine Datei fehl, wird die Version NICHT installiert (keine Halbversion).
  e.waitUntil(caches.open(CACHE).then(function (c) {
    return Promise.all(MANIFEST.files.map(function (f) {
      var req = new Request(scopeUrl(f.url), { cache: 'reload', credentials: 'same-origin' });
      return fetch(req).then(function (res) {
        if (!res.ok) throw new Error('Precache fehlgeschlagen: ' + f.url + ' ' + res.status);
        return c.put(scopeUrl(f.url), res);
      });
    }));
  }));
  // KEIN skipWaiting: die neue Version wartet, bis die App "SKIP_WAITING" schickt.
});

self.addEventListener('message', function (e) {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
  if (e.data && e.data.type === 'GET_VERSION' && e.ports && e.ports[0]) e.ports[0].postMessage({ version: VERSION });
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) {
      // Nur eigene, veraltete Caches löschen (o2- und Telekom-App können sich eine Domain teilen)
      if (k === CACHE || k === OCR_CACHE) return false;
      return k.indexOf(PREFIX) === 0 || k.indexOf(LEGACY_PREFIX) === 0 || (k.indexOf('ps-ocr-') === 0 && MANIFEST);
    }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

function fromCache(cacheName, request) {
  return caches.open(cacheName).then(function (c) { return c.match(request, { ignoreSearch: false }); });
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url;
  try { url = new URL(req.url); } catch (_) { return; }
  if (url.origin !== self.location.origin) return;       // fremde Hosts nie anfassen
  if (isApi(url)) return;                                 // API nie cachen (Sitzung, Kundendaten)
  if (url.searchParams.has('_ps_ping')) return;           // Verbindungsprüfung immer echt

  // OCR-Modelle/WASM: groß, versioniert → einmal laden, danach aus dem Cache (auch offline)
  if (isOcr(url)) {
    e.respondWith(caches.open(OCR_CACHE).then(function (c) {
      return c.match(req).then(function (hit) {
        if (hit) return hit;
        return fetch(req).then(function (res) {
          if (res.ok && res.status !== 206) c.put(req, res.clone()).catch(function () {});
          return res;
        });
      });
    }));
    return;
  }

  if (MANIFEST) {
    // Navigation: immer die App-Hülle DIESER Version (konsistent mit ihren Skripten), Updates kommen über den SW-Zyklus
    if (req.mode === 'navigate') {
      e.respondWith(fromCache(CACHE, scopeUrl(MANIFEST.entry)).then(function (hit) {
        return hit || fetch(req);
      }));
      return;
    }
    e.respondWith(fromCache(CACHE, req).then(function (hit) {
      return hit || fetch(req).then(function (res) {
        // Öffentliche, nicht versionierte Daten (Preis-JSONs) dürfen für den Offline-Fall nachgecacht werden
        if (res.ok && /\.json$/.test(url.pathname)) { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(req, copy); }); }
        return res;
      }).catch(function () { return fromCache(CACHE, new Request(url.origin + url.pathname)).then(function (h) { return h || Response.error(); }); });
    }));
    return;
  }

  // Entwicklungsmodus ohne Manifest: network-first, Fallback eigener Cache
  e.respondWith(fetch(req.mode === 'navigate' ? new Request(req.url, { cache: 'no-cache' }) : req).then(function (res) {
    if (res && res.ok && res.status !== 206) { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(req, copy); }).catch(function () {}); }
    return res;
  }).catch(function () {
    return caches.open(CACHE).then(function (c) { return c.match(req).then(function (r) { return r || (req.mode === 'navigate' ? c.match(scopeUrl('./')) : Response.error()); }); });
  }));
});

// Pencil Selling – o2 – Service Worker
// Beim Update NUR diese Versionsnummer hochzählen -> alte Caches werden entfernt.
const CACHE = "pencil-o2-v28";
const SHELL = ["./", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png", "./ps-config.js", "./ps-backend.js", "./vendor/msal-browser.min.js"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k.startsWith("pencil-o2-")).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Anfragen an die eigene Schnittstelle (/api/...) und an Microsoft (Anmeldung/Token) gehen NIE durch
// den Service Worker: Antworten dürfen nie zwischengespeichert oder verzögert werden.
// Google Fonts bleiben cachebar.
function bypass(url) {
  const h = url.hostname;
  if (url.pathname.startsWith("/api/")) return true;
  return h.endsWith(".microsoftonline.com") || h.endsWith(".microsoft.com") || h.endsWith(".msauth.net");
}

// Nur der EIGENE Cache wird gelesen (kein caches.match über alle Caches der Domain),
// damit sich o2- und Telekom-App nie gegenseitig beliefern.
function fromOwnCache(request) {
  return caches.open(CACHE).then((c) => c.match(request).then((r) => r || c.match("./")));
}

// Network-first mit Cache-Fallback: online immer die neueste Version, offline die letzte bekannte.
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  let url;
  try { url = new URL(e.request.url); } catch (_) { return; }
  if (bypass(url)) return;
  e.respondWith(
    // Seiten (HTML) immer beim Server nachfragen -> Update kommt sofort an,
    // nicht erst nach Ablauf des GitHub-Pages-Caches (10 Min.).
    (e.request.mode === "navigate" || e.request.destination === "document"
      ? fetch(e.request.url, { cache: "no-cache" })
      : fetch(e.request))
      .then((res) => {
        // Nur gültige Antworten merken (keine Fehlerseiten, keine Teilantworten).
        if (res && res.status !== 206 && (res.ok || res.type === "opaque")) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => fromOwnCache(e.request))
  );
});

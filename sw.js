// Pencil Selling – o2 – Service Worker
// Beim Update NUR diese Versionsnummer hochzählen -> alte Caches werden entfernt.
const CACHE = "pencil-o2-v29";
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
// Fällt der Server aus (keine Antwort innerhalb von WAIT_MS, Verbindungsfehler oder Serverfehler 5xx),
// startet die App sofort aus dem Gerätespeicher; eine laufende Anfrage aktualisiert den Cache im Hintergrund.
const WAIT_MS = 4000;
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  let url;
  try { url = new URL(e.request.url); } catch (_) { return; }
  if (bypass(url)) return;
  const isDoc = e.request.mode === "navigate" || e.request.destination === "document";
  // Nur Seiten dürfen auf die Startseite zurückfallen; Skripte/Bilder nur auf die genau passende Kopie.
  const own = () => (isDoc ? fromOwnCache(e.request) : caches.open(CACHE).then((c) => c.match(e.request))).catch(() => undefined);
  // Seiten (HTML) immer beim Server nachfragen -> Update kommt sofort an.
  // Hängende Anfragen werden nach dem Wechsel auf den Cache beendet, damit sie keine Verbindungen blockieren.
  const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const sig = ctl ? { signal: ctl.signal } : {};
  let settled = false;
  const net = (isDoc ? fetch(e.request.url, Object.assign({ cache: "no-cache" }, sig)) : fetch(e.request, sig))
    .then((res) => {
      settled = true;
      // Nur gültige Antworten merken (keine Fehlerseiten, keine Teilantworten).
      if (res && res.status !== 206 && (res.ok || res.type === "opaque")) {
        const copy = res.clone();
        e.waitUntil(caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {}));
      }
      // Serverfehler (z. B. 502/503 vom Hoster): lieber die gemerkte Version als die Fehlerseite zeigen.
      if (res && res.status >= 500 && res.type !== "opaque") return own().then((c) => c || res);
      return res;
    })
    .catch(() => own().then((c) => c || Response.error()));
  const slow = new Promise((resolve) => {
    setTimeout(() => {
      own().then((c) => {
        if (!c) return;
        resolve(c);
        if (ctl) setTimeout(() => { if (!settled) ctl.abort(); }, 10000);
      });
    }, WAIT_MS);
  });
  e.respondWith(Promise.race([net, slow]));
});

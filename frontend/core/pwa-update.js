/*
 * PWA-Registrierung und Update-Steuerung.
 *  - Neue Version wird im Hintergrund vollständig geladen (Service Worker "waiting").
 *  - Aktivierung NUR auf Wunsch (Banner „Neue Version – jetzt aktualisieren“) oder automatisch bei einem ohnehin
 *    geplanten Neustart der App (z. B. nach dem Archivieren / „App beenden“) → eine laufende Beratung wird nie unterbrochen.
 *  - Nach der Aktivierung lädt die Seite einmal neu und läuft dann komplett aus der neuen Version.
 */
(function () {
  'use strict';
  if (!('serviceWorker' in navigator)) return;
  var cfg = window.PS_CONFIG || {};
  var reg = null, updateRequested = false, bannerShown = false;

  function waiting() { return reg && reg.waiting; }
  function activateNow() {
    var w = waiting();
    if (!w) return false;
    updateRequested = true;
    w.postMessage({ type: 'SKIP_WAITING' });
    return true;
  }
  function showBanner() {
    if (bannerShown || !document.body) return;
    bannerShown = true;
    var b = document.createElement('div');
    b.id = 'ps-update-banner';
    b.setAttribute('role', 'status');
    b.style.cssText = 'position:fixed;right:12px;bottom:84px;z-index:99990;background:#0f172a;color:#fff;font:600 13px system-ui,sans-serif;padding:10px 12px;border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,.25);display:flex;gap:10px;align-items:center;max-width:92vw';
    var t = document.createElement('span');
    t.textContent = 'Neue Version verfügbar';
    var go = document.createElement('button');
    go.type = 'button';
    go.textContent = 'Jetzt aktualisieren';
    go.style.cssText = 'border:0;border-radius:8px;background:#3b82f6;color:#fff;font-weight:800;padding:7px 10px;cursor:pointer';
    go.onclick = function () {
      try { document.dispatchEvent(new Event('ps-save-now')); } catch (e) {}
      if (!activateNow()) location.reload();
    };
    var later = document.createElement('button');
    later.type = 'button';
    later.textContent = 'Später';
    later.style.cssText = 'border:0;background:transparent;color:#94a3b8;font-weight:700;cursor:pointer';
    later.onclick = function () { b.remove(); };
    b.appendChild(t); b.appendChild(go); b.appendChild(later);
    document.body.appendChild(b);
  }
  function onWaiting() {
    // Startbildschirm ohne laufende Beratung (frisch geladen, noch nichts eingegeben): direkt aktualisieren
    if (!window.__PS_APP_STARTED && !document.querySelector('header')) { activateNow(); return; }
    showBanner();
  }

  navigator.serviceWorker.addEventListener('controllerchange', function () {
    if (updateRequested || window.__psIntentionalReload) { window.__psIntentionalReload = true; location.reload(); }
  });
  // Geplanter Neustart der App (Archivieren, „App beenden“, Update-Knopf): wartende Version vorher aktivieren
  window.addEventListener('beforeunload', function () { if (window.__psIntentionalReload) activateNow(); });

  window.PSPwa = {
    register: function () {
      var isApple = window.__PENCIL_INSTALL_MODE === 'apple-shortcut';
      if (isApple && !cfg.iosServiceWorker) return Promise.resolve(null);
      return navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(function (r) {
        reg = r;
        if (r.waiting && navigator.serviceWorker.controller) onWaiting();
        r.addEventListener('updatefound', function () {
          var nw = r.installing;
          if (!nw) return;
          nw.addEventListener('statechange', function () {
            if (nw.state === 'installed' && navigator.serviceWorker.controller) onWaiting();
          });
        });
        // regelmäßig nach Updates sehen (Tablets laufen tagelang ohne Neuladen)
        setInterval(function () { r.update().catch(function () {}); }, 15 * 60 * 1000);
        document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') r.update().catch(function () {}); });
        return r;
      }).catch(function (e) { try { console.warn('SW-Registrierung fehlgeschlagen:', e); } catch (x) {} return null; });
    },
    activateWaiting: activateNow,
    hasUpdate: function () { return !!waiting(); }
  };
})();

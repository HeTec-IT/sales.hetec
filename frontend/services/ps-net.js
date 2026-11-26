/*
 * PSNet – Liste erlaubter Netzwerkziele (Defense in Depth zusätzlich zur Content-Security-Policy).
 * Im HeTec-Betrieb werden fetch()-Aufrufe an nicht freigegebene Hosts abgebrochen und protokolliert.
 * Freigegeben: eigene Domain, Microsoft Power Automate (Archiv, Folgetermin), Microsoft-Anmeldung (nur Navigation).
 */
(function () {
  'use strict';
  var cfg = window.PS_CONFIG || {};
  var ALLOW_HETEC = [
    function (u) { return u.origin === location.origin; },
    function (u) { return u.protocol === 'https:' && /\.api\.powerplatform\.com$/i.test(u.hostname); },
    function (u) { return u.protocol === 'https:' && /\.logic\.azure\.com$/i.test(u.hostname); },
    function (u) { return u.protocol === 'data:' || u.protocol === 'blob:'; }
  ];
  var blocked = [];

  function allowed(url) {
    var u;
    try { u = new URL(String(url), location.href); } catch (e) { return false; }
    if (cfg.backend !== 'hetec') return true; // Firebase-Betrieb: unverändertes Verhalten
    for (var i = 0; i < ALLOW_HETEC.length; i++) if (ALLOW_HETEC[i](u)) return true;
    return false;
  }

  window.PSNet = {
    allowed: allowed,
    blocked: function () { return blocked.slice(); },
    translationAllowed: function () { return cfg.backend !== 'hetec' && cfg.allowExternalTranslation !== false; },
    externalQrAllowed: function () { return cfg.backend !== 'hetec' && cfg.allowExternalQr !== false; }
  };

  if (cfg.backend === 'hetec' && typeof window.fetch === 'function') {
    var orig = window.fetch.bind(window);
    window.__psNativeFetch = orig;
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || String(input);
      // Power-Automate-Flows laufen im HeTec-Betrieb über das Backend (signierte URLs nur auf dem Server)
      if (/^ps-flow:[a-z_]{1,32}$/.test(url)) {
        if (window.PSBackend && typeof window.PSBackend.flowFetch === 'function') return window.PSBackend.flowFetch(url.slice(8), init || {});
        return Promise.reject(new TypeError('PSNet: Flow-Weiterleitung nicht verfügbar'));
      }
      if (!allowed(url)) {
        var host = '';
        try { host = new URL(url, location.href).host; } catch (e) {}
        blocked.push({ host: host, ts: Date.now() });
        try { console.warn('[PSNet] blockiert (nicht freigegebenes Netzwerkziel):', host); } catch (e) {}
        return Promise.reject(new TypeError('PSNet: Netzwerkziel nicht freigegeben: ' + host));
      }
      return orig(input, init);
    };
  }
})();

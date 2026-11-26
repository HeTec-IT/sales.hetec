/*
 * PSBackend – zentrale Schnittstelle zwischen Pencil Selling und dem Backend.
 *
 * Die App ruft ausschließlich PSBackend.* auf (Anmeldung, Statistik, Angebote, News, Skip-Limits,
 * Suchindex, Downloads, Einstellungen). Welches Backend dahinter arbeitet, bestimmt PS_CONFIG.backend:
 *   'hetec'    → frontend/services/adapter-hetec.js   (Zielsystem: eigene API, MariaDB, Microsoft-Anmeldung)
 *   'firebase' → frontend/services/adapter-firebase.js (nur Übergang, wird nach der Migration entfernt)
 *
 * Es gibt KEINEN automatischen Wechsel/Fallback zwischen den Backends.
 */
(function () {
  'use strict';
  var cfg = window.PS_CONFIG || {};
  var adapters = window.__PS_ADAPTERS || {};
  var a = adapters[cfg.backend];
  if (!a) {
    var msg = 'Pencil Selling: Backend "' + cfg.backend + '" ist nicht verfügbar.';
    try { console.error(msg); } catch (e) {}
    document.addEventListener('DOMContentLoaded', function () {
      var el = document.getElementById('root');
      if (el) el.innerHTML = '<div style="font-family:Arial,sans-serif;padding:28px">' + msg + '</div>';
    });
    return;
  }
  window.PSBackend = a;

  /*
   * PSAccess – erlaubte Shops aus dem Profil in den lokalen Zustand übernehmen (ps_shop, ps_allowed_shops,
   * ps_shopwechsel). Inhaltlich identisch mit der bisherigen Logik im Firebase-Auth-Gate.
   * Die lokale Liste dient nur der Anzeige – der Server prüft jeden Zugriff selbst.
   */
  function normShop(value) {
    var s = String(value || '').trim().toLowerCase();
    s = s.replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss');
    s = s.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (s === 'sha' || s === 'schwaebischhall' || s === 'hall') return 'schwaebisch-hall';
    if (s === 'stuttgart' || s === 'vaihingen') return 'stuttgart-vaihingen';
    if (s === 'neuoetting' || s === 'neuotting') return 'neuoetting';
    return s;
  }
  window.PSAccess = {
    normShop: normShop,
    /** user: { isAdmin, allShops, homeShopId, allowedShopIds } (aus /session) */
    sync: function (user, shops) {
      shops = shops || {};
      var known = Object.keys(shops);
      var allowed = (user.allowedShopIds || []).map(normShop).filter(function (id) { return known.indexOf(id) !== -1; });
      var home = normShop(user.homeShopId || '');
      if (!shops[home]) home = allowed[0] || 'aalen';
      if (allowed.indexOf(home) === -1 && allowed.length) home = allowed[0];
      var extra = allowed.filter(function (id) { return id !== home; });
      var allShops = !!(user.isAdmin || user.allShops);
      var priorShop = null, oldAllowed = '', oldSwitch = '';
      try {
        priorShop = localStorage.getItem('ps_shop');
        oldAllowed = localStorage.getItem('ps_allowed_shops') || '';
        oldSwitch = localStorage.getItem('ps_shopwechsel') || '';
      } catch (e) {}
      var list = allowed.length ? allowed : [home];
      var effectiveShop = priorShop && list.indexOf(priorShop) !== -1 ? priorShop : home;
      var allowedJson = JSON.stringify(list);
      var switchValue = allShops || extra.length > 0 ? '1' : '0';
      try {
        localStorage.setItem('ps_shop', effectiveShop);
        localStorage.setItem('ps_allowed_shops', allowedJson);
        localStorage.setItem('ps_shopwechsel', switchValue);
      } catch (e) {}
      return {
        isAdmin: !!user.isAdmin, allShops: allShops, home: home, extra: extra, allowed: list,
        effectiveShop: effectiveShop, permissionsChanged: oldAllowed !== allowedJson || oldSwitch !== switchValue
      };
    }
  };
})();

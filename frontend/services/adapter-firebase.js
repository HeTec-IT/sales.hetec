/*
 * ════════════════════════════════════════════════════════════════════════════
 *  FIREBASE-MIGRATIONSADAPTER  (vorübergehend – wird nach der Migration gelöscht)
 * ════════════════════════════════════════════════════════════════════════════
 *  Enthält unverändert die bisherige Firebase-Anbindung (Anmeldung, Firestore).
 *  Wird NUR geladen/aktiv, wenn PS_CONFIG.backend === 'firebase' (GitHub-Pages-Beta).
 *  Im HeTec-Zielsystem ist diese Datei nicht im Release enthalten (scripts/build-release.mjs)
 *  und es werden keinerlei Google-/Firebase-Ressourcen geladen.
 *
 *  Entfernen nach der Migration: Datei löschen, Eintrag in index.html entfernen,
 *  Abschnitt „firebase“ in frontend/services/ps-backend.js entfernen. Sonst nichts.
 * ════════════════════════════════════════════════════════════════════════════
 */
(function () {
  'use strict';
  if (!window.PS_CONFIG || window.PS_CONFIG.backend !== 'firebase') return;

  var SDK_BASE = 'https://www.gstatic.com/firebasejs/10.12.5/';
  var SDK_FILES = ['firebase-app-compat.js', 'firebase-firestore-compat.js', 'firebase-auth-compat.js'];
  var sdkReady = new Promise(function (resolve, reject) {
    var i = 0;
    (function next() {
      if (i >= SDK_FILES.length) return resolve(true);
      var s = document.createElement('script');
      s.src = SDK_BASE + SDK_FILES[i++];
      s.async = false;
      s.onload = next;
      s.onerror = function () { reject(new Error('Firebase-SDK konnte nicht geladen werden')); };
      (document.head || document.documentElement).appendChild(s);
    })();
  });
  sdkReady.catch(function () {});

// ── Firebase Hauptprojekt: identisch mit Admin und Firestore-Regeln ──
// WICHTIG: Anmeldung, Benutzerprofile, Statistik, News und gespeicherte
// Angebote müssen aus demselben Projekt kommen.
const STATS_FB_CONFIG = {
  apiKey: "AIzaSyD0z1CX9vcdRQPtIo9pCjZ7Xs1h6dLl_8w",
  authDomain: "o2-pencil-selling.firebaseapp.com",
  projectId: "o2-pencil-selling",
  storageBucket: "o2-pencil-selling.firebasestorage.app",
  messagingSenderId: "347119579425",
  appId: "1:347119579425:web:afbb0b60fe6a266627ce60"
};
const AM_FB_CONFIG = {
  apiKey: "AIzaSyCjYCn-X694K1xoUULAin_zDta1r-dSh7Y",
  authDomain: "verkaufsmappe-7d917.firebaseapp.com",
  projectId: "verkaufsmappe-7d917",
  storageBucket: "verkaufsmappe-7d917.firebasestorage.app",
  messagingSenderId: "916375365270",
  appId: "1:916375365270:web:5b6bfbc37a4d0be1a004b7"
};

// ── Firebase Stats DB singleton (bisher getStatsDb in index.html) ──
const getStatsDb = () => {
  try {
    if (window.__statsDb) return window.__statsDb;
    const existing = window.firebase?.apps?.find(a => a.name === 'stats');
    const app = existing ? existing : window.firebase.initializeApp(STATS_FB_CONFIG, 'stats');
    window.__statsDb = window.firebase.firestore(app);
    return window.__statsDb;
  } catch (e) {
    console.warn('Stats Firebase init failed:', e);
    return null;
  }
};
const getAmDb = () => {
  try {
    if (window.__amDb) return window.__amDb;
    const existingApp = window.firebase?.apps?.find(a => a.name === 'am-dashboard');
    const app = existingApp ? existingApp : window.firebase.initializeApp(AM_FB_CONFIG, 'am-dashboard');
    window.__amDb = window.firebase.firestore(app);
    return window.__amDb;
  } catch (e) {
    console.warn('Firebase init failed:', e);
    return null;
  }
};
const fbReady = () => !!(window.firebase && window.firebase.initializeApp && window.firebase.firestore);
const need = () => { const db = getStatsDb(); if (!db) throw Object.assign(new Error('Keine Firebase-Verbindung'), { code: 'unavailable' }); return db; };
const psFireTimeout = (promise, fallback, ms = 4000) => Promise.race([promise, new Promise(res => setTimeout(() => res(fallback), ms))]);
const monthKey = () => new Date().toISOString().slice(0, 7);

// ════════════════ ANMELDUNG (bisheriges Auth-Gate, unverändert) ════════════════
const BETA_FB_CONFIG = STATS_FB_CONFIG; // Anmeldung im selben Projekt wie die Statistik
const PS_ADMIN_EMAIL = 'd.dasilva@hetec-gmbh.de';

function __psGetBetaApp() {
  var existing = window.firebase && window.firebase.apps && window.firebase.apps.find(function (a) { return a.name === 'stats'; });
  return existing ? existing : window.firebase.initializeApp(BETA_FB_CONFIG, 'stats');
}

function __psGetBetaDb() {
  if (window.__betaDb) return window.__betaDb;
  window.__betaDb = window.firebase.firestore(__psGetBetaApp());
  // v55.16: Ohne dies lebt der Firestore-Cache nur im Arbeitsspeicher -
  // bei JEDEM Reload (und die App laedt nach jedem Archivieren neu!) ist er
  // leer. Wer dann offline ist (z.B. Flugmodus), landet beim Profil-Check
  // auf einem leeren Snapshot ohne jede Ausweichmoeglichkeit - Sackgasse
  // ("Profil wird vom Server geladen... bitte Internetverbindung pruefen"),
  // obwohl er vorher schon angemeldet war. Mit Offline-Persistenz bleibt
  // das zuletzt bekannte Profil ueber Reloads hinweg in IndexedDB erhalten.
  try {
    window.__betaDb.enablePersistence({ synchronizeTabs: true }).catch(function (e) {
      // Mehrere Tabs offen (failed-precondition) oder Browser unterstuetzt
      // es nicht (unimplemented) - dann laeuft es einfach ohne
      // Offline-Cache weiter, wie bisher.
    });
  } catch (e) {}
  return window.__betaDb;
}

function __psGetAuth() {
  try {
    if (window.__betaAuth) return window.__betaAuth;
    window.__betaAuth = window.firebase.auth(__psGetBetaApp());
    return window.__betaAuth;
  } catch (e) {
    console.error('Auth-Init fehlgeschlagen:', e);
    return null;
  }
}

function __psGateRender(html) {
  var el = document.getElementById('root');
  if (el) el.innerHTML = html;
}

function __psEscapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, function(ch) {
    return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[ch];
  });
}

function __psShowError(msg) {
  var box = document.getElementById('ps-gate-msg');
  if (box) {
    box.textContent = msg;
    box.classList.remove('hidden');
  } else {
    alert(msg);
  }
}

function __psIsAdminEmail(email) {
  return String(email || '').toLowerCase() === PS_ADMIN_EMAIL;
}

function __psShopOptionsHtml() {
  var html = '';
  Object.keys(SHOPS).forEach(function (id) {
    html += '<option value="' + id + '">' + SHOPS[id].name + '</option>';
  });
  return html;
}

function __psRenderAuth(mode, prefill) {
  prefill = prefill || {};
  var isRegister = mode === 'register';
  function tabBtn(m, label) {
    var active = m === mode;
    return '<button data-mode="' + m + '" class="ps-tab flex-1 py-2 text-sm font-semibold rounded-lg ' +
      (active ? 'bg-blue-600 text-white' : 'text-slate-500') + '">' + label + '</button>';
  }
  var formHtml = isRegister ? (
    '<select id="ps-gate-anrede" class="w-full mb-2 px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white">' +
      '<option value="">Anrede wählen…</option>' +
      '<option value="Herr"' + (prefill.anrede === 'Herr' ? ' selected' : '') + '>Herr</option>' +
      '<option value="Frau"' + (prefill.anrede === 'Frau' ? ' selected' : '') + '>Frau</option>' +
      '<option value="Divers"' + (prefill.anrede === 'Divers' ? ' selected' : '') + '>Divers</option>' +
    '</select>' +
    '<input id="ps-gate-vorname" type="text" placeholder="Vorname (optional)" value="' + __psEscapeHtml(prefill.vorname || '') + '" class="w-full mb-2 px-3 py-2 border border-slate-300 rounded-lg text-sm" />' +
    '<input id="ps-gate-nachname" type="text" placeholder="Nachname" value="' + __psEscapeHtml(prefill.nachname || '') + '" class="w-full mb-2 px-3 py-2 border border-slate-300 rounded-lg text-sm" />' +
    '<input id="ps-gate-email" type="email" placeholder="E-Mail (@hetec-gmbh.de)" value="' + __psEscapeHtml(prefill.email || '') + '" class="w-full mb-2 px-3 py-2 border border-slate-300 rounded-lg text-sm" />' +
    '<input id="ps-gate-pw" type="password" placeholder="Passwort" class="w-full mb-2 px-3 py-2 border border-slate-300 rounded-lg text-sm" />' +
    '<select id="ps-gate-shop" class="w-full mb-4 px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white">' + __psShopOptionsHtml() + '</select>' +
    '<button id="ps-gate-submit" class="w-full bg-blue-600 text-white font-semibold py-2 rounded-lg text-sm">Konto erstellen</button>'
  ) : (
    '<input id="ps-gate-email" type="email" placeholder="E-Mail" value="' + __psEscapeHtml(prefill.email || '') + '" class="w-full mb-3 px-3 py-2 border border-slate-300 rounded-lg text-sm" />' +
    '<input id="ps-gate-pw" type="password" placeholder="Passwort" class="w-full mb-3 px-3 py-2 border border-slate-300 rounded-lg text-sm" />' +
    '<label class="flex items-center gap-2 mb-4 text-sm text-slate-600 cursor-pointer select-none">' +
      '<input id="ps-gate-remember" type="checkbox" checked class="w-4 h-4" /> Zugangsdaten dauerhaft merken' +
    '</label>' +
    '<button id="ps-gate-submit" class="w-full bg-blue-600 text-white font-semibold py-2 rounded-lg text-sm mb-2">Anmelden</button>' +
    '<button id="ps-gate-reset-btn" class="w-full text-blue-600 text-xs py-1">Passwort vergessen?</button>'
  );

  __psGateRender(
    '<div class="min-h-screen flex items-center justify-center bg-slate-100 p-4">' +
      '<div class="w-full max-w-sm bg-white rounded-2xl shadow-lg p-6">' +
        '<h1 class="text-xl font-bold text-slate-800 mb-4">Pencil Selling</h1>' +
        '<div class="flex gap-1 bg-slate-100 rounded-lg p-1 mb-4">' + tabBtn('login', 'Anmelden') + tabBtn('register', 'Registrieren') + '</div>' +
        '<div id="ps-gate-msg" class="hidden text-sm text-red-600 bg-red-50 rounded-lg p-2 mb-3"></div>' +
        formHtml +
      '</div>' +
    '</div>'
  );

  Array.prototype.forEach.call(document.querySelectorAll('.ps-tab'), function (btn) {
    btn.onclick = function () {
      var vals = {
        anrede: (document.getElementById('ps-gate-anrede') || {}).value,
        vorname: (document.getElementById('ps-gate-vorname') || {}).value,
        nachname: (document.getElementById('ps-gate-nachname') || {}).value,
        email: (document.getElementById('ps-gate-email') || {}).value
      };
      __psRenderAuth(btn.getAttribute('data-mode'), vals);
    };
  });

  if (isRegister) {
    document.getElementById('ps-gate-submit').onclick = function () {
      var btn = document.getElementById('ps-gate-submit');
      // v55.4.0: Schutz gegen Doppel-Klick/-Tap – ohne diesen Guard feuerte
      // ein zweiter Klick während der ersten Anfrage noch läuft eine zweite
      // createUserWithEmailAndPassword-Anfrage; das erste Konto wurde echt
      // angelegt, das zweite schlug mit "E-Mail bereits verwendet" fehl.
      if (btn.disabled) return;
      var anrede = document.getElementById('ps-gate-anrede').value;
      var vorname = document.getElementById('ps-gate-vorname').value.trim();
      var nachname = document.getElementById('ps-gate-nachname').value.trim();
      var email = document.getElementById('ps-gate-email').value.trim().toLowerCase();
      var pw = document.getElementById('ps-gate-pw').value;
      var shopId = document.getElementById('ps-gate-shop').value;
      if (!anrede || !nachname || !email || !pw) { __psShowError('Bitte Anrede, Nachname, E-Mail und Passwort ausfüllen.'); return; }
      if (!/@hetec-gmbh\.de$/.test(email)) { __psShowError('Nur E-Mail-Adressen mit @hetec-gmbh.de erlaubt.'); return; }
      if (pw.length < 6) { __psShowError('Passwort braucht mind. 6 Zeichen.'); return; }
      var displayName = vorname ? (vorname + ' ' + nachname).trim() : nachname;
      var auth = __psGetAuth();
      var createdUser = null;
      var btnLabel = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Erstelle Konto…';
      function __psResetSubmitBtn(){ btn.disabled = false; btn.textContent = btnLabel; }
      auth.setPersistence(window.firebase.auth.Auth.Persistence.LOCAL).then(function () {
        return auth.createUserWithEmailAndPassword(email, pw);
      }).then(function (cred) {
        createdUser = cred.user;
        // Profil zuerst anlegen. Scheitert das, wird das soeben erzeugte
        // Auth-Konto wieder entfernt – kein unbrauchbares "E-Mail belegt"-Konto.
        return __psGetBetaDb().collection('users').doc(cred.user.uid).set({
          email: email,
          anrede: anrede,
          vorname: vorname,
          nachname: nachname,
          name: displayName,
          shopId: shopId,
          shop: (SHOPS[shopId] && SHOPS[shopId].name) || '',
          role: 'verkaeufer',
          status: 'pending',
          active: false,
          isTestUser: false,
          createdAt: Date.now()
        }).catch(function (profileError) {
          return cred.user.delete().catch(function () {}).then(function () { throw profileError; });
        }).then(function () {
          // Kann die Mail vorübergehend nicht versendet werden, bleibt das
          // korrekte Profil bestehen. Auf der Bestätigungsseite kann erneut
          // gesendet oder der Zugang durch den Admin freigegeben werden.
          return cred.user.sendEmailVerification().catch(function (mailError) {
            console.warn('Bestätigungsmail konnte nicht sofort gesendet werden:', mailError);
          });
        });
      }).then(function () {
        __psResetSubmitBtn();
      }).catch(function (e) {
        __psResetSubmitBtn();
        __psShowError('Fehler: ' + (e && e.message || e));
      });
    };
  } else {
    document.getElementById('ps-gate-submit').onclick = function () {
      var email = document.getElementById('ps-gate-email').value.trim().toLowerCase();
      var pw = document.getElementById('ps-gate-pw').value;
      var remember = document.getElementById('ps-gate-remember').checked;
      if (!email || !pw) { __psShowError('Bitte E-Mail und Passwort eingeben.'); return; }
      var auth = __psGetAuth();
      var persistence = remember ? window.firebase.auth.Auth.Persistence.LOCAL : window.firebase.auth.Auth.Persistence.SESSION;
      auth.setPersistence(persistence).then(function () {
        return auth.signInWithEmailAndPassword(email, pw);
      }).catch(function (e) {
        __psShowError('Anmeldung fehlgeschlagen: ' + (e && e.message || e));
      });
    };
    document.getElementById('ps-gate-reset-btn').onclick = function () {
      var email = document.getElementById('ps-gate-email').value.trim();
      if (!email) { __psShowError('Bitte zuerst E-Mail eingeben.'); return; }
      __psGetAuth().sendPasswordResetEmail(email).then(function () {
        __psShowError('E-Mail zum Zurücksetzen wurde verschickt.');
      }).catch(function (e) {
        __psShowError('Fehler: ' + (e && e.message || e));
      });
    };
  }
}

function __psRenderWait(kind) {
  // SICHERHEITSFIX: 'blocked' entfällt hier - Zugriffsverweigerung (gesperrt/
  // abgelehnt/deaktiviert/Profil fehlt) meldet jetzt sofort ab und zeigt
  // Anmelden/Registrieren (siehe __psDenyAccess), statt auf einen eigenen
  // Wartebildschirm mit manuellem Abmelden-Button zu setzen.
  var title = kind === 'verify' ? 'E-Mail bestätigen' : 'Warte auf Freigabe';
  var text = kind === 'verify'
    ? 'Wir haben dir eine E-Mail geschickt. Bitte bestätige deine Adresse, dann geht es automatisch weiter.'
    : 'Deine Registrierung war erfolgreich. Dein Zugang muss noch durch einen Administrator freigegeben werden.';
  __psGateRender(
    '<div class="min-h-screen flex items-center justify-center bg-slate-100 p-4">' +
      '<div class="w-full max-w-sm bg-white rounded-2xl shadow-lg p-6 text-center">' +
        '<h1 class="text-xl font-bold text-slate-800 mb-2">' + title + '</h1>' +
        '<p class="text-sm text-slate-500 mb-5">' + text + '</p>' +
        (kind === 'verify' ? '<button id="ps-gate-resend" class="w-full text-blue-600 text-xs py-2 mb-2">E-Mail erneut senden</button>' : '') +
        '<button id="ps-gate-logout" class="w-full text-slate-400 text-xs py-1">Abmelden</button>' +
      '</div>' +
    '</div>'
  );
  if (kind === 'verify') {
    document.getElementById('ps-gate-resend').onclick = function () {
      var auth = __psGetAuth();
      if (auth.currentUser) { auth.currentUser.sendEmailVerification().catch(function () {}); }
    };
  }
  document.getElementById('ps-gate-logout').onclick = function () {
    __psGetAuth().signOut().then(function () { location.reload(); });
  };
}

// SICHERHEITSFIX: zentrale Funktion für JEDEN Fall, in dem der Zugriff
// verweigert werden muss (Profil fehlt, gesperrt/abgelehnt/deaktiviert,
// unbekannter Status, Live-Sperrung während der Nutzung). Zeigt SOFORT
// Anmelden/Registrieren mit einer verständlichen Meldung (nicht erst nach
// einem Reload) und meldet die Firebase-Sitzung zuverlässig ab.
// reloadAfter=true nur dann, wenn zuvor schon die komplette Pencil-Selling-
// Oberfläche lief (appStarted) - dort sorgt ein Reload nach dem Abmelden für
// einen wirklich sauberen Teardown der laufenden App.
function __psDenyAccess(message, reloadAfter) {
  __psRenderAuth('login');
  try { __psShowError(message); } catch (e) {}
  try {
    var p = __psGetAuth().signOut().catch(function () {});
    if (reloadAfter) { p.then(function () { location.reload(); }); }
  } catch (e) {}
}

function __PS_startAuthGate(startAppFn) {
  // Sofort einen sichtbaren Status in #root setzen. Damit kann der äußere
  // Loader verschwinden, selbst wenn Firebase auf einem langsamen Gerät
  // länger für die Wiederherstellung der Anmeldung benötigt.
  __psGateRender(
    '<div style="min-height:100vh;display:flex;align-items:center;justify-content:center;background:#000068;padding:20px;font-family:system-ui,sans-serif">' +
      '<div style="text-align:center;color:white">' +
        '<div style="width:42px;height:42px;border:4px solid rgba(255,255,255,.2);border-top-color:#3DE0FF;border-radius:50%;animation:spin .8s linear infinite;margin:0 auto 14px"></div>' +
        '<div style="font-size:14px;font-weight:800;color:#3DE0FF">Anmeldung wird geprüft …</div>' +
      '</div>' +
    '</div>'
  );
  var auth = __psGetAuth();
  if (!auth) {
    __psGateRender('<div class="min-h-screen flex items-center justify-center bg-red-50 p-4 text-center"><div class="max-w-sm"><h1 class="text-lg font-bold text-red-800 mb-2">Anmeldung konnte nicht geladen werden</h1><p class="text-sm text-red-700">Bitte Seite neu laden. Aus Sicherheitsgründen wird Pencil Selling ohne Firebase-Anmeldung nicht geöffnet.</p></div></div>');
    return;
  }
  var appStarted = false;
  var authStateResolved = false;
  var authWatchdog = setTimeout(function () {
    if (!authStateResolved && !appStarted) {
      __psGateRender(
        '<div style="min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f8fafc;padding:20px;font-family:system-ui,sans-serif;text-align:center">' +
          '<div style="max-width:380px"><h2 style="margin:0 0 8px;color:#0f172a">Anmeldung antwortet nicht</h2>' +
          '<p style="margin:0 0 16px;color:#64748b;font-size:14px">Bitte prüfe die Internetverbindung und lade Pencil Selling einmal neu.</p>' +
          '<button onclick="location.reload()" style="border:0;border-radius:10px;padding:11px 18px;background:#2563eb;color:white;font-weight:800;cursor:pointer">Neu laden</button></div>' +
        '</div>'
      );
    }
  }, 20000);

  function __psTrueLike(value) {
    if (value === true || value === 1) return true;
    if (typeof value !== 'string') return false;
    return /^(1|true|yes|ja|all|alle|\*)$/i.test(value.trim());
  }

  function __psNormalizeShopId(value) {
    var s = String(value || '').trim().toLowerCase();
    s = s.replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss');
    s = s.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (s === 'sha' || s === 'schwaebischhall' || s === 'hall') return 'schwaebisch-hall';
    if (s === 'stuttgart' || s === 'vaihingen') return 'stuttgart-vaihingen';
    if (s === 'neuoetting' || s === 'neuotting') return 'neuoetting';
    return s;
  }

  function __psProfileShopAccess(profile) {
    profile = profile || {};
    var isAdmin = profile.role === 'admin';
    // Kompatibel mit unterschiedlichen Admin-Versionen/Feldnamen.
    // Ein echter boolescher "Shop wechseln"-/"Springer"-Schalter gibt alle Shops frei.
    var allShops = isAdmin || [
      profile.shopwechsel, profile.shopWechsel, profile.shopSwitch,
      profile.canSwitchShop, profile.canChangeShop, profile.allowShopSwitch,
      profile.allShops, profile.isSpringer, profile.springer,
      profile.mobileEmployee, profile.ueberallEinsetzbar
    ].some(__psTrueLike);
    var home = __psNormalizeShopId(profile.shopId || profile.homeShopId || '') || 'aalen';
    if (!SHOPS[home]) home = 'aalen';
    var candidates = [profile.extraShopIds, profile.allowedShopIds, profile.shopIds, profile.allowedShops, profile.shops];
    var extra = [];
    candidates.forEach(function (candidate) {
      if (Array.isArray(candidate)) {
        candidate.forEach(function (value) {
          var id = __psNormalizeShopId(typeof value === 'object' && value ? (value.id || value.shopId || value.value) : value);
          if (id && SHOPS[id] && id !== home && extra.indexOf(id) === -1) extra.push(id);
        });
      } else if (candidate && typeof candidate === 'object') {
        Object.keys(candidate).forEach(function (value) {
          if (!__psTrueLike(candidate[value])) return;
          var id = __psNormalizeShopId(value);
          if (id && SHOPS[id] && id !== home && extra.indexOf(id) === -1) extra.push(id);
        });
      }
    });
    var allowed = allShops ? Object.keys(SHOPS) : [home].concat(extra);
    return { isAdmin: isAdmin, allShops: allShops, home: home, extra: extra, allowed: allowed };
  }

  function __psSyncProfileShopAccess(profile) {
    var access = __psProfileShopAccess(profile);
    var priorShop = null;
    var oldAllowed = '';
    var oldSwitch = '';
    // FIX Archivierung (geteilte Tablets): die zuletzt gewählte Filiale gehört dem Benutzer, der sie gewählt hat.
    // Früher übernahm ein Springer/Admin die Filiale des VORHERIGEN Mitarbeiters am Tablet → Archivierungen landeten
    // unbemerkt im falschen Shop (Dateiname, SharePoint-Ordner, Suchindex). Anderer Benutzer → Stammfiliale.
    var currentUid = '';
    try { currentUid = (window.__betaAuth && window.__betaAuth.currentUser && window.__betaAuth.currentUser.uid) || ''; } catch (e) {}
    try {
      priorShop = localStorage.getItem('ps_shop');
      var shopOwner = localStorage.getItem('ps_shop_uid') || '';
      if (currentUid && shopOwner !== currentUid) priorShop = null;
      oldAllowed = localStorage.getItem('ps_allowed_shops') || '';
      oldSwitch = localStorage.getItem('ps_shopwechsel') || '';
    } catch (e) {}
    var effectiveShop = priorShop && access.allowed.indexOf(priorShop) !== -1 ? priorShop : access.home;
    var allowedJson = JSON.stringify(access.allowed);
    var switchValue = access.allShops || access.extra.length > 0 ? '1' : '0';
    try {
      if (currentUid) localStorage.setItem('ps_shop_uid', currentUid);
      localStorage.setItem('ps_shop', effectiveShop);
      localStorage.setItem('ps_allowed_shops', allowedJson);
      localStorage.setItem('ps_shopwechsel', switchValue);
    } catch (e) {}
    access.effectiveShop = effectiveShop;
    access.permissionsChanged = oldAllowed !== allowedJson || oldSwitch !== switchValue;
    return access;
  }

  function startOnce(profile) {
    if (appStarted) return;
    appStarted = true;
    var _access = __psSyncProfileShopAccess(profile);
    var _isAdmin = _access.isAdmin;
    var _home = _access.home;
    var _extra = _access.extra;
    var _allowed = _access.allowed;
    var _effectiveShop = _access.effectiveShop;
    try {
      window.__PS_IS_ADMIN = _isAdmin;
      window.__PS_USER_UID = (window.__betaAuth && window.__betaAuth.currentUser && window.__betaAuth.currentUser.uid) || '';
      window.__PS_PROFILE_NAME = (profile && profile.name) || '';
      localStorage.setItem('ps_link_agent', (profile && profile.name) || '');
    } catch (e) {}
    // CURRENT_SHOP_ID wird oben im Skript als const berechnet, BEVOR das
    // Firestore-Profil geladen ist – also aus
    // dem 'ps_shop', der VOR diesem Aufruf in localStorage stand. Nur wenn
    // der jetzt ermittelte, tatsächlich gültige Shop davon abweicht (z.B.
    // beim allerersten Start, oder wenn eine Freigabe entzogen wurde), hilft
    // ein einmaliger, selbstbeendender Reload – genau wie beim manuellen
    // "Shop wechseln" – damit CURRENT_SHOP_ID neu und korrekt berechnet wird.
    if (_effectiveShop !== CURRENT_SHOP_ID) {
      try {
        var u = new URL(window.location.href);
        u.searchParams.delete('shop');
        u.searchParams.delete('filiale');
        window.__psIntentionalReload = true;
        window.location.replace(u.toString());
        return;
      } catch (e) {}
    }
    __psAddFloatingLogout();
    startAppFn();
  }

  function showFatal(err) {
    __psGateRender(
      '<div class="min-h-screen flex items-center justify-center bg-slate-100 p-4 text-center">' +
        '<div class="max-w-sm">' +
          '<h1 class="text-lg font-bold text-slate-800 mb-2">Verbindung fehlgeschlagen</h1>' +
          '<p class="text-sm text-slate-500 mb-4">' + __psEscapeHtml((err && err.message) ? err.message : 'Unbekannter Fehler. Bitte erneut versuchen.') + '</p>' +
          '<button id="ps-gate-retry" class="bg-blue-600 text-white text-sm font-semibold px-4 py-2 rounded-lg mr-2">Erneut versuchen</button>' +
          '<button id="ps-gate-logout2" class="text-slate-400 text-sm underline">Abmelden</button>' +
        '</div>' +
      '</div>'
    );
    var r = document.getElementById('ps-gate-retry');
    if (r) r.onclick = function () { location.reload(); };
    var l = document.getElementById('ps-gate-logout2');
    if (l) l.onclick = function () { auth.signOut().then(function () { location.reload(); }); };
  }

  // SICHERHEITSFIX: ersetzt das bisherige renderCompleteProfile(), das bei
  // JEDEM fehlenden Profil (auch bei gesperrten/gelöschten Konten) ein neues
  // "pending"-Profil per set() angelegt und damit die Sperre unterlaufen hat.
  // Diese Funktion wird NUR noch für ein bereits freigegebenes Profil
  // (active===true && status==='approved') mit fehlendem Namen aufgerufen
  // und aktualisiert AUSSCHLIESSLICH vorname/nachname/name per update() -
  // exakt die Felder, die die Firestore-Regeln für Selbst-Updates erlauben.
  // Kein shopId, keine Rolle, kein status/active, kein neues Profil.
  // Hinweis: 'Anrede' fehlt hier bewusst, weil die (laut Auftrag
  // unveränderten) Firestore-Regeln für Selbst-Updates nur
  // ['name','vorname','nachname'] zulassen - Diego kann 'anrede' bei Bedarf
  // selbst zu dieser Liste in den Regeln hinzufügen.
  function renderCompleteProfileNameOnly(user) {
    __psGateRender(
      '<div class="min-h-screen flex items-center justify-center bg-slate-100 p-4">' +
        '<div class="w-full max-w-sm bg-white rounded-2xl shadow-lg p-6">' +
          '<h1 class="text-xl font-bold text-slate-800 mb-1">Profil vervollständigen</h1>' +
          '<p class="text-sm text-slate-500 mb-4">Einmalig – dein Name fehlt noch in deinem (bereits freigegebenen) Konto.</p>' +
          '<div id="ps-gate-msg" class="hidden text-sm text-red-600 bg-red-50 rounded-lg p-2 mb-3"></div>' +
          '<input id="ps-gate-vorname" type="text" placeholder="Vorname (optional)" class="w-full mb-2 px-3 py-2 border border-slate-300 rounded-lg text-sm" />' +
          '<input id="ps-gate-nachname" type="text" placeholder="Nachname" class="w-full mb-4 px-3 py-2 border border-slate-300 rounded-lg text-sm" />' +
          '<button id="ps-gate-submit" class="w-full bg-blue-600 text-white font-semibold py-2 rounded-lg text-sm">Speichern</button>' +
        '</div>' +
      '</div>'
    );
    document.getElementById('ps-gate-submit').onclick = function () {
      var vorname = document.getElementById('ps-gate-vorname').value.trim();
      var nachname = document.getElementById('ps-gate-nachname').value.trim();
      if (!nachname) { __psShowError('Bitte mindestens den Nachnamen ausfüllen.'); return; }
      var displayName = vorname ? (vorname + ' ' + nachname).trim() : nachname;
      __psGetBetaDb().collection('users').doc(user.uid).update({
        vorname: vorname,
        nachname: nachname,
        name: displayName
      }).catch(function (e) {
        __psShowError('Fehler: ' + (e && e.message || e));
      });
      // Kein weiterer Schritt nötig: der onSnapshot-Listener unten reagiert
      // automatisch auf das aktualisierte Profil.
    };
  }

  auth.onAuthStateChanged(function (user) {
    authStateResolved = true;
    try { clearTimeout(authWatchdog); } catch (e) {}
    if (!user) { __psRenderAuth('login'); return; }
    // SICHERHEITSFIX: Sicherheitsreihenfolge - Domain zuerst prüfen, vor
    // jeder weiteren Prüfung/jedem Firestore-Zugriff.
    if (!/@hetec-gmbh\.de$/i.test(user.email || '')) {
      __psDenyAccess('Dieses Konto ist für Pencil Selling nicht zugelassen (nur @hetec-gmbh.de).', false);
      return;
    }

    // Token neu holen + Profil-Listener starten. Ausgelagert, damit sowohl
    // der normale Weg (erst E-Mail bestätigen) als auch der Admin-Vorrang-
    // Weg unten (Profil ist schon freigegeben) hierher führen können.
    function proceedToProfileGate() {
      // v55.12: getIdToken(true) erzwingt einen Server-Refresh (Sicherheits-
      // Check: ein gerade gesperrter Zugang soll schnell auffliegen). Ohne
      // Internet haengt/scheitert das aber, und OHNE Fallback blieb die App
      // dann auf einem leeren/ladenden Bildschirm haengen - genau in dem
      // Moment, in dem "trotzdem weiterarbeiten koennen" am wichtigsten waere.
      // Deshalb: bei Fehlschlag NICHT blockieren, sondern mit der bereits
      // vorhandenen (lokal zwischengespeicherten) Anmeldung weitermachen.
      // v55.15: War kurz auf "48h seit letzter Pruefung" - falsch, das haette
      // auch ein durchgehend ONLINE laufendes Geraet ausgeloggt, wenn es nur
      // lange nicht neu geladen hat. Richtig: siehe ps_offline_since-Logik
      // im Verbindungs-Check ganz oben in der Datei - die greift NUR nach
      // einer durchgaengigen Offline-Phase von 48h+.
      user.getIdToken(true).catch(function () {
        return null;
      }).then(function () {
        var isBootstrapAdmin = __psIsAdminEmail(user.email);
        var unsubscribeUserDoc = __psGetBetaDb().collection('users').doc(user.uid).onSnapshot(function (snap) {
          var d = snap.data();
          if (!d) {
            // BUGFIX: ein leerer Snapshot direkt aus dem lokalen Cache
            // (z.B. kurz nach einem Token-Refresh oder Sign-out/Reload)
            // bedeutet NICHT zuverlässig, dass das Profil wirklich fehlt -
            // nur, dass gerade nichts Gültiges zwischengespeichert ist.
            // Erst auf eine vom Server bestätigte Antwort warten.
            if (snap.metadata && snap.metadata.fromCache) {
              __psGateRender(
                '<div style="min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f8fafc;padding:20px;font-family:system-ui,sans-serif;text-align:center">' +
                  '<div><div style="font-weight:800;color:#0f172a;margin-bottom:6px">Profil wird vom Server geladen …</div>' +
                  '<div style="font-size:13px;color:#64748b;margin-bottom:16px">Bitte kurz die Internetverbindung prüfen.</div>' +
                  '<button onclick="location.reload()" style="border:0;border-radius:10px;padding:11px 18px;background:#2563eb;color:white;font-weight:800;cursor:pointer">Neu laden</button></div>' +
                '</div>'
              );
              return;
            }
            if (isBootstrapAdmin) {
              // Admin-Bootstrapping: falls der Administrator die Haupt-App
              // vor dem Admin-Dashboard öffnet, existiert sein eigenes
              // Profil evtl. noch nicht - identisch zu ensureAdminProfile()
              // im Dashboard automatisch anlegen. Betrifft ausschließlich
              // d.dasilva@hetec-gmbh.de; für alle anderen gilt unten die
              // Zugriffsverweigerung.
              __psGetBetaDb().collection('users').doc(user.uid).set({
                email: user.email,
                name: 'Diego da Silva',
                vorname: 'Diego',
                nachname: 'da Silva',
                role: 'admin',
                active: true,
                status: 'approved',
                isTestUser: false,
                shopId: '',
                shop: 'Verwaltung / Alle Shops',
                createdAt: Date.now()
              }).catch(function (e) { console.error('Admin-Profil konnte nicht angelegt werden:', e); });
              return; // onSnapshot feuert gleich erneut mit dem frisch angelegten Profil
            }
            // SICHERHEITSFIX: Fehlendes Profil darf niemals neu angelegt
            // werden - weder durch "Profil vervollständigen" noch sonst
            // irgendeine automatische Profilerstellung. Immer: Zugang
            // verweigern und abmelden, niemals ein neues Profil erzeugen.
            if (unsubscribeUserDoc) { try { unsubscribeUserDoc(); } catch (e) {} }
            __psDenyAccess('Dein Zugang ist nicht mehr vorhanden oder wurde gesperrt. Bitte wende dich an einen Administrator.', appStarted);
            return;
          }
          // SICHERHEITSFIX: strenge Positivprüfung statt einer laxen
          // "!== false"-Prüfung. Nur bei GENAU diesen beiden Werten wird
          // Zugriff gewährt; jeder andere/unbekannte/fehlende Status wird
          // als "kein Zugriff" behandelt.
          var darfZugreifen = d.active === true && d.status === 'approved';
          if (darfZugreifen || isBootstrapAdmin) {
            var fehltName = !((d.nachname && String(d.nachname).trim()) || (d.name && String(d.name).trim()));
            if (fehltName && !isBootstrapAdmin) {
              renderCompleteProfileNameOnly(user);
            } else {
              if (appStarted) {
                var _liveAccess = __psSyncProfileShopAccess(d);
                try {
                  window.__PS_IS_ADMIN = _liveAccess.isAdmin;
                  window.__PS_PROFILE_NAME = (d && d.name) || window.__PS_PROFILE_NAME || '';
                } catch (e) {}
                if (_liveAccess.permissionsChanged || _liveAccess.effectiveShop !== CURRENT_SHOP_ID) {
                  try {
                    window.__psIntentionalReload = true;
                    window.location.reload();
                  } catch (e) {}
                  return;
                }
              }
              startOnce(d);
            }
          } else if (appStarted) {
            // Admin hat das Konto WÄHREND der Nutzung gesperrt/deaktiviert
            // (oder das Profil gelöscht). Sofort abmelden und zur
            // Anmelden/Registrieren-Seite - nicht erst nach einem
            // Reload-Umweg (siehe Cache-Hinweis oben).
            if (unsubscribeUserDoc) { try { unsubscribeUserDoc(); } catch (e) {} }
            __psDenyAccess('Dein Zugang wurde soeben gesperrt. Bitte wende dich an einen Administrator.', true);
          } else if (d.status === 'pending') {
            // v55.7.0: Automatische Freischaltung nach E-Mail-Bestätigung
            // ENTFERNT. Ursache des gemeldeten Verhaltens: Microsoft Defender
            // "Safe Links" (und vergleichbare E-Mail-Security-Scanner) rufen
            // Links in eingehenden Mails automatisch auf, BEVOR der
            // Mitarbeiter die Mail überhaupt sieht/öffnet - das hat den
            // Bestätigungslink "geklickt" und emailVerified/approved gesetzt,
            // obwohl nie ein Mensch die Mail gelesen hat. Deshalb jetzt IMMER
            // echte Admin-Freigabe über die Mitarbeiterverwaltung nötig,
            // unabhängig vom E-Mail-Bestätigungsstatus.
            __psRenderWait('approval');
          } else {
            // rejected / gesperrt / blocked / deleted / unbekannter Status /
            // active:false mit status:'approved' (z.B. Deaktivierung) -
            // niemals Zugriff erlauben, sofort abmelden.
            if (unsubscribeUserDoc) { try { unsubscribeUserDoc(); } catch (e) {} }
            __psDenyAccess('Dein Zugang ist nicht mehr vorhanden oder wurde gesperrt. Bitte wende dich an einen Administrator.', false);
          }
        }, function (err) { showFatal(err); });
      }).catch(showFatal);
    }

    // NEU: Admin-Freigabe geht vor E-Mail-Bestätigung. Wurde der Mitarbeiter
    // bereits über die Mitarbeiterverwaltung freigegeben (active+approved),
    // kommt er sofort rein - unabhängig davon, ob/wann die Bestätigungsmail
    // ankommt. Das eigene Profil lesen ist auch OHNE bestätigte E-Mail
    // erlaubt (Firestore-Regel: dafür reicht istFirmenKonto()). Ist noch
    // NICHT freigegeben, läuft es wie bisher: erst E-Mail bestätigen.
    __psGetBetaDb().collection('users').doc(user.uid).get().then(function (snap) {
      var d = snap.exists ? snap.data() : null;
      var bereitsFreigegeben = !!d && d.active === true && d.status === 'approved';
      if (bereitsFreigegeben || __psIsAdminEmail(user.email)) {
        proceedToProfileGate();
        return;
      }
      waitForEmailThenProceed();
    }).catch(function () { waitForEmailThenProceed(); });

    function waitForEmailThenProceed() {
      user.reload().then(function () {
        if (!user.emailVerified) {
          __psRenderWait('verify');
          var iv = setInterval(function () {
            user.reload().then(function () {
              if (user.emailVerified) { clearInterval(iv); location.reload(); }
            }).catch(function () {});
          }, 4000);
          return;
        }
        proceedToProfileGate();
      }).catch(showFatal);
    }
  });
}

// ════════════════ DATEN (bisherige Firestore-Zugriffe aus index.html, unverändert) ════════════════
const migrateLegacyAnalyticsUids = async (db, analyticsDocs) => {
  if (!(window.__PS_IS_ADMIN === true) || !db || !Array.isArray(analyticsDocs)) return;
  const legacy = analyticsDocs.filter(d => {
    const data = d && d.data ? d.data() : null;
    return data && !data.userUid && typeof data.user === 'string' && data.user.trim() && data.user !== '–';
  });
  if (!legacy.length) return;
  try {
    const usersSnap = await db.collection('users').get();
    const byName = new Map();
    usersSnap.docs.forEach(doc => {
      const data = doc.data() || {};
      const name = String(data.name || '').trim();
      if (!name) return;
      const list = byName.get(name) || [];
      list.push(doc.id);
      byName.set(name, list);
    });
    const migratable = legacy.filter(doc => {
      const ids = byName.get(String(doc.data().user || '').trim()) || [];
      return ids.length === 1;
    });
    for (let i = 0; i < migratable.length; i += 400) {
      const batch = db.batch();
      migratable.slice(i, i + 400).forEach(doc => {
        const ids = byName.get(String(doc.data().user || '').trim()) || [];
        if (ids.length === 1) batch.update(doc.ref, { userUid: ids[0] });
      });
      await batch.commit();
    }
  } catch (e) {
    console.warn('Analytics-UID-Migration übersprungen:', e);
  }
};
const collectPages = async baseQuery => {
  const docs = [];
  let last = null;
  while (true) {
    let q = baseQuery;
    if (last) q = q.startAfter(last);
    const snap = await q.limit(500).get();
    const page = snap.docs || [];
    docs.push(...page);
    if (page.length < 500) break;
    last = page[page.length - 1];
    if (docs.length > 100000) throw new Error('Zu viele Statistikdatensätze');
  }
  return docs;
};
const PS_IDX_COLL = 'pdf_index';

const api = {
  mode: 'firebase',
  // Nur Übergang: externe Dienste wie bisher (im HeTec-Betrieb nicht vorhanden)
  htrDefaultUrl: 'https://europe-west3-o2-pencil-selling.cloudfunctions.net/handwritingToText',
  translate: (text, lang) => fetch('https://api.mymemory.translated.net/get?q=' + encodeURIComponent(String(text).slice(0, 480)) + '&langpair=de|' + lang),
  ready: () => sdkReady.then(fbReady),
  isReady: fbReady,
  auth: {
    startGate: startAppFn => { sdkReady.then(() => __PS_startAuthGate(startAppFn), err => {
      const el = document.getElementById('root');
      if (el) el.innerHTML = '<div style="font-family:Arial,sans-serif;padding:28px;color:#0f172a;background:#f8fafc;min-height:100vh"><h2 style="margin:0 0 10px">Pencil Selling konnte nicht geladen werden</h2><p>Bitte Internetverbindung prüfen und neu laden.</p></div>';
    }); },
    signOut: () => { const a = __psGetAuth(); return a ? a.signOut() : Promise.resolve(); },
    signOutAndReload: () => { const a = __psGetAuth(); return (a ? a.signOut() : Promise.resolve()).then(() => location.reload()); },
    currentUid: () => (window.__betaAuth && window.__betaAuth.currentUser && window.__betaAuth.currentUser.uid) || '',
    currentEmail: () => String(window.__betaAuth && window.__betaAuth.currentUser && window.__betaAuth.currentUser.email || '').trim().toLowerCase(),
    getIdToken: force => { const u = window.__betaAuth && window.__betaAuth.currentUser; if (!u) return Promise.reject(Object.assign(new Error('auth'), { code: 'auth' })); return u.getIdToken(!!force); },
    isSignedIn: () => !!(window.__betaAuth && window.__betaAuth.currentUser),
    offlineMaxMs: 48 * 60 * 60 * 1000
  },
  news: {
    load: async brand => {
      const db = getStatsDb();
      if (!db) return null;
      const snap = await db.collection('news').doc(brand || 'o2').get();
      if (!snap.exists) return [];
      const data = snap.data() || {};
      return Array.isArray(data.items) ? data.items : [];
    },
    save: async (clean, brand) => {
      const db = getStatsDb();
      if (!db) throw new Error('Keine Firebase-Verbindung');
      await db.collection('news').doc(brand || 'o2').set({ items: clean, updatedAt: new Date().toISOString() });
      return clean;
    }
  },
  offers: {
    save: async (meta, json) => {
      const db = need();
      await db.collection('saved_offers').doc(meta.id).set({
        id: meta.id, ts: meta.ts, label: meta.label, datum: meta.datum, agent: meta.agent,
        userUid: meta.userUid, shopId: meta.shopId, shop: meta.shop, kunde: meta.kunde,
        payload: json, createdAtServer: Date.now()
      });
    },
    list: async ({ shopId, isAdmin, maxAgeMs }) => {
      const db = getStatsDb();
      if (!db) return null;
      const currentSnap = await db.collection('saved_offers').where('shopId', '==', shopId).get();
      const snaps = [currentSnap];
      if (isAdmin) {
        try { snaps.push(await db.collection('saved_offers').get()); } catch (_) {}
      }
      const now = Date.now();
      const outById = new Map();
      const expired = [];
      snaps.forEach(snap => snap.forEach(doc => {
        const d = doc.data();
        if (!d) return;
        if (snap !== currentSnap && d.shopId) return;
        if (d.ts && now - d.ts > maxAgeMs) { expired.push(doc.id); return; }
        outById.set(doc.id, {
          id: d.id, ts: d.ts,
          label: String(d.label || d.kunde || 'Angebot') + (!d.shopId ? ' · Altbestand' : ''),
          datum: d.datum, agent: d.agent, kunde: d.kunde, legacyWithoutShop: !d.shopId
        });
      }));
      if (expired.length) await Promise.allSettled(expired.map(id => db.collection('saved_offers').doc(id).delete()));
      return Array.from(outById.values());
    },
    load: async id => {
      const db = getStatsDb();
      if (!db) return null;
      const doc = await db.collection('saved_offers').doc(id).get();
      if (!doc.exists) return null;
      const d = doc.data();
      if (!d || !d.payload) return null;
      return JSON.parse(d.payload);
    },
    remove: async id => { const db = getStatsDb(); if (!db) return false; await db.collection('saved_offers').doc(id).delete(); return true; }
  },
  analytics: {
    // Firebase: direkt schreiben; bei Fehler übernimmt die bisherige localStorage-Warteschlange in index.html.
    write: async row => { const db = need(); await db.collection('analytics').doc(row.id).set(row); return true; },
    loadAll: async () => {
      const db = need();
      const docs = await collectPages(db.collection('analytics').orderBy('ts', 'desc'));
      await migrateLegacyAnalyticsUids(db, docs);
      return docs.map(d => d.data());
    },
    loadOwn: async uid => {
      const db = need();
      let docs;
      try {
        docs = await collectPages(db.collection('analytics').where('userUid', '==', uid).orderBy(window.firebase.firestore.FieldPath.documentId()));
      } catch (e) {
        const snap = await db.collection('analytics').where('userUid', '==', uid).get();
        docs = snap.docs || [];
      }
      return docs.map(d => d.data()).sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));
    },
    clearAll: async () => {
      const db = need();
      const snap = await db.collection('analytics').get();
      const docs = snap.docs || [];
      for (let i = 0; i < docs.length; i += 400) {
        const batch = db.batch();
        docs.slice(i, i + 400).forEach(d => batch.delete(d.ref));
        await batch.commit();
      }
      return true;
    },
    flush: async () => 0,
    pendingCount: async () => 0
  },
  skip: {
    getCount: async agentName => {
      const db = getStatsDb();
      const doc = await psFireTimeout(db.collection('skip_limits').doc(`skip_${agentName}_${monthKey()}`).get(), null);
      if (!doc) return 0;
      return doc.exists ? doc.data().count || 0 : 0;
    },
    getLimit: async agentName => {
      const db = getStatsDb();
      const doc = await psFireTimeout(db.collection('skip_limits').doc(`limit_${agentName}`).get(), null);
      if (!doc) return 15;
      return doc.exists ? doc.data().max_limit || 15 : 15;
    },
    getExempt: async agentName => {
      const db = getStatsDb();
      const doc = await psFireTimeout(db.collection('skip_limits').doc(`limit_${agentName}`).get(), null);
      if (!doc) return false;
      return !!(doc.exists && doc.data().exempt === true);
    },
    increment: async agentName => {
      const db = getStatsDb();
      await psFireTimeout(db.collection('skip_limits').doc(`skip_${agentName}_${monthKey()}`).set({
        agent: agentName, userUid: window.__PS_USER_UID || '', month: monthKey(),
        count: firebase.firestore.FieldValue.increment(1), ts: new Date().toISOString()
      }, { merge: true }), null);
    },
    reset: async agentName => {
      const db = getStatsDb();
      await db.collection('skip_limits').doc(`skip_${agentName}_${monthKey()}`).set({ agent: agentName, month: monthKey(), count: 0, ts: new Date().toISOString() });
    },
    setLimit: async (agentName, newLimit) => {
      const db = getStatsDb();
      await db.collection('skip_limits').doc(`limit_${agentName}`).set({ agent: agentName, max_limit: Math.max(0, newLimit), ts: new Date().toISOString() }, { merge: true });
    },
    adminList: async agents => {
      const db = getStatsDb();
      const data = {};
      for (const agent of agents) {
        let count = 0, limit = 15;
        try { const cDoc = await db.collection('skip_limits').doc(`skip_${agent}_${monthKey()}`).get(); if (cDoc.exists) count = cDoc.data().count || 0; } catch (_) {}
        try { const lDoc = await db.collection('skip_limits').doc(`limit_${agent}`).get(); if (lDoc.exists) limit = lDoc.data().max_limit || 15; } catch (_) {}
        data[agent] = { count, limit };
      }
      return data;
    }
  },
  tools: {
    track: async (tool, agent) => {
      const db = getStatsDb();
      await db.collection('tool_usage').doc(`${tool}_${agent}_${monthKey()}`).set({
        agent, tool, month: monthKey(), count: firebase.firestore.FieldValue.increment(1), ts: new Date().toISOString()
      }, { merge: true });
    }
  },
  pdfIndex: {
    available: () => !!getStatsDb(),
    write: async (id, entry) => { await need().collection(PS_IDX_COLL).doc(id).set(entry); },
    // shops: [''] = ohne Einschränkung; Rückgabe: { results:[{status, items|reason}] } wie Promise.allSettled
    // FIX Archivierung: Bisher limit(300) OHNE Zeitfilter und ohne Sortierung → Firestore liefert die ersten 300 Dokumente
    // nach Dokument-ID (= Dateiname, alphabetisch) über ALLE Zeiten. Ab 300 Archivierungen eines Mitarbeiters fehlten
    // neue Einträge in "Meine Archivierungen" (z. B. alle Kunden mit späterem Anfangsbuchstaben).
    // Jetzt: Zeitfilter ts >= since (braucht Firestore-Index uid+ts bzw. shopId+uid+ts); fehlt der Index
    // (failed-precondition), Rückfall auf alle Einträge des Mitarbeiters ohne 300er-Grenze (max. 5000).
    mine: async (uid, shops, since) => {
      const db = need();
      const sinceMs = Number(since) || 0;
      const one = async shop => {
        let q = db.collection(PS_IDX_COLL);
        if (shop) q = q.where('shopId', '==', shop);
        q = q.where('uid', '==', uid);
        if (sinceMs > 0) {
          try {
            return await q.where('ts', '>=', sinceMs).limit(2000).get();
          } catch (e) {
            if (!e || (e.code !== 'failed-precondition' && !/index/i.test(String(e.message || '')))) throw e;
            try { console.warn('[ARCHIV] Firestore-Index pdf_index (uid, ts) fehlt – Rückfall ohne Zeitfilter.'); } catch (_) {}
          }
        }
        return q.limit(5000).get();
      };
      const rs = await Promise.allSettled(shops.map(one));
      return rs.map(r => r.status === 'fulfilled' ? { ok: true, items: r.value.docs.map(d => ({ docId: d.id, ...d.data() })).filter(x => !sinceMs || (Number(x.ts) || 0) >= sinceMs) } : { ok: false, code: r.reason && r.reason.code });
    },
    // Admin-Diagnose: alle Einträge seit since (Einzelfeld-Filter, kein Zusatzindex nötig). Lesen erlauben nur die Regeln.
    recent: async (since, limit) => {
      const snap = await need().collection(PS_IDX_COLL).where('ts', '>=', Number(since) || 0).limit(Math.max(1, Math.min(10000, Number(limit) || 5000))).get();
      return snap.docs.map(d => ({ docId: d.id, ...d.data() }));
    },
    search: async (key, shop, limit) => {
      let q = need().collection(PS_IDX_COLL);
      if (shop) q = q.where('shopId', '==', shop);
      const snap = await q.where('keys', 'array-contains', key).limit(limit).get();
      return { size: snap.size, items: snap.docs.map(d => ({ docId: d.id, ...d.data() })) };
    },
    probe: async shop => {
      let q = need().collection(PS_IDX_COLL);
      if (shop) q = q.where('shopId', '==', shop);
      await q.limit(1).get();
    },
    selftest: async (id, entry) => {
      const ref = need().collection(PS_IDX_COLL).doc(id);
      await ref.set(entry);
      const back = await ref.get();
      await ref.delete();
      return back.exists;
    },
    importChunk: async (chunk, idOf) => {
      const db = need();
      const refs = chunk.map(e => db.collection(PS_IDX_COLL).doc(idOf(e.fileName)));
      const docs = await Promise.all(refs.map(r => r.get()));
      const batch = db.batch();
      let n = 0;
      chunk.forEach((e, j) => { if (!docs[j].exists) { batch.set(refs[j], e); n++; } });
      if (n) await batch.commit();
      return n;
    }
  },
  users: {
    // Admin-Diagnose: bekannte Benutzer-IDs (nur wenn die Regeln das Lesen erlauben)
    listIds: async () => {
      const db = __psGetBetaDb();
      if (!db) throw Object.assign(new Error('Keine Firebase-Verbindung'), { code: 'unavailable' });
      const snap = await db.collection('users').get();
      return snap.docs.map(d => d.id);
    }
  },
  archive: {
    // Bisher: Firebase-ID-Token im Body an den Power-Automate-Flow. Unverändert.
    request: null // wird in index.html (psArchRequest) mit getIdToken umgesetzt
  },
  downloads: {
    upload: async blob => {
      const app = __psGetBetaApp();
      if (!app || !window.firebase) throw new Error('Firebase nicht verfügbar');
      const db = window.firebase.firestore(app);
      if (!app.auth().currentUser) throw new Error('Nicht angemeldet');
      const buf = new Uint8Array(await blob.arrayBuffer());
      let bin = ''; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      const b64 = btoa(bin), CH = 600000, n = Math.ceil(b64.length / CH);
      const rnd = new Uint8Array(16); (window.crypto || window.msCrypto).getRandomValues(rnd);
      const id = Array.from(rnd).map(x => ('0' + x.toString(16)).slice(-2)).join('');
      const ids = [];
      try {
        for (let i = 0; i < n; i++) {
          await db.collection('portierung_files').doc(id + '-' + i).set({ n, i, d: b64.slice(i * CH, (i + 1) * CH), ts: window.firebase.firestore.FieldValue.serverTimestamp() });
          ids.push(id + '-' + i);
        }
      } catch (e) { api.downloads.remove(ids).catch(() => {}); throw e; }
      return { url: location.origin + location.pathname + '?dl=' + id, ids };
    },
    remove: async ids => {
      const app = __psGetBetaApp();
      const db = window.firebase.firestore(app);
      for (const i of ids) { try { await db.collection('portierung_files').doc(i).delete(); } catch (e) {} }
    }
  },
  settings: {
    aktionsmappeBundles: async () => {
      const db = getAmDb();
      if (!db) return [];
      const snap = await db.collection('aktionsmappe').doc('global').get();
      return snap.exists && Array.isArray(snap.data()?.bundles) ? snap.data().bundles : [];
    }
  }
};
window.__PS_ADAPTERS = window.__PS_ADAPTERS || {};
window.__PS_ADAPTERS.firebase = api;
})();

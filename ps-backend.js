/* Pencil Selling – eigene Datenschicht (ersetzt Firebase).
 *
 * Stellt dieselben Aufrufe bereit, die die App bisher von Firebase kannte
 * (firebase.auth(), firebase.firestore(), FieldValue ...), spricht aber nur mit
 * der EIGENEN Schnittstelle (/api/db.php auf dem eigenen Hosting) und meldet über
 * Microsoft Entra an. Es geht keine Anfrage mehr an Google.
 *
 * Aufbau: 1) Login (MSAL)   2) Anfragen an /api/db.php   3) Firestore-kompatible Objekte
 */
(function () {
  'use strict';
  var CFG = window.PS_CONFIG || {};
  var API_URL = CFG.apiUrl || ((CFG.apiBase || '/api').replace(/\/$/, '') + '/db.php');
  var SCOPES = ['openid', 'profile', 'email'];
  var POLL_MS = 20000;

  function makeErr(code, message) {
    var e = new Error(message || code);
    e.code = code;
    return e;
  }
  function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
  function isConfigured() {
    return !!CFG.tenantId && !!CFG.clientId && !/EINTRAGEN/i.test(CFG.tenantId + CFG.clientId);
  }
  function redirectUri() { return CFG.redirectUri || (location.origin + '/'); }

  /* ------------------------------------------------------------ 1) Login --- */
  var msalApp = null;
  var account = null;       // aktives Microsoft-Konto
  var currentUser = null;   // Firebase-kompatibles Benutzerobjekt (oder null)
  var initDone = false;
  var initError = null;
  var listeners = [];
  var expiredShown = false;

  function claimsOf(acc) { return (acc && acc.idTokenClaims) || {}; }

  function makeUser(acc) {
    var c = claimsOf(acc);
    return {
      uid: String(c.oid || acc.localAccountId || ''),
      email: String(acc.username || c.preferred_username || '').toLowerCase(),
      displayName: acc.name || c.name || '',
      emailVerified: true,                       // Microsoft hat die Adresse bereits geprüft
      getIdToken: function (force) { return getIdToken(!!force); },
      reload: function () { return Promise.resolve(); },
      sendEmailVerification: function () { return Promise.resolve(); },
      delete: function () { return Promise.reject(makeErr('auth/operation-not-allowed', 'Konten werden in Microsoft Entra verwaltet.')); }
    };
  }

  function isInteractionRequired(err) {
    var c = String(err && (err.errorCode || err.code) || '');
    return /interaction_required|login_required|consent_required|no_account|invalid_grant|monitor_window_timeout|refresh_token_expired|bad_token/i.test(c);
  }

  function showExpiredBanner() {
    if (expiredShown || !document.body) return;
    expiredShown = true;
    var b = document.createElement('div');
    b.id = 'ps-relogin';
    b.style.cssText = 'position:fixed;left:12px;right:12px;bottom:12px;z-index:2147483000;background:#0f172a;color:#fff;border-radius:12px;padding:12px 14px;font:600 14px system-ui,sans-serif;display:flex;gap:10px;align-items:center;box-shadow:0 6px 24px rgba(0,0,0,.35)';
    b.innerHTML = '<span style="flex:1">Anmeldung abgelaufen – Daten werden erst nach erneutem Anmelden gespeichert.</span>';
    var btn = document.createElement('button');
    btn.textContent = 'Jetzt anmelden';
    btn.style.cssText = 'border:0;border-radius:9px;padding:9px 14px;background:#3de0ff;color:#000068;font-weight:800;cursor:pointer';
    btn.onclick = function () { signInWithMicrosoft(); };
    b.appendChild(btn);
    document.body.appendChild(b);
  }

  function getIdToken(force, quiet) {
    if (!msalApp || !account) return Promise.reject(makeErr('auth/no-current-user', 'Nicht angemeldet.'));
    return msalApp.acquireTokenSilent({ scopes: SCOPES, account: account, forceRefresh: !!force }).then(function (r) {
      if (r.account) { account = r.account; }
      return r.idToken;
    }, function (err) {
      if (isInteractionRequired(err)) {
        if (!quiet) showExpiredBanner();
        throw makeErr('auth/requires-recent-login', 'Anmeldung abgelaufen.');
      }
      throw makeErr('auth/network-request-failed', 'Anmeldung nicht erreichbar.');
    });
  }

  function notify() {
    listeners.slice().forEach(function (cb) { try { cb(currentUser); } catch (e) { console.error(e); } });
  }

  function init() {
    if (!isConfigured()) {
      initError = makeErr('auth/not-configured', 'Anmeldung noch nicht eingerichtet (ps-config.js: Tenant-ID und Client-ID fehlen).');
      initDone = true; notify();
      return Promise.resolve();
    }
    if (!window.msal || !window.msal.PublicClientApplication) {
      initError = makeErr('auth/not-configured', 'Anmelde-Bibliothek konnte nicht geladen werden.');
      initDone = true; notify();
      return Promise.resolve();
    }
    msalApp = new window.msal.PublicClientApplication({
      auth: {
        clientId: CFG.clientId,
        authority: 'https://login.microsoftonline.com/' + CFG.tenantId,
        redirectUri: redirectUri(),
        postLogoutRedirectUri: redirectUri(),
        navigateToLoginRequestUrl: true
      },
      // localStorage = Anmeldung bleibt nach App-Neustart erhalten (wie bisher "dauerhaft merken")
      cache: { cacheLocation: 'localStorage', storeAuthStateInCookie: false }
    });
    return msalApp.initialize().then(function () {
      return msalApp.handleRedirectPromise().catch(function (err) {
        initError = makeErr('auth/' + (err && err.errorCode || 'redirect-failed'), 'Anmeldung fehlgeschlagen: ' + (err && (err.errorMessage || err.message) || 'unbekannter Fehler'));
        return null;
      });
    }).then(function (res) {
      account = (res && res.account) || msalApp.getActiveAccount() || msalApp.getAllAccounts()[0] || null;
      if (!account) return null;
      msalApp.setActiveAccount(account);
      if (res && res.account) return null;      // frisch angemeldet: Token ist aktuell
      // Gespeicherte Anmeldung: still erneuern. Abgelaufen -> Anmeldeseite; offline -> weiterarbeiten.
      return getIdToken(false, true).catch(function (err) {
        if (err && err.code === 'auth/requires-recent-login') account = null;
      });
    }).then(function () {
      currentUser = account ? makeUser(account) : null;
    }, function (err) {
      initError = makeErr('auth/init-failed', 'Anmeldung konnte nicht gestartet werden: ' + (err && err.message || err));
      currentUser = null;
    }).then(function () {
      initDone = true; notify();
    });
  }

  function signInWithMicrosoft() {
    if (!msalApp) return Promise.reject(initError || makeErr('auth/not-configured', 'Anmeldung nicht bereit.'));
    // Kontoauswahl erzwingen: an gemeinsam genutzten Tablets darf nie automatisch das Konto des Vorgängers aktiv sein.
    return msalApp.loginRedirect({ scopes: SCOPES, prompt: 'select_account' });
  }

  // Standard (soft): nur lokal abmelden. {full:true}: zusätzlich bei Microsoft abmelden.
  function signOut(opts) {
    var acc = account;
    currentUser = null; account = null;
    if (!msalApp || !acc) return Promise.resolve();
    var full = !!(opts && opts.full);
    var req = { account: acc, postLogoutRedirectUri: redirectUri() };
    if (!full) req.onRedirectNavigate = function () { return false; };
    if (full) {
      // Weiterleitung zu Microsoft startet: Promise bleibt offen, damit ein anschliessendes
      // location.reload() der App die Weiterleitung nicht abbricht.
      return msalApp.logoutRedirect(req).then(function () { return new Promise(function () {}); }, function () { /* Weiterleitung nicht moeglich: lokal abgemeldet */ });
    }
    return msalApp.logoutRedirect(req).catch(function () {}).then(function () {
      try { msalApp.setActiveAccount(null); } catch (e) {}
    });
  }

  var authApi = {
    get currentUser() { return currentUser; },
    get lastError() { return initError; },
    onAuthStateChanged: function (cb) {
      listeners.push(cb);
      if (initDone) setTimeout(function () { cb(currentUser); }, 0);
      return function () { listeners = listeners.filter(function (x) { return x !== cb; }); };
    },
    setPersistence: function () { return Promise.resolve(); },
    signInWithMicrosoft: signInWithMicrosoft,
    signOut: signOut,
    signInWithEmailAndPassword: function () { return Promise.reject(makeErr('auth/operation-not-allowed', 'Anmeldung nur noch über Microsoft.')); },
    createUserWithEmailAndPassword: function () { return Promise.reject(makeErr('auth/operation-not-allowed', 'Konten werden in Microsoft Entra verwaltet.')); },
    sendPasswordResetEmail: function () { return Promise.reject(makeErr('auth/operation-not-allowed', 'Passwörter werden über Microsoft verwaltet.')); }
  };

  /* ---------------------------------------------------- 2) Anfragen --- */
  function post(body, token) {
    var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, 45000) : null;
    var headers = { 'Content-Type': 'application/json' };
    if (token) headers['x-ps-token'] = token;
    return fetch(API_URL, { method: 'POST', headers: headers, body: JSON.stringify(body), cache: 'no-store', signal: ctl ? ctl.signal : undefined })
      .catch(function () { throw makeErr('unavailable', 'Keine Verbindung zum Server.'); })
      .then(function (res) {
        return res.text().then(function (t) {
          var j = null;
          try { j = JSON.parse(t); } catch (e) { /* Antwort ohne JSON (z. B. Gateway-Fehler) */ }
          return { status: res.status, json: j };
        });
      })
      .then(function (r) {
        if (timer) clearTimeout(timer);
        if (r.json && r.json.ok === true) return r.json;
        var code = (r.json && r.json.code) || (r.status === 401 ? 'unauthenticated' : r.status === 403 ? 'permission-denied' : r.status >= 500 ? 'unavailable' : 'unknown');
        throw makeErr(code, (r.json && r.json.message) || ('Serverfehler ' + r.status));
      }, function (e) { if (timer) clearTimeout(timer); throw e; });
  }

  function call(body) {
    var user = currentUser;
    if (!user) return post(body, '');
    return getIdToken(false).then(function (tok) {
      return post(body, tok).catch(function (err) {
        if (err.code !== 'unauthenticated') throw err;
        // Token vom Server abgelehnt (z. B. gerade abgelaufen): einmal frisch holen und wiederholen
        return getIdToken(true).then(function (t2) { return post(body, t2); });
      });
    });
  }

  /* ------------------------------------------ 3) Firestore-kompatibel --- */
  var NAME = '__name__';
  function FieldValue(kind, n) { this.__ps = kind; if (n !== undefined) this.n = n; }
  FieldValue.increment = function (n) { return new FieldValue('inc', Number(n)); };
  FieldValue.serverTimestamp = function () { return new FieldValue('ts'); };
  FieldValue.delete = function () { return new FieldValue('del'); };
  var FieldPath = { documentId: function () { return NAME; } };

  function plain(v) { return JSON.parse(JSON.stringify(v)); } // FieldValue -> {__ps,n}

  function DocSnap(ref, data, fromCache) {
    this.ref = ref; this.id = ref.id; this.exists = data !== null && data !== undefined;
    this._data = this.exists ? data : null;
    this.metadata = { fromCache: !!fromCache, hasPendingWrites: false };
  }
  DocSnap.prototype.data = function () { return this._data ? clone(this._data) : undefined; };
  DocSnap.prototype.get = function (f) { var d = this._data; String(f).split('.').forEach(function (k) { d = d == null ? undefined : d[k]; }); return clone(d); };

  function QuerySnap(docs) {
    this.docs = docs; this.size = docs.length; this.empty = docs.length === 0;
    this.metadata = { fromCache: false, hasPendingWrites: false };
  }
  QuerySnap.prototype.forEach = function (fn, thisArg) { this.docs.forEach(fn, thisArg); };

  function profileKey(uid) { return 'ps_profile_cache_' + uid; }

  function DocRef(db, coll, id) { this.firestore = db; this.parentName = coll; this.id = id; this.path = coll + '/' + id; }
  DocRef.prototype.get = function () {
    var self = this;
    return call({ op: 'get', c: this.parentName, id: this.id }).then(function (r) {
      var data = r.doc ? r.doc.data : null;
      if (self.parentName === 'users' && currentUser && self.id === currentUser.uid && data) {
        try { localStorage.setItem(profileKey(self.id), JSON.stringify(data)); } catch (e) {}
      }
      return new DocSnap(self, data, false);
    }, function (err) {
      // Offline: zuletzt bekanntes eigenes Profil weiterverwenden (Offline-Arbeiten wie bisher)
      if (err.code === 'unavailable' && self.parentName === 'users' && currentUser && self.id === currentUser.uid) {
        try {
          var c = JSON.parse(localStorage.getItem(profileKey(self.id)) || 'null');
          if (c) return new DocSnap(self, c, true);
        } catch (e) {}
      }
      throw err;
    });
  };
  DocRef.prototype.set = function (data, opts) {
    return call({ op: 'set', c: this.parentName, id: this.id, data: plain(data), merge: !!(opts && opts.merge) }).then(function () {});
  };
  DocRef.prototype.update = function (data) {
    if (typeof data === 'string') { var o = {}; for (var i = 0; i < arguments.length; i += 2) o[arguments[i]] = arguments[i + 1]; data = o; }
    return call({ op: 'update', c: this.parentName, id: this.id, data: plain(data) }).then(function () {});
  };
  DocRef.prototype.delete = function () {
    return call({ op: 'delete', c: this.parentName, id: this.id }).then(function () {});
  };
  // Änderungen live melden: regelmäßig nachfragen (und sofort beim Zurückkehren in die App)
  DocRef.prototype.onSnapshot = function (a, b, c) {
    var next = typeof a === 'function' ? a : (a && a.next) || function () {};
    var onErr = typeof a === 'function' ? b : (a && a.error) || (typeof b === 'function' ? b : c);
    var self = this, stopped = false, last = null, timer = null;
    function tick() {
      if (stopped) return;
      self.get().then(function (snap) {
        if (stopped) return;
        var sig = JSON.stringify([snap.exists, snap._data, snap.metadata.fromCache]);
        if (sig !== last) { last = sig; next(snap); }
      }, function (err) {
        if (stopped) return;
        if (err.code === 'unavailable') return;          // kurz offline: nichts melden, später erneut
        stopped = true; clearInterval(timer); cleanup();
        if (onErr) onErr(err);
      });
    }
    function onVis() { if (document.visibilityState === 'visible') tick(); }
    function cleanup() { document.removeEventListener('visibilitychange', onVis); window.removeEventListener('online', tick); }
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('online', tick);
    timer = setInterval(tick, POLL_MS);
    tick();
    return function () { stopped = true; clearInterval(timer); cleanup(); };
  };

  function Query(db, coll, st) { this.firestore = db; this.name = coll; this.st = st || { where: [], order: [], limit: null, after: null }; }
  Query.prototype._with = function (patch) {
    var st = { where: this.st.where.slice(), order: this.st.order.slice(), limit: this.st.limit, after: this.st.after };
    Object.keys(patch).forEach(function (k) { st[k] = patch[k]; });
    return new Query(this.firestore, this.name, st);
  };
  Query.prototype.where = function (f, op, v) { return this._with({ where: this.st.where.concat([[String(f), op, plain(v)]]) }); };
  Query.prototype.orderBy = function (f, dir) { return this._with({ order: this.st.order.concat([[String(f), dir === 'desc' ? 'desc' : 'asc']]) }); };
  Query.prototype.limit = function (n) { return this._with({ limit: n }); };
  Query.prototype.startAfter = function (snap) { return this._with({ after: snap }); };
  Query.prototype.get = function () {
    var st = this.st, self = this, body = { op: 'query', c: this.name, where: st.where };
    if (st.order.length) body.orderBy = st.order;
    if (st.limit != null) body.limit = st.limit;
    if (st.after) {
      var s = st.after, d = s.data ? s.data() : {};
      var ord = st.order.length ? st.order : [[NAME, 'asc']];
      body.after = { id: s.id, values: ord.map(function (o) { return o[0] === NAME ? s.id : (d || {})[o[0]]; }) };
    }
    return call(body).then(function (r) {
      return new QuerySnap(r.docs.map(function (d) { return new DocSnap(new DocRef(self.firestore, self.name, d.id), d.data, false); }));
    });
  };

  function CollRef(db, name) { Query.call(this, db, name); this.id = name; this.path = name; }
  CollRef.prototype = Object.create(Query.prototype);
  CollRef.prototype.doc = function (id) {
    if (id == null) id = Array.prototype.map.call(crypto.getRandomValues(new Uint8Array(10)), function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
    return new DocRef(this.firestore, this.name, String(id));
  };
  CollRef.prototype.add = function (data) {
    var self = this;
    return call({ op: 'add', c: this.name, data: plain(data) }).then(function (r) { return new DocRef(self.firestore, self.name, r.id); });
  };

  function Batch() { this.ops = []; }
  Batch.prototype.set = function (ref, data, opts) { this.ops.push({ op: 'set', c: ref.parentName, id: ref.id, data: plain(data), merge: !!(opts && opts.merge) }); return this; };
  Batch.prototype.update = function (ref, data) { this.ops.push({ op: 'update', c: ref.parentName, id: ref.id, data: plain(data) }); return this; };
  Batch.prototype.delete = function (ref) { this.ops.push({ op: 'delete', c: ref.parentName, id: ref.id }); return this; };
  Batch.prototype.commit = function () {
    var ops = this.ops, p = Promise.resolve();
    for (var i = 0; i < ops.length; i += 400) (function (part) { p = p.then(function () { return call({ op: 'batch', ops: part }); }); })(ops.slice(i, i + 400));
    return p.then(function () {});
  };

  var db = {
    collection: function (name) { return new CollRef(db, name); },
    batch: function () { return new Batch(); },
    enablePersistence: function () { return Promise.resolve(); },   // Offline-Profil wird oben selbst gemerkt
    settings: function () {}
  };

  /* -------------------------------------------------- firebase-Schnittstelle --- */
  var apps = [];
  function makeApp(cfg, name) {
    var app = { name: name || '[DEFAULT]', options: cfg || {} };
    app.auth = function () { return authApi; };
    app.firestore = function () { return db; };
    return app;
  }
  var firebase = {
    apps: apps,
    initializeApp: function (cfg, name) {
      var existing = apps.filter(function (a) { return a.name === (name || '[DEFAULT]'); })[0];
      if (existing) return existing;
      var a = makeApp(cfg, name); apps.push(a); return a;
    },
    firestore: function () { return db; },
    auth: function () { return authApi; }
  };
  firebase.firestore.FieldValue = FieldValue;
  firebase.firestore.FieldPath = FieldPath;
  firebase.auth.Auth = { Persistence: { LOCAL: 'local', SESSION: 'session', NONE: 'none' } };
  window.firebase = firebase;
  window.psBackend = { signInWithMicrosoft: signInWithMicrosoft, getIdToken: getIdToken };

  init();
})();

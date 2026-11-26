/*
 * Test-Ersatz für das Firebase-Compat-SDK (nur Tests, nie ausgeliefert).
 * In-Memory-Firestore + E-Mail/Passwort-Auth, Zustand in localStorage ('__fakefb'), damit Reloads funktionieren.
 * Startdaten: window.__FAKE_FB_SEED = { accounts: [{uid,email,password}], docs: { 'users/uid': {...} } }
 * Wird im Test per Playwright-Route statt https://www.gstatic.com/firebasejs/… ausgeliefert.
 */
(function () {
  'use strict';
  if (window.firebase && window.firebase.__fake) return;
  var KEY = '__fakefb';
  function load() {
    try { var s = JSON.parse(localStorage.getItem(KEY) || 'null'); if (s) return s; } catch (e) {}
    var seed = window.__FAKE_FB_SEED || { accounts: [], docs: {} };
    return { accounts: seed.accounts || [], docs: seed.docs || {}, user: null, seq: 1, log: [] };
  }
  var S = load();
  function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {} }
  save();
  var later = function (fn) { return Promise.resolve().then(fn); };
  function err(code, msg) { var e = new Error(msg || code); e.code = code; return e; }

  // ── Werte / Sentinels ─────────────────────────────────────────────
  function Timestamp(sec, ns) { this.seconds = sec; this.nanoseconds = ns || 0; }
  Timestamp.prototype.toMillis = function () { return this.seconds * 1000 + Math.floor(this.nanoseconds / 1e6); };
  Timestamp.prototype.toDate = function () { return new Date(this.toMillis()); };
  Timestamp.fromMillis = function (ms) { return new Timestamp(Math.floor(ms / 1000), (ms % 1000) * 1e6); };
  Timestamp.fromDate = function (d) { return Timestamp.fromMillis(d.getTime()); };
  Timestamp.now = function () { return Timestamp.fromMillis(Date.now()); };
  var SENT = '__fakefb_sentinel';
  var FieldValue = {
    serverTimestamp: function () { var o = {}; o[SENT] = 'ts'; return o; },
    increment: function (n) { var o = {}; o[SENT] = 'inc'; o.n = n; return o; },
    arrayUnion: function () { var o = {}; o[SENT] = 'au'; o.v = [].slice.call(arguments); return o; },
    arrayRemove: function () { var o = {}; o[SENT] = 'ar'; o.v = [].slice.call(arguments); return o; },
    delete: function () { var o = {}; o[SENT] = 'del'; return o; }
  };
  var DOC_ID = { __docId: true };
  var FieldPath = { documentId: function () { return DOC_ID; } };
  function enc(v) { // Timestamp → speicherbar
    if (v instanceof Timestamp) return { __ts: v.toMillis() };
    if (Array.isArray(v)) return v.map(enc);
    if (v && typeof v === 'object') { var o = {}; Object.keys(v).forEach(function (k) { o[k] = enc(v[k]); }); return o; }
    return v;
  }
  function dec(v) {
    if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 1 && '__ts' in v) return Timestamp.fromMillis(v.__ts);
    if (Array.isArray(v)) return v.map(dec);
    if (v && typeof v === 'object') { var o = {}; Object.keys(v).forEach(function (k) { o[k] = dec(v[k]); }); return o; }
    return v;
  }
  function applyField(cur, val) {
    if (val && typeof val === 'object' && val[SENT]) {
      switch (val[SENT]) {
        case 'ts': return { __ts: Date.now() };
        case 'inc': return (typeof cur === 'number' ? cur : 0) + val.n;
        case 'au': var a = Array.isArray(cur) ? cur.slice() : []; val.v.forEach(function (x) { if (a.indexOf(x) === -1) a.push(x); }); return a;
        case 'ar': return (Array.isArray(cur) ? cur : []).filter(function (x) { return val.v.indexOf(x) === -1; });
        case 'del': return undefined;
      }
    }
    return enc(val);
  }
  function setPath(obj, path, val) {
    var parts = path.split('.'), o = obj;
    for (var i = 0; i < parts.length - 1; i++) { if (!o[parts[i]] || typeof o[parts[i]] !== 'object') o[parts[i]] = {}; o = o[parts[i]]; }
    var nv = applyField(o[parts[parts.length - 1]], val);
    if (nv === undefined) delete o[parts[parts.length - 1]]; else o[parts[parts.length - 1]] = nv;
  }
  function getPath(obj, path) { return path.split('.').reduce(function (o, k) { return o == null ? undefined : o[k]; }, obj); }

  // ── Listener ──────────────────────────────────────────────────────
  var docListeners = {};
  function notify(key) { (docListeners[key] || []).slice().forEach(function (fn) { later(fn); }); }

  function nsKey(ns, path) { return ns + '|' + path; }

  // ── Dokumente ─────────────────────────────────────────────────────
  function DocSnap(ref, data) {
    this.ref = ref; this.id = ref.id; this.exists = data !== undefined; this.metadata = { fromCache: false, hasPendingWrites: false };
    this._d = data;
  }
  DocSnap.prototype.data = function () { return this._d === undefined ? undefined : dec(JSON.parse(JSON.stringify(this._d))); };
  DocSnap.prototype.get = function (f) { var d = this.data(); return d ? getPath(d, f) : undefined; };

  function DocRef(db, path) { this.firestore = db; this.path = path; this.id = path.split('/').pop(); this._k = nsKey(db._ns, path); }
  DocRef.prototype.collection = function (c) { return new Query(this.firestore, this.path + '/' + c); };
  DocRef.prototype.get = function () { var self = this; return later(function () { return new DocSnap(self, S.docs[self._k]); }); };
  DocRef.prototype._write = function (data, merge) {
    var base = merge && S.docs[this._k] ? JSON.parse(JSON.stringify(S.docs[this._k])) : {};
    Object.keys(data || {}).forEach(function (k) {
      if (merge && data[k] && typeof data[k] === 'object' && !data[k][SENT] && !Array.isArray(data[k]) && !(data[k] instanceof Timestamp) && base[k] && typeof base[k] === 'object') {
        Object.keys(data[k]).forEach(function (kk) { setPath(base, k + '.' + kk, data[k][kk]); });
      } else setPath(base, k, data[k]);
    });
    S.docs[this._k] = base; S.log.push({ op: 'set', path: this.path, ns: this.firestore._ns }); save(); notify(this._k);
  };
  DocRef.prototype.set = function (data, opts) { var self = this; return later(function () { self._write(data, !!(opts && opts.merge)); }); };
  DocRef.prototype.update = function (data) {
    var self = this;
    return later(function () {
      if (!S.docs[self._k]) throw err('not-found', 'No document to update');
      var base = JSON.parse(JSON.stringify(S.docs[self._k]));
      Object.keys(data).forEach(function (k) { setPath(base, k, data[k]); });
      S.docs[self._k] = base; S.log.push({ op: 'update', path: self.path, ns: self.firestore._ns }); save(); notify(self._k);
    });
  };
  DocRef.prototype.delete = function () { var self = this; return later(function () { delete S.docs[self._k]; S.log.push({ op: 'delete', path: self.path, ns: self.firestore._ns }); save(); notify(self._k); }); };
  DocRef.prototype.onSnapshot = function (next, error) {
    var self = this, live = true;
    if (typeof next === 'object' && next) { error = next.error; next = next.next; }
    var fn = function () { if (live) try { next(new DocSnap(self, S.docs[self._k])); } catch (e) { if (error) error(e); } };
    (docListeners[this._k] = docListeners[this._k] || []).push(fn);
    later(fn);
    return function () { live = false; docListeners[self._k] = (docListeners[self._k] || []).filter(function (f) { return f !== fn; }); };
  };

  // ── Abfragen ──────────────────────────────────────────────────────
  function Query(db, path, f, o, l, sa) { this.firestore = db; this.path = path; this.id = path.split('/').pop(); this._f = f || []; this._o = o || []; this._l = l || 0; this._sa = sa; }
  Query.prototype.doc = function (id) { return new DocRef(this.firestore, this.path + '/' + (id || ('auto' + (S.seq++) + Date.now().toString(36)))); };
  Query.prototype.where = function (f, op, v) { return new Query(this.firestore, this.path, this._f.concat([[f, op, v]]), this._o, this._l, this._sa); };
  Query.prototype.orderBy = function (f, d) { return new Query(this.firestore, this.path, this._f, this._o.concat([[f, d || 'asc']]), this._l, this._sa); };
  Query.prototype.limit = function (n) { return new Query(this.firestore, this.path, this._f, this._o, n, this._sa); };
  Query.prototype.startAfter = function (s) { return new Query(this.firestore, this.path, this._f, this._o, this._l, s); };
  Query.prototype.add = function (data) { var r = this.doc(); return r.set(data).then(function () { return r; }); };
  Query.prototype._rows = function () {
    var pre = nsKey(this.firestore._ns, this.path + '/'), self = this, rows = [];
    Object.keys(S.docs).forEach(function (k) {
      if (k.indexOf(pre) !== 0) return;
      var rest = k.slice(pre.length);
      if (rest.indexOf('/') !== -1) return;
      rows.push(new DocSnap(new DocRef(self.firestore, self.path + '/' + rest), S.docs[k]));
    });
    var val = function (s, f) { return f === DOC_ID ? s.id : getPath(dec(s._d), f); };
    var num = function (x) { return x instanceof Timestamp ? x.toMillis() : x; };
    this._f.forEach(function (c) {
      rows = rows.filter(function (s) {
        var a = num(val(s, c[0])), b = c[2] instanceof Timestamp ? c[2].toMillis() : c[2];
        switch (c[1]) {
          case '==': return a === b; case '!=': return a !== b; case '<': return a < b; case '<=': return a <= b;
          case '>': return a > b; case '>=': return a >= b; case 'in': return b.indexOf(a) !== -1; case 'not-in': return b.indexOf(a) === -1;
          case 'array-contains': return Array.isArray(a) && a.indexOf(b) !== -1;
          case 'array-contains-any': return Array.isArray(a) && a.some(function (x) { return b.indexOf(x) !== -1; });
        }
        return true;
      });
    });
    this._o.slice().reverse().forEach(function (o) {
      rows.sort(function (x, y) { var a = num(val(x, o[0])), b = num(val(y, o[0])); var r = a < b ? -1 : a > b ? 1 : 0; return o[1] === 'desc' ? -r : r; });
    });
    if (this._sa) { var i = rows.findIndex(function (s) { return s.id === (self._sa.id || self._sa); }); if (i >= 0) rows = rows.slice(i + 1); }
    if (this._l) rows = rows.slice(0, this._l);
    return rows;
  };
  function QSnap(rows) { this.docs = rows; this.size = rows.length; this.empty = !rows.length; this.metadata = { fromCache: false }; }
  QSnap.prototype.forEach = function (fn) { this.docs.forEach(fn); };
  Query.prototype.get = function () { var self = this; return later(function () { return new QSnap(self._rows()); }); };
  Query.prototype.count = function () { var self = this; return { get: function () { return later(function () { var n = self._rows().length; return { data: function () { return { count: n }; } }; }); } }; };
  Query.prototype.onSnapshot = function (next) { var self = this; later(function () { next(new QSnap(self._rows())); }); return function () {}; };

  function Firestore(ns) { this._ns = ns; }
  Firestore.prototype.collection = function (p) { return new Query(this, p); };
  Firestore.prototype.doc = function (p) { return new DocRef(this, p); };
  Firestore.prototype.settings = function () {};
  Firestore.prototype.enablePersistence = function () { return Promise.resolve(); };
  Firestore.prototype.batch = function () {
    var ops = [];
    return {
      set: function (r, d, o) { ops.push(function () { return r.set(d, o); }); return this; },
      update: function (r, d) { ops.push(function () { return r.update(d); }); return this; },
      delete: function (r) { ops.push(function () { return r.delete(); }); return this; },
      commit: function () { return ops.reduce(function (p, f) { return p.then(f); }, Promise.resolve()); }
    };
  };
  Firestore.prototype.runTransaction = function (fn) {
    var tx = { get: function (r) { return r.get(); }, set: function (r, d, o) { r._write(d, !!(o && o.merge)); return tx; }, update: function (r, d) { r.update(d); return tx; }, delete: function (r) { r.delete(); return tx; } };
    return Promise.resolve().then(function () { return fn(tx); });
  };

  // ── Auth ──────────────────────────────────────────────────────────
  var authListeners = [];
  function mkUser(a) {
    if (!a) return null;
    return {
      uid: a.uid, email: a.email, emailVerified: a.emailVerified !== false, displayName: a.displayName || null,
      getIdToken: function () { return Promise.resolve('fake-id-token-' + a.uid); },
      reload: function () { return Promise.resolve(); },
      sendEmailVerification: function () { return Promise.resolve(); }
    };
  }
  var auth = {
    currentUser: mkUser(S.user ? S.accounts.find(function (a) { return a.uid === S.user; }) : null),
    onAuthStateChanged: function (fn) { authListeners.push(fn); var u = auth.currentUser; later(function () { fn(u); }); return function () { authListeners = authListeners.filter(function (f) { return f !== fn; }); }; },
    setPersistence: function () { return Promise.resolve(); },
    signInWithEmailAndPassword: function (email, pw) {
      return later(function () {
        var a = S.accounts.find(function (x) { return x.email === String(email).toLowerCase(); });
        if (!a) throw err('auth/user-not-found');
        if (a.password !== pw) throw err('auth/wrong-password');
        S.user = a.uid; save(); auth.currentUser = mkUser(a);
        authListeners.forEach(function (f) { later(function () { f(auth.currentUser); }); });
        return { user: auth.currentUser };
      });
    },
    createUserWithEmailAndPassword: function (email, pw) {
      return later(function () {
        var a = { uid: 'u' + (S.seq++), email: String(email).toLowerCase(), password: pw, emailVerified: false };
        S.accounts.push(a); S.user = a.uid; save(); auth.currentUser = mkUser(a);
        authListeners.forEach(function (f) { later(function () { f(auth.currentUser); }); });
        return { user: auth.currentUser };
      });
    },
    sendPasswordResetEmail: function () { return Promise.resolve(); },
    signOut: function () { return later(function () { S.user = null; save(); auth.currentUser = null; authListeners.forEach(function (f) { later(function () { f(null); }); }); }); }
  };

  var dbs = {};
  var apps = [];
  var fb = {
    __fake: true,
    apps: apps,
    initializeApp: function (cfg, name) { var a = { name: name || '[DEFAULT]', options: cfg }; apps.push(a); return a; },
    app: function (name) { return apps.find(function (a) { return a.name === (name || '[DEFAULT]'); }); },
    auth: function () { return auth; },
    firestore: function (app) { var ns = (app && app.options && app.options.projectId) || 'default'; return dbs[ns] || (dbs[ns] = new Firestore(ns)); },
    __state: function () { return S; }
  };
  fb.auth.Auth = { Persistence: { LOCAL: 'local', SESSION: 'session', NONE: 'none' } };
  fb.firestore.FieldValue = FieldValue;
  fb.firestore.FieldPath = FieldPath;
  fb.firestore.Timestamp = Timestamp;
  window.firebase = fb;
})();

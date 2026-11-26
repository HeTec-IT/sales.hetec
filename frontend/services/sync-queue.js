/*
 * PSSyncQueue – Offline-Warteschlange in IndexedDB.
 *
 * - Jeder Eintrag gehört genau einem Benutzer (uid) und hat eine stabile ID → mehrfaches Senden ist
 *   unschädlich (der Server arbeitet idempotent), Doppelzählungen sind ausgeschlossen.
 * - Einträge eines anderen Benutzers werden nie unter der aktuellen Anmeldung gesendet (Benutzerwechsel
 *   auf geteilten Shop-Tablets). Sie bleiben liegen, bis derselbe Benutzer sich wieder anmeldet,
 *   höchstens MAX_AGE_DAYS, danach werden sie gelöscht.
 * - Wiederholung mit exponentiellem Backoff; endgültig abgelehnte Einträge (z. B. fremder Shop) wandern
 *   in 'rejected' und sind in der Diagnose sichtbar statt still zu verschwinden.
 * - kv-Speicher: zuletzt bestätigtes Sitzungsprofil für zeitlich begrenzten Offline-Betrieb.
 */
(function () {
  'use strict';
  var DB_NAME = 'pencil-selling-hetec';
  var DB_VERSION = 1;
  var MAX_AGE_DAYS = 14;
  var dbP = null;

  function open() {
    if (dbP) return dbP;
    dbP = new Promise(function (resolve, reject) {
      if (!('indexedDB' in window)) return reject(new Error('IndexedDB nicht verfügbar'));
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains('queue')) {
          var q = db.createObjectStore('queue', { keyPath: ['kind', 'uid', 'id'] });
          q.createIndex('byKindUid', ['kind', 'uid']);
          q.createIndex('byQueued', 'queuedAt');
        }
        if (!db.objectStoreNames.contains('rejected')) db.createObjectStore('rejected', { keyPath: ['kind', 'uid', 'id'] });
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
      req.onblocked = function () { reject(new Error('IndexedDB blockiert')); };
    });
    dbP.catch(function () { dbP = null; });
    return dbP;
  }

  function tx(stores, mode, fn) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(stores, mode);
        var out;
        t.oncomplete = function () { resolve(out); };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error || new Error('abort')); };
        out = fn(t);
      });
    });
  }

  function reqP(r) {
    return new Promise(function (resolve, reject) { r.onsuccess = function () { resolve(r.result); }; r.onerror = function () { reject(r.error); }; });
  }

  var API = {
    /** Eintrag einreihen (überschreibt denselben Eintrag mit gleicher ID → kein Duplikat). */
    put: function (kind, uid, item) {
      if (!uid || !item || !item.id) return Promise.reject(new Error('uid und id erforderlich'));
      return tx(['queue'], 'readwrite', function (t) {
        t.objectStore('queue').put({ kind: kind, uid: String(uid), id: String(item.id), item: item, queuedAt: Date.now(), attempts: 0, nextTry: 0 });
      });
    },
    list: function (kind, uid, limit) {
      return tx(['queue'], 'readonly', function (t) {
        var res = [];
        var r = t.objectStore('queue').index('byKindUid').openCursor(IDBKeyRange.only([kind, String(uid)]));
        r.onsuccess = function () {
          var c = r.result;
          if (!c || (limit && res.length >= limit)) return;
          res.push(c.value);
          c.continue();
        };
        return res;
      });
    },
    remove: function (kind, uid, ids) {
      return tx(['queue'], 'readwrite', function (t) {
        var s = t.objectStore('queue');
        ids.forEach(function (id) { s.delete([kind, String(uid), String(id)]); });
      });
    },
    reject: function (kind, uid, entries) {
      return tx(['queue', 'rejected'], 'readwrite', function (t) {
        var q = t.objectStore('queue'), rj = t.objectStore('rejected');
        entries.forEach(function (e) {
          q.delete([kind, String(uid), String(e.id)]);
          rj.put({ kind: kind, uid: String(uid), id: String(e.id), reason: e.reason, item: e.item || null, ts: Date.now() });
        });
      });
    },
    markRetry: function (kind, uid, ids) {
      return tx(['queue'], 'readwrite', function (t) {
        var s = t.objectStore('queue');
        ids.forEach(function (id) {
          var g = s.get([kind, String(uid), String(id)]);
          g.onsuccess = function () {
            var v = g.result;
            if (!v) return;
            v.attempts = (v.attempts || 0) + 1;
            v.nextTry = Date.now() + Math.min(30 * 60 * 1000, 5000 * Math.pow(2, Math.min(v.attempts, 9)));
            s.put(v);
          };
        });
      });
    },
    /** Anzahl offener Einträge je Benutzer (für Abmelde-Warnung). */
    count: function (uid) {
      return tx(['queue'], 'readonly', function (t) {
        var n = { total: 0 };
        var r = t.objectStore('queue').openCursor();
        r.onsuccess = function () {
          var c = r.result;
          if (!c) return;
          if (!uid || c.value.uid === String(uid)) n.total++;
          c.continue();
        };
        return n;
      }).then(function (n) { return n.total; });
    },
    purgeOld: function () {
      var limit = Date.now() - MAX_AGE_DAYS * 86400000;
      return tx(['queue', 'rejected'], 'readwrite', function (t) {
        var r = t.objectStore('queue').index('byQueued').openCursor(IDBKeyRange.upperBound(limit));
        r.onsuccess = function () { var c = r.result; if (c) { c.delete(); c.continue(); } };
        var r2 = t.objectStore('rejected').openCursor();
        r2.onsuccess = function () { var c = r2.result; if (c) { if ((c.value.ts || 0) < limit) c.delete(); c.continue(); } };
      });
    },
    rejected: function () {
      return tx(['rejected'], 'readonly', function (t) { return reqP(t.objectStore('rejected').getAll()); }).then(function (p) { return p; });
    },
    kvGet: function (key) {
      return open().then(function (db) { return reqP(db.transaction(['kv'], 'readonly').objectStore('kv').get(key)); });
    },
    kvSet: function (key, value) {
      return tx(['kv'], 'readwrite', function (t) { t.objectStore('kv').put(value, key); });
    },
    kvDelete: function (key) {
      return tx(['kv'], 'readwrite', function (t) { t.objectStore('kv').delete(key); });
    },
    _reset: function () { dbP = null; }
  };
  window.PSSyncQueue = API;
})();

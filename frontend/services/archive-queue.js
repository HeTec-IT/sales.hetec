/*
 * PSArchivQueue – zuverlässige Archivierung (Archiv-Ausgang) für Pencil Selling.
 *
 * Warum: Der Archiv-Flow (Power Automate) wird mit mode:'no-cors' aufgerufen; die Antwort ist für den Browser
 * unlesbar. "fetch ohne Fehler" heißt nur "Anfrage abgeschickt", nicht "in SharePoint abgelegt". Außerdem gingen
 * fehlgeschlagene Archivierungen nach 24 h still verloren, und auf geteilten Tablets wurden Vorgänge dem gerade
 * angemeldeten statt dem tatsächlichen Mitarbeiter zugeordnet.
 *
 * Grundsätze:
 *  - Jede Archivierung bekommt VOR dem Versand einen dauerhaften Eintrag (IndexedDB) mit eindeutiger archiveId,
 *    eindeutigem Dateinamen (Kennzeichen "--XXXXXXX" hinter der Kennung) und dem Eigentümer (uid, Name, Shop).
 *    Diese Angaben werden nie durch einen späteren Benutzer überschrieben.
 *  - Status: sending (läuft) → handed (übergeben, wird überprüft) → verified (in SharePoint bestätigt).
 *            pending (ausstehend, automatische Wiederholung) · failed (fehlgeschlagen, sichtbar, manuell erneut senden).
 *  - "Erfolgreich" erst, wenn der Archiv-Prüfdienst (Flow "PDF Archiv API V3", Aktion exists) die Datei findet.
 *  - Wiederholung mit gleichem Dateinamen (idempotent, keine Dubletten), begrenzte Anzahl.
 *  - Nichts wird kommentarlos gelöscht: die PDF bleibt bis zur Bestätigung gespeichert; danach wird sie entfernt
 *    (Datenschutz), die Metadaten bleiben 31 Tage für die Anzeige "Meine Archivierungen".
 *  - Unabhängig von Firebase: Versand, Prüfung und Index werden als Funktionen übergeben (Azure-/Entra-tauglich).
 *  - Technisches Protokoll ohne Kundendaten (archiveId, uid, Shop, Schritt, Status, Fehlercode, Versuch).
 *
 * Läuft im Browser (window.PSArchivQueue) und in Node-Tests (globalThis.PSArchivQueue, Speicher austauschbar).
 */
(function (root) {
  'use strict';

  var SCHEMA_VERSION = 2;
  var DB_NAME = 'PencilSellingArchivQueue';
  var STORE = 'outbox';
  var LOG_KEY = 'ps_archiv_log_v1';
  var LOG_MAX = 400;
  var LOG_MAX_AGE_MS = 30 * 86400000;

  var STATUS = Object.freeze({
    SENDING: 'sending',   // Archivierung läuft
    HANDED: 'handed',     // an den Archiv-Flow übergeben – Ablage wird überprüft
    VERIFIED: 'verified', // in SharePoint gefunden – erfolgreich archiviert
    PENDING: 'pending',   // ausstehend – wird automatisch erneut gesendet (z. B. keine Verbindung)
    FAILED: 'failed'      // fehlgeschlagen – bleibt sichtbar, manuell erneut senden
  });

  var POLICY = {
    verifyGraceMs: 20 * 60000,      // so lange darf die Ablage (Flow → Mail → Ablage-Flow → SharePoint) dauern
    maxSends: 3,                    // Erstversand + 2 automatische Wiederholungen
    staleSendingMs: 3 * 60000,      // "läuft" länger als 3 Min. (App geschlossen/abgestürzt) → ausstehend
    pendingBackoffMs: [30000, 60000, 2 * 60000, 5 * 60000, 10 * 60000, 15 * 60000],
    verifyEveryMs: 60000,           // höchstens einmal pro Minute je Eintrag prüfen
    keepVerifiedMs: 31 * 86400000,  // Metadaten bestätigter Einträge (ohne PDF)
    keepUnverifiablePdfMs: 7 * 86400000 // Prüfdienst nicht verfügbar: PDF höchstens 7 Tage aufheben, Metadaten bleiben
  };

  // ── reine Hilfsfunktionen ────────────────────────────────────────────────
  var TOKEN_RE = /--([A-Za-z0-9]{4,12})$/;
  var B36 = '0123456789abcdefghijklmnopqrstuvwxyz';

  function rand(n, rnd) {
    var s = '';
    var r = rnd || defaultRandom;
    for (var i = 0; i < n; i++) s += B36.charAt(Math.floor(r() * 36) % 36);
    return s;
  }
  function defaultRandom() {
    try {
      var c = root.crypto || (root.window && root.window.crypto);
      if (c && c.getRandomValues) { var a = new Uint32Array(1); c.getRandomValues(a); return a[0] / 4294967296; }
    } catch (e) {}
    return Math.random();
  }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /** Lokales Kalenderdatum YYYY-MM-DD (nicht UTC: kurz nach Mitternacht sonst Vortag). */
  function localDate(ms) {
    var d = new Date(typeof ms === 'number' ? ms : Date.now());
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  /** Kurzkennzeichen für den Dateinamen: Uhrzeit HHMM + 3 Zufallszeichen, z. B. "1415k7q". */
  function makeToken(ms, rnd) {
    var d = new Date(typeof ms === 'number' ? ms : Date.now());
    return pad2(d.getHours()) + pad2(d.getMinutes()) + rand(3, rnd);
  }
  /** Eindeutige Archivierungs-ID (lokal, auch Korrelations-ID im Protokoll). */
  function makeArchiveId(ms, rnd) {
    return 'ar-' + (typeof ms === 'number' ? ms : Date.now()).toString(36) + '-' + rand(8, rnd);
  }
  // Zwei Namensschemata:
  //   o2:      PENCIL_[Kennung]_[Shop]_[Typ]_[Datum].pdf   → Kennung = Teil [1]
  //   Telekom: PENCIL_[Shop]_[Typ]_[Datum]_[Kennung].pdf   → Kennung = letzter Teil
  // Das Kennzeichen kommt immer an die KENNUNG, damit die vom Flow gelesenen Teile (Shop, Typ, Datum) unverändert bleiben.
  var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  function kennIndex(parts) {
    if (parts.length >= 3 && DATE_RE.test(parts[parts.length - 1])) return 1;                // o2
    if (parts.length >= 4 && DATE_RE.test(parts[parts.length - 2])) return parts.length - 1; // Telekom
    return -1;
  }
  function splitName(fileName) {
    var f = String(fileName || '');
    if (!/^PENCIL_/i.test(f)) return null;
    var ext = /\.pdf$/i.test(f) ? f.slice(-4) : '';
    var parts = (ext ? f.slice(0, -4) : f).split('_');
    var k = kennIndex(parts);
    return k < 1 ? null : { parts: parts, k: k, ext: ext };
  }
  /** Kennzeichen an die Kennung setzen: PENCIL_Mueller_Aalen_… → PENCIL_Mueller--1415k7q_Aalen_… (idempotent). */
  function uniqueFileName(fileName, token) {
    var f = String(fileName || '');
    var s = splitName(f);
    if (!s || !token) return f;
    if (TOKEN_RE.test(s.parts[s.k])) return f;
    s.parts[s.k] = s.parts[s.k] + '--' + String(token).replace(/[^A-Za-z0-9]/g, '').slice(0, 12);
    return s.parts.join('_') + s.ext;
  }
  /** Kennung eines Dateinamens ohne Kennzeichen ('' = unbekanntes Schema). */
  function kennungOf(fileName) {
    var s = splitName(fileName);
    return s ? stripToken(s.parts[s.k]) : '';
  }
  /** Kennzeichen eines Dateinamens ('' = alter Name ohne Kennzeichen). */
  function fileToken(fileName) {
    var s = splitName(fileName);
    var t = s && TOKEN_RE.exec(s.parts[s.k]);
    return t ? t[1] : '';
  }
  /** Kennung ohne Kennzeichen. */
  function stripToken(part) { return String(part == null ? '' : part).replace(TOKEN_RE, ''); }
  /** Dateiname ohne Kennzeichen (Vergleich alter/neuer Namen, Kollisions-Diagnose). */
  function baseFileName(fileName) {
    var s = splitName(fileName);
    if (!s) return String(fileName || '');
    s.parts[s.k] = stripToken(s.parts[s.k]);
    return s.parts.join('_') + s.ext;
  }
  function idOf(fileName) { return String(fileName || '').toLowerCase().replace(/[^a-z0-9._+\-]/g, '_').slice(0, 180); }

  var FILE_RE = /^PENCIL_[A-Za-z0-9+\-]+_(?:[A-Za-z0-9\-]+_)?(Angebot|Abschluss)_(\d{4}-\d{2}-\d{2})\.pdf$/;          // o2
  var FILE_RE_TK = /^PENCIL_(?:[A-Za-z0-9\-]+_)?(Angebot|Abschluss)_(\d{4}-\d{2}-\d{2})_[A-Za-z0-9+\-]+\.pdf$/;       // Telekom

  /** Vollständigkeit vor dem Versand. Rückgabe: Liste von Fehlercodes (leer = in Ordnung). */
  function validate(rec) {
    var errs = [];
    rec = rec || {};
    if (!rec.archiveId) errs.push('archiveId');
    if (!rec.uid) errs.push('uid');
    var m = FILE_RE.exec(String(rec.fileName || '')) || FILE_RE_TK.exec(String(rec.fileName || ''));
    if (!m) errs.push('fileName');
    var s = String(rec.subject || '').split('|');
    if (s.length !== 4 || s[0] !== 'PENCIL' || (s[1] !== 'angebot' && s[1] !== 'abschluss') || !/^\d{4}-\d{2}-\d{2}$/.test(s[2]) || !s[3]) errs.push('subject');
    var typ = rec.type === 'abschluss' ? 'abschluss' : rec.type === 'angebot' ? 'angebot' : '';
    if (!typ) errs.push('type');
    if (m && typ && m[1].toLowerCase() !== typ) errs.push('typeMismatch');
    if (s.length === 4 && typ && s[1] !== typ) errs.push('typeMismatch');
    if (typ === 'abschluss') {
      var kenn = kennungOf(rec.fileName);
      if (!/\d/.test(kenn) || /^keineNr$/i.test(kenn)) errs.push('abschlussOhneNummer');
    }
    if (!rec.pdfBlob && !rec.pdfRemoved) errs.push('pdf');
    if (rec.pdfBlob && typeof rec.pdfBlob.size === 'number' && rec.pdfBlob.size < 200) errs.push('pdfTooSmall');
    return errs.filter(function (e, i, a) { return a.indexOf(e) === i; });
  }
  /** Prüft die ersten Bytes auf "%PDF". */
  function isPdfBlob(blob) {
    try {
      if (!blob || typeof blob.slice !== 'function') return Promise.resolve(false);
      var part = blob.slice(0, 5);
      var p = typeof part.text === 'function' ? part.text() : new Promise(function (res) {
        var fr = new FileReader(); fr.onload = function () { res(String(fr.result || '')); }; fr.onerror = function () { res(''); }; fr.readAsText(part);
      });
      return p.then(function (t) { return String(t).indexOf('%PDF') === 0; }, function () { return false; });
    } catch (e) { return Promise.resolve(false); }
  }

  /** Was ist mit einem Eintrag als Nächstes zu tun? → 'send' | 'verify' | 'resend' | 'fail' | 'wait' | 'done' | 'purgePdf' | 'purge' */
  function nextAction(rec, now, pol) {
    pol = pol || POLICY;
    now = typeof now === 'number' ? now : Date.now();
    if (!rec) return 'wait';
    switch (rec.status) {
      case STATUS.VERIFIED:
        if (rec.pdfBlob) return 'purgePdf';
        return now - (rec.verifiedAt || rec.updatedAt || 0) > pol.keepVerifiedMs ? 'purge' : 'done';
      case STATUS.FAILED:
        return 'wait'; // nur manuell (Mitarbeiter/Admin) – nie automatisch löschen
      case STATUS.SENDING:
        return now - (rec.updatedAt || 0) > pol.staleSendingMs ? 'send' : 'wait';
      case STATUS.PENDING: {
        if (rec.blockedReason) return 'wait'; // z. B. Validierungsfehler: braucht Eingriff
        var n = Math.max(0, (rec.pendingRetries || 0) - 1);
        var wait = pol.pendingBackoffMs[Math.min(n, pol.pendingBackoffMs.length - 1)];
        if (!rec.pendingRetries) wait = 0;
        return now - (rec.lastTryAt || 0) >= wait ? 'send' : 'wait';
      }
      case STATUS.HANDED: {
        var since = now - (rec.handedAt || 0);
        if (since >= pol.verifyGraceMs && rec.verifyAvailable === true) {
          return (rec.sends || 0) >= pol.maxSends ? 'fail' : 'resend';
        }
        if (rec.verifyAvailable === false && rec.pdfBlob && since > pol.keepUnverifiablePdfMs) return 'purgePdf';
        return now - (rec.lastVerifyAt || 0) >= pol.verifyEveryMs ? 'verify' : 'wait';
      }
    }
    return 'wait';
  }

  /** Statustexte für die Oberfläche (einheitlich). */
  var LABEL = {
    sending: 'Archivierung läuft',
    handed: 'Archivierung wird überprüft',
    verified: 'Erfolgreich archiviert',
    pending: 'Archivierung ausstehend',
    failed: 'Archivierung fehlgeschlagen'
  };

  /** Alte und neue Suchindex-Einträge auf ein Format bringen (abwärtskompatibel, ändert nichts in der Datenbank). */
  function normalizeIndexEntry(e) {
    e = e || {};
    var ts = Number(e.ts);
    if (!isFinite(ts) || ts <= 0) {
      var t2 = e.ts && typeof e.ts.toMillis === 'function' ? e.ts.toMillis() : Date.parse(e.ts || e.datum || '');
      ts = isFinite(t2) ? t2 : 0;
    }
    var typ = String(e.typ || e.type || '').toLowerCase();
    return {
      fileName: String(e.fileName || e.name || ''),
      typ: typ === 'abschluss' ? 'abschluss' : 'angebot',
      shopId: String(e.shopId || e.shop || '').toLowerCase(),
      uid: String(e.uid || e.userUid || e.archivedByUserId || ''),
      agent: String(e.agent || e.employeeName || ''),
      kunde: String(e.kunde || ''),
      ruf: String(e.ruf || ''),
      datum: String(e.datum || ''),
      src: e.src === 'import' ? 'import' : 'app',
      ts: ts,
      token: fileToken(e.fileName || e.name),
      legacyName: !fileToken(e.fileName || e.name)
    };
  }

  // ── technisches Protokoll (ohne Kundendaten) ───────────────────────────────
  var memLog = [];
  function logStore() {
    try { return root.localStorage || null; } catch (e) { return null; }
  }
  function logRead() {
    var ls = logStore();
    if (!ls) return memLog.slice();
    try { var a = JSON.parse(ls.getItem(LOG_KEY) || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; }
  }
  function log(evt) {
    var e = {
      t: Date.now(),
      archiveId: String(evt && evt.archiveId || '').slice(0, 40),
      uid: String(evt && evt.uid || '').slice(0, 64),
      shopId: String(evt && evt.shopId || '').slice(0, 40),
      step: String(evt && evt.step || '').slice(0, 30),
      status: String(evt && evt.status || '').slice(0, 20),
      code: String(evt && evt.code || '').slice(0, 60),
      attempt: Number(evt && evt.attempt) || 0
    };
    var cut = Date.now() - LOG_MAX_AGE_MS;
    var a = logRead().filter(function (x) { return x && x.t > cut; });
    a.push(e);
    a = a.slice(-LOG_MAX);
    var ls = logStore();
    if (ls) { try { ls.setItem(LOG_KEY, JSON.stringify(a)); } catch (er) {} } else memLog = a;
    return e;
  }

  // ── Speicher (IndexedDB; in Tests austauschbar) ──────────────────────────────
  function idbStore(name) {
    var dbP = null;
    function open() {
      if (dbP) return dbP;
      dbP = new Promise(function (resolve, reject) {
        if (!root.indexedDB) return reject(new Error('IndexedDB nicht verfügbar'));
        var req = root.indexedDB.open(name, 1);
        req.onupgradeneeded = function () {
          var db = req.result;
          if (!db.objectStoreNames.contains(STORE)) {
            var s = db.createObjectStore(STORE, { keyPath: 'archiveId' });
            s.createIndex('byUid', 'uid');
          }
        };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
        req.onblocked = function () { reject(new Error('IndexedDB blockiert')); };
      });
      dbP.catch(function () { dbP = null; });
      return dbP;
    }
    function run(mode, fn) {
      return open().then(function (db) {
        return new Promise(function (resolve, reject) {
          var t = db.transaction(STORE, mode);
          var out;
          t.oncomplete = function () { resolve(out); };
          t.onerror = function () { reject(t.error); };
          t.onabort = function () { reject(t.error || new Error('abort')); };
          var r = fn(t.objectStore(STORE));
          if (r) r.onsuccess = function () { out = r.result; };
        });
      });
    }
    return {
      get: function (id) { return run('readonly', function (s) { return s.get(id); }); },
      put: function (rec) { return run('readwrite', function (s) { return s.put(rec); }).then(function () { return rec; }); },
      del: function (id) { return run('readwrite', function (s) { return s.delete(id); }); },
      all: function () { return run('readonly', function (s) { return s.getAll(); }).then(function (a) { return a || []; }); }
    };
  }
  function memoryStore() {
    var m = new Map();
    var clone = function (o) { return o ? Object.assign({}, o) : o; };
    return {
      get: function (id) { return Promise.resolve(clone(m.get(id))); },
      put: function (rec) { m.set(rec.archiveId, clone(rec)); return Promise.resolve(rec); },
      del: function (id) { m.delete(id); return Promise.resolve(); },
      all: function () { return Promise.resolve(Array.from(m.values()).map(clone)); },
      _map: m
    };
  }

  // ── Warteschlange ────────────────────────────────────────────────────────
  function createQueue(opts) {
    opts = opts || {};
    var store = opts.store || idbStore(opts.dbName || DB_NAME);
    var pol = Object.assign({}, POLICY, opts.policy || {});
    var clock = opts.now || function () { return Date.now(); };
    var processing = null;

    function upd(id, patch) {
      return store.get(id).then(function (cur) {
        if (!cur) return null;
        var next = Object.assign({}, cur, patch, { updatedAt: clock() });
        // Eigentümer und Identität eines Eintrags sind unveränderlich
        ['archiveId', 'uid', 'email', 'employeeName', 'shopId', 'createdAt', 'fileName', 'consultationId', 'createdByUserId'].forEach(function (k) { next[k] = cur[k]; });
        return store.put(next);
      });
    }

    function createOne(rec) {
      var now = clock();
      return store.all().then(function (all) {
          var dup = all.find(function (x) { return x && x.fileName === rec.fileName && x.uid === rec.uid; });
          if (dup) return Object.assign({ duplicate: true }, dup);
          var r = Object.assign({
            archiveId: rec.archiveId || makeArchiveId(now),
            schemaVersion: SCHEMA_VERSION,
            status: STATUS.SENDING,
            sends: 0,
            pendingRetries: 0,
            createdAt: now,
            updatedAt: now,
            archivedAt: now,
            documentVersion: 1
          }, rec);
          r.archiveId = r.archiveId || makeArchiveId(now);
          r.createdByUserId = r.createdByUserId || r.uid;
          return store.put(r).then(function () {
            log({ archiveId: r.archiveId, uid: r.uid, shopId: r.shopId, step: 'create', status: r.status });
            return r;
          });
        });
    }
    var createChain = Promise.resolve();
    // Datensparsamkeit: nach Bestätigung (PDF gelöscht) und vorhandenem Suchindex-Eintrag werden auch Kundenname und
    // Rufnummer aus dem lokalen Eintrag entfernt – angezeigt wird dann aus dem Suchindex.
    function minimize(r) {
      if (!r || r.status !== STATUS.VERIFIED || !r.indexed || (!r.kunde && !r.ruf)) return r;
      return upd(r.archiveId, { kunde: '', ruf: '' });
    }

    var api = {
      store: store,
      policy: pol,
      /**
       * Neuen Eintrag anlegen (VOR dem Versand). Gleicher Dateiname eines noch nicht fehlgeschlagenen Eintrags
       * → vorhandener Eintrag wird zurückgegeben (Schutz vor Doppelklick/doppelter Archivierung).
       */
      create: function (rec) {
        // nacheinander anlegen: zwei gleichzeitige Aufrufe (Doppeltipp) ergeben genau einen Eintrag
        var job = createChain.then(function () { return createOne(rec); });
        createChain = job.catch(function () {});
        return job;
      },
      get: function (id) { return store.get(id); },
      update: upd,
      all: function () { return store.all(); },
      /** Nur Einträge dieses Benutzers (Trennung der Mitarbeiterkonten auf geteilten Geräten). */
      listForUser: function (uid) {
        uid = String(uid || '');
        return store.all().then(function (a) { return a.filter(function (x) { return x && uid && x.uid === uid; }).sort(function (x, y) { return (y.createdAt || 0) - (x.createdAt || 0); }); });
      },
      /** Zähler ohne Kundendaten (für Hinweise/Diagnose). */
      counts: function (uid) {
        return store.all().then(function (a) {
          var c = { own: {}, foreignOpen: 0 };
          a.forEach(function (x) {
            if (!x) return;
            if (uid && x.uid === uid) c.own[x.status] = (c.own[x.status] || 0) + 1;
            else if (x.status !== STATUS.VERIFIED) c.foreignOpen++;
          });
          return c;
        });
      },
      /** Manuell erneut senden (fehlgeschlagen/ausstehend). Nur Eigentümer oder Admin. */
      retry: function (id, actor) {
        return store.get(id).then(function (r) {
          if (!r) return null;
          if (!actor || (actor.uid !== r.uid && !actor.isAdmin)) throw Object.assign(new Error('forbidden'), { code: 'forbidden' });
          if (!r.pdfBlob) throw Object.assign(new Error('Keine PDF mehr gespeichert'), { code: 'nopdf' });
          log({ archiveId: r.archiveId, uid: r.uid, shopId: r.shopId, step: 'retry-manual', status: STATUS.PENDING, attempt: r.sends });
          return upd(id, { status: STATUS.PENDING, pendingRetries: 0, lastTryAt: 0, blockedReason: '', manualRetries: (r.manualRetries || 0) + 1, sends: Math.min(r.sends || 0, pol.maxSends - 1) });
        });
      },
      /** Bewusst verwerfen (mit Bestätigung in der Oberfläche). Nur Eigentümer oder Admin. Wird protokolliert. */
      discard: function (id, actor) {
        return store.get(id).then(function (r) {
          if (!r) return false;
          if (!actor || (actor.uid !== r.uid && !actor.isAdmin)) throw Object.assign(new Error('forbidden'), { code: 'forbidden' });
          log({ archiveId: r.archiveId, uid: r.uid, shopId: r.shopId, step: 'discard', status: r.status, code: actor.uid === r.uid ? 'owner' : 'admin' });
          return store.del(id).then(function () { return true; });
        });
      },
      /**
       * Einen Durchlauf ausführen.
       * deps: {
       *   uid,                          aktuell angemeldeter Benutzer
       *   online: () => bool,
       *   send: rec => Promise<{ok, error?, code?}>,     Übergabe an den Archiv-Flow
       *   verify: names => Promise<{available, found:Set<id>}>,
       *   recordIndex: rec => Promise<bool>,             Suchindex-Eintrag mit uid/Shop DES EIGENTÜMERS
       *   onEvent: ({type, rec}) => void
       * }
       * Fremde Einträge (anderer Benutzer am selben Gerät) werden mit ihren ORIGINALEN Angaben übergeben,
       * damit nichts verloren geht – die Zuordnung bleibt beim Eigentümer. Benachrichtigt wird nur der Eigentümer.
       */
      process: function (deps) {
        if (processing) return processing;
        deps = deps || {};
        var run = function () { return runProcess(deps); };
        // Mehrere Tabs/Fenster: nur einer arbeitet gleichzeitig (Web Locks, wo verfügbar)
        var locks = null;
        try { locks = opts.useLocks !== false && root.navigator && root.navigator.locks; } catch (e) { locks = null; }
        var job = locks ? locks.request('ps-archiv-queue', { ifAvailable: true }, function (lock) { return lock ? run() : { skipped: true }; }) : run();
        processing = Promise.resolve(job).then(function (r) { processing = null; return r; }, function (e) { processing = null; throw e; });
        return processing;
      }
    };

    function emit(deps, type, rec) {
      try { if (deps.onEvent && rec && rec.uid === deps.uid) deps.onEvent({ type: type, rec: rec }); } catch (e) {}
    }

    function doSend(deps, rec) {
      var now = clock();
      var errs = validate(rec);
      if (errs.length) {
        log({ archiveId: rec.archiveId, uid: rec.uid, shopId: rec.shopId, step: 'validate', status: STATUS.FAILED, code: errs.join(',') });
        return upd(rec.archiveId, { status: STATUS.FAILED, lastError: 'validation:' + errs.join(','), blockedReason: 'validation' }).then(function (r) { emit(deps, 'failed', r); return r; });
      }
      if (deps.online && !deps.online()) {
        return upd(rec.archiveId, { status: STATUS.PENDING, lastTryAt: now, lastError: 'offline', pendingRetries: (rec.pendingRetries || 0) + 1 });
      }
      var attempt = (rec.sends || 0) + 1;
      return upd(rec.archiveId, { status: STATUS.SENDING, lastTryAt: now }).then(function () {
        log({ archiveId: rec.archiveId, uid: rec.uid, shopId: rec.shopId, step: 'send', status: STATUS.SENDING, attempt: attempt });
        return Promise.resolve().then(function () { return deps.send(rec); }).catch(function (e) { return { ok: false, error: e }; });
      }).then(function (res) {
        if (res && res.ok === true) {
          log({ archiveId: rec.archiveId, uid: rec.uid, shopId: rec.shopId, step: 'handed', status: STATUS.HANDED, attempt: attempt });
          return upd(rec.archiveId, { status: STATUS.HANDED, sends: attempt, handedAt: clock(), lastError: '', pendingRetries: 0, lastVerifyAt: 0 }).then(function (r) {
            // Suchindex nur unter der Anmeldung des Eigentümers schreiben (ein anderer Benutzer würde – je nach
            // Backend – als Eigentümer eingetragen). Fremde Einträge holt der Eigentümer bei seiner nächsten Anmeldung nach.
            if (r && !r.indexed && deps.recordIndex && r.uid === deps.uid) {
              return Promise.resolve().then(function () { return deps.recordIndex(r); }).catch(function () { return false; }).then(function (ok) {
                return ok ? upd(r.archiveId, { indexed: true }) : r;
              });
            }
            return r;
          });
        }
        var code = (res && (res.code || (res.error && (res.error.code || res.error.name)))) || 'send-failed';
        log({ archiveId: rec.archiveId, uid: rec.uid, shopId: rec.shopId, step: 'send', status: STATUS.PENDING, code: String(code), attempt: attempt });
        return upd(rec.archiveId, { status: STATUS.PENDING, lastError: String(code).slice(0, 80), pendingRetries: (rec.pendingRetries || 0) + 1, lastTryAt: clock() });
      });
    }

    function runProcess(deps) {
      var stats = { sent: 0, verified: 0, failed: 0, pending: 0, purged: 0 };
      return store.all().then(function (all) {
        var now = clock();
        var work = all.filter(Boolean).sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
        var chain = Promise.resolve();
        // 1) Versand / Wiederholung / Aufräumen
        var toVerify = [];
        work.forEach(function (rec) {
          var act = nextAction(rec, now, pol);
          if (act === 'send' || act === 'resend') {
            chain = chain.then(function () {
              if (act === 'resend') log({ archiveId: rec.archiveId, uid: rec.uid, shopId: rec.shopId, step: 'resend', status: STATUS.PENDING, code: 'not-found-after-grace', attempt: rec.sends });
              return doSend(deps, rec).then(function (r) { if (r && r.status === STATUS.HANDED) stats.sent++; else if (r && r.status === STATUS.PENDING) stats.pending++; });
            });
          } else if (act === 'verify') {
            toVerify.push(rec);
          } else if (act === 'fail') {
            chain = chain.then(function () {
              log({ archiveId: rec.archiveId, uid: rec.uid, shopId: rec.shopId, step: 'verify', status: STATUS.FAILED, code: 'not-found', attempt: rec.sends });
              return upd(rec.archiveId, { status: STATUS.FAILED, lastError: 'not-found-in-archive' }).then(function (r) { stats.failed++; emit(deps, 'failed', r); });
            });
          } else if (act === 'purgePdf') {
            chain = chain.then(function () {
              return upd(rec.archiveId, { pdfBlob: null, pdfRemoved: true, pdfRemovedAt: clock() }).then(function () { stats.purged++; });
            });
          } else if (act === 'purge') {
            chain = chain.then(function () { return store.del(rec.archiveId).then(function () { stats.purged++; }); });
          }
          // Suchindex für eigene, bereits übergebene Einträge nachholen (z. B. war beim Archivieren Firestore nicht erreichbar)
          if (act !== 'send' && act !== 'resend' && act !== 'purge' && rec.uid === deps.uid && !rec.indexed && (rec.status === STATUS.HANDED || rec.status === STATUS.VERIFIED) && deps.recordIndex) {
            chain = chain.then(function () {
              return Promise.resolve().then(function () { return deps.recordIndex(rec); }).catch(function () { return false; }).then(function (ok) { if (ok) return upd(rec.archiveId, { indexed: true }).then(minimize); });
            });
          }
        });
        // 2) Ablage prüfen (gebündelt)
        return chain.then(function () {
          if (!toVerify.length || !deps.verify || (deps.online && !deps.online())) return;
          var names = toVerify.map(function (r) { return r.fileName; });
          return Promise.resolve().then(function () { return deps.verify(names); }).catch(function () { return { available: false, found: new Set() }; }).then(function (v) {
            var found = (v && v.found) || new Set();
            var avail = !!(v && v.available);
            return toVerify.reduce(function (p, rec) {
              return p.then(function () {
                if (avail && found.has(idOf(rec.fileName))) {
                  log({ archiveId: rec.archiveId, uid: rec.uid, shopId: rec.shopId, step: 'verify', status: STATUS.VERIFIED, attempt: rec.sends });
                  return upd(rec.archiveId, { status: STATUS.VERIFIED, verifiedAt: clock(), verifyAvailable: true, lastVerifyAt: clock(), pdfBlob: null, pdfRemoved: true }).then(function (r) {
                    stats.verified++;
                    emit(deps, 'verified', r);
                    return minimize(r);
                  });
                }
                return upd(rec.archiveId, { lastVerifyAt: clock(), verifyAvailable: avail ? true : (rec.verifyAvailable === true ? true : false) });
              });
            }, Promise.resolve());
          });
        });
      }).then(function () { return stats; });
    }

    /** Einen einzelnen Eintrag sofort prüfen (Bestätigungsanzeige direkt nach dem Archivieren). */
    api.verifyNow = function (id, deps) {
      return store.get(id).then(function (rec) {
        if (!rec) return null;
        if (rec.status === STATUS.VERIFIED) return rec;
        if (rec.status !== STATUS.HANDED || !deps || !deps.verify) return rec;
        return Promise.resolve().then(function () { return deps.verify([rec.fileName]); }).catch(function () { return { available: false, found: new Set() }; }).then(function (v) {
          if (v && v.available && v.found && v.found.has(idOf(rec.fileName))) {
            log({ archiveId: rec.archiveId, uid: rec.uid, shopId: rec.shopId, step: 'verify', status: STATUS.VERIFIED, attempt: rec.sends });
            return upd(id, { status: STATUS.VERIFIED, verifiedAt: clock(), verifyAvailable: true, lastVerifyAt: clock(), pdfBlob: null, pdfRemoved: true }).then(minimize);
          }
          return upd(id, { lastVerifyAt: clock(), verifyAvailable: !!(v && v.available) || rec.verifyAvailable === true });
        });
      });
    };
    /** Einen einzelnen Eintrag sofort senden (erster Versuch direkt beim Archivieren). */
    api.sendNow = function (id, deps) {
      return store.get(id).then(function (rec) {
        if (!rec) return null;
        if (rec.status === STATUS.HANDED || rec.status === STATUS.VERIFIED) return rec;
        return doSend(deps || {}, rec);
      });
    };
    return api;
  }

  var API = {
    SCHEMA_VERSION: SCHEMA_VERSION,
    STATUS: STATUS,
    LABEL: LABEL,
    POLICY: POLICY,
    localDate: localDate,
    makeToken: makeToken,
    makeArchiveId: makeArchiveId,
    uniqueFileName: uniqueFileName,
    fileToken: fileToken,
    stripToken: stripToken,
    kennungOf: kennungOf,
    baseFileName: baseFileName,
    idOf: idOf,
    validate: validate,
    isPdfBlob: isPdfBlob,
    nextAction: nextAction,
    normalizeIndexEntry: normalizeIndexEntry,
    log: log,
    readLog: logRead,
    memoryStore: memoryStore,
    idbStore: idbStore,
    createQueue: createQueue
  };
  var _default = null;
  /** Standard-Warteschlange des Browsers (IndexedDB, je Marke eigene Datenbank). */
  API.queue = function (brand) {
    if (!_default) _default = createQueue({ dbName: DB_NAME + '_' + String(brand || 'o2') });
    return _default;
  };
  root.PSArchivQueue = API;
})(typeof window !== 'undefined' ? window : globalThis);

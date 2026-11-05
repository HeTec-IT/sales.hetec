'use strict';
// Prueft die Firestore-kompatible Client-Schicht (ps-backend.js) gegen die ECHTE
// Server-Logik + Azurite: Browser-Umgebung und Microsoft-Bibliothek sind nachgebaut.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { startAzurite, testConfig, makeKeys, G } = require('./helpers');
const { createApp } = require('../src/lib/app');
const { createVerifier } = require('../src/lib/auth');
const { Store } = require('../src/lib/store');

let az, keys, core;
test.before(async () => {
  az = await startAzurite();
  keys = await makeKeys();
  const cfg = testConfig('c' + Date.now());
  core = createApp({ cfg, verify: createVerifier(cfg, keys.resolver), store: Store.fromConfig(cfg) });
});
test.after(() => az && az.stop());

// Baut eine Browser-Umgebung und laedt ps-backend.js hinein.
async function boot(opts) {
  opts = opts || {};
  const store = {};
  const events = { loginRedirect: 0, logout: [], fetches: 0 };
  const acc = opts.account === undefined ? { username: 'm.muster@hetec-gmbh.de', name: 'Max Muster', localAccountId: 'oid-max', idTokenClaims: { oid: 'oid-max' } } : opts.account;
  class PCA {
    constructor() {}
    async initialize() {}
    async handleRedirectPromise() { return null; }
    getActiveAccount() { return acc; }
    getAllAccounts() { return acc ? [acc] : []; }
    setActiveAccount() {}
    async acquireTokenSilent(req) {
      if (opts.expired) { const e = new Error('x'); e.errorCode = 'interaction_required'; throw e; }
      const idToken = await keys.token({ oid: acc.localAccountId, preferred_username: acc.username, name: acc.name, groups: opts.groups || [G.aalen] });
      return { idToken, account: acc };
    }
    async loginRedirect() { events.loginRedirect++; }
    async logoutRedirect(r) { events.logout.push(!!r.onRedirectNavigate); }
  }
  const listeners = {};
  const body = { children: [], appendChild(el) { this.children.push(el); } };
  const win = {
    PS_CONFIG: { tenantId: 'tenant', clientId: 'client', apiBase: '/api' },
    msal: { PublicClientApplication: PCA },
    addEventListener() {}, removeEventListener() {}
  };
  const sandbox = {
    window: win, console, setTimeout, clearTimeout, setInterval, clearInterval, JSON, Promise, Date, Math, Object, Array, String, Number, Error, Uint8Array,
    location: { origin: 'https://sales.example', href: 'https://sales.example/' },
    localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
    document: { body, visibilityState: 'visible', addEventListener() {}, removeEventListener() {}, getElementById: () => null, createElement: () => ({ style: {}, appendChild() {}, set innerHTML(v) {} }) },
    crypto: { getRandomValues: a => { for (let i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 256); return a; } },
    AbortController,
    fetch: async (url, init) => {
      events.fetches++;
      if (opts.offline) throw new Error('offline');
      assert.equal(url, '/api/db');
      const res = await core.handle(init.headers['x-ps-token'] || '', JSON.parse(init.body));
      return { status: res.status, text: async () => JSON.stringify(res.json) };
    }
  };
  sandbox.window.window = win;
  sandbox.globalThis = sandbox;
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'ps-backend.js'), 'utf8');
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  const fb = win.firebase;
  const user = await new Promise(res => fb.auth().onAuthStateChanged(res));
  return { fb, user, events, store, win, db: fb.firestore() };
}

const rejectsWith = async (p, code) => { try { await p; } catch (e) { assert.equal(e.code, code, e.message); return; } assert.fail('haette abgelehnt werden muessen (' + code + ')'); };

test('Anmeldung: Benutzerobjekt, Profil, Rollen aus Gruppen', async () => {
  const { fb, user, db } = await boot({ groups: [G.aalen] });
  assert.equal(user.uid, 'oid-max'); assert.equal(user.email, 'm.muster@hetec-gmbh.de'); assert.equal(user.emailVerified, true);
  assert.equal(fb.auth().currentUser.uid, 'oid-max');
  assert.ok((await user.getIdToken(true)).split('.').length === 3);
  const snap = await db.collection('users').doc(user.uid).get();
  assert.equal(snap.exists, true); assert.equal(snap.id, 'oid-max');
  const p = snap.data(); assert.equal(p.status, 'approved'); assert.equal(p.shopId, 'aalen'); assert.equal(snap.metadata.fromCache, false);
  assert.ok(fb.apps.length === 0); const app = fb.initializeApp({}, 'stats'); assert.equal(fb.apps.length, 1); assert.equal(app.auth().currentUser.uid, 'oid-max');
  await rejectsWith(fb.auth().signInWithEmailAndPassword('a', 'b'), 'auth/operation-not-allowed');
});

test('Firestore-API: set/get/update/merge/increment/delete/add/where/orderBy/limit/startAfter/batch', async () => {
  const { fb, user, db } = await boot({ groups: [G.aalen] });
  const FV = fb.firestore.FieldValue;
  // Analytics schreiben (Server setzt userUid) und seitenweise lesen
  for (let i = 1; i <= 5; i++) await db.collection('analytics').doc('r' + i).set({ id: 'r' + i, user: 'Max', shopId: 'aalen', ts: '2026-11-0' + i, serverTime: FV.serverTimestamp() });
  const one = await db.collection('analytics').doc('r3').get();
  assert.equal(one.data().userUid, 'oid-max'); assert.equal(typeof one.data().serverTime, 'number');
  const pages = []; let last = null;
  for (;;) {
    let q = db.collection('analytics').orderBy('ts', 'desc'); if (last) q = q.startAfter(last);
    const s = await q.limit(2).get(); s.forEach(d => pages.push(d.id));
    if (s.docs.length < 2) break; last = s.docs[s.docs.length - 1];
  }
  assert.deepEqual(pages, ['r5', 'r4', 'r3', 'r2', 'r1']);
  const q2 = await db.collection('analytics').where('userUid', '==', user.uid).orderBy(fb.firestore.FieldPath.documentId()).get();
  assert.equal(q2.size, 5); assert.equal(q2.empty, false); assert.deepEqual(q2.docs.map(d => d.id), ['r1', 'r2', 'r3', 'r4', 'r5']);
  assert.equal(typeof q2.docs[0].ref.delete, 'function');
  // merge + increment
  const ref = db.collection('skip_limits').doc('skip_Max_2026-11');
  await ref.set({ agent: 'Max', count: FV.increment(1) }, { merge: true });
  await ref.set({ agent: 'Max', count: FV.increment(1) }, { merge: true });
  assert.equal((await ref.get()).data().count, 2);
  // fehlendes Dokument
  const none = await db.collection('news').doc('o2').get(); assert.equal(none.exists, false); assert.equal(none.data(), undefined);
  // nicht erlaubt -> code 'permission-denied' (wie Firestore)
  await rejectsWith(db.collection('news').doc('o2').set({ text: 'x' }), 'permission-denied');
  await rejectsWith(db.collection('analytics').where('userUid', '==', 'fremd').get(), 'permission-denied');
  // add + Batch (nur Admin darf loeschen -> hier Fehler)
  const added = await db.collection('saved_offers').add({ shopId: 'aalen', kunde: 'Z' }); assert.ok(added.id.length >= 10);
  assert.equal((await db.collection('saved_offers').doc(added.id).get()).data().kunde, 'Z');
  await db.collection('saved_offers').doc(added.id).update({ kunde: 'Y' });
  assert.equal((await db.collection('saved_offers').where('shopId', '==', 'aalen').get()).docs[0].data().kunde, 'Y');
  await db.collection('saved_offers').doc(added.id).delete();
  const b = db.batch(); b.delete(db.collection('analytics').doc('r1')); await rejectsWith(b.commit(), 'permission-denied');
});

test('Admin: Batch-Update und Loeschen', async () => {
  const { db } = await boot({ groups: [G.admin], account: { username: 'd.dasilva@hetec-gmbh.de', name: 'Diego da Silva', localAccountId: 'oid-adm', idTokenClaims: { oid: 'oid-adm' } } });
  await db.collection('analytics').doc('b1').set({ id: 'b1', shopId: 'aalen', user: 'X', userUid: '' });
  await db.collection('analytics').doc('b2').set({ id: 'b2', shopId: 'aalen', user: 'X', userUid: '' });
  const snap = await db.collection('analytics').get();
  const b = db.batch(); snap.docs.forEach(d => b.update(d.ref, { marked: true })); await b.commit();
  assert.equal((await db.collection('analytics').doc('b1').get()).data().marked, true);
  const d = db.batch(); snap.docs.forEach(x => d.delete(x.ref)); await d.commit();
  assert.equal((await db.collection('analytics').get()).size, 0);
});

test('Offline: Profil kommt aus dem lokalen Speicher, Schreiben meldet "unavailable"', async () => {
  const first = await boot({ groups: [G.aalen] });
  await first.db.collection('users').doc('oid-max').get();
  const cached = first.store['ps_profile_cache_oid-max'];
  assert.ok(cached);
  const off = await boot({ groups: [G.aalen], offline: true });
  Object.assign(off.store, { 'ps_profile_cache_oid-max': cached });
  const snap = await off.db.collection('users').doc('oid-max').get();
  assert.equal(snap.metadata.fromCache, true); assert.equal(snap.data().shopId, 'aalen');
  await rejectsWith(off.db.collection('analytics').doc('o1').set({ shopId: 'aalen' }), 'unavailable');
});

test('Abgelaufene Anmeldung: Benutzer gilt als abgemeldet; keine Einrichtung: klare Meldung', async () => {
  const { user, fb } = await boot({ expired: true });
  assert.equal(user, null);
  const noCfg = await (async () => { // Platzhalter nicht ersetzt
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'ps-backend.js'), 'utf8');
    const win = { PS_CONFIG: { tenantId: 'TENANT-ID-EINTRAGEN', clientId: 'CLIENT-ID-EINTRAGEN' }, addEventListener() {} };
    const sb = { window: win, console, setTimeout, clearTimeout, setInterval, clearInterval, JSON, Promise, Date, Object, Array, String, Number, Error, location: { origin: 'x' }, localStorage: {}, document: {}, fetch() {} };
    vm.createContext(sb); vm.runInContext(src, sb);
    const u = await new Promise(r => win.firebase.auth().onAuthStateChanged(r));
    return { u, err: win.firebase.auth().lastError };
  })();
  assert.equal(noCfg.u, null); assert.equal(noCfg.err.code, 'auth/not-configured'); assert.match(noCfg.err.message, /ps-config\.js/);
});

test('Abmelden: lokal (ohne Weiterleitung) oder vollstaendig', async () => {
  const a = await boot({}); await a.fb.auth().signOut(); assert.deepEqual(a.events.logout, [true]); assert.equal(a.fb.auth().currentUser, null);
  const b = await boot({});
  let resolved = false; b.fb.auth().signOut({ full: true }).then(() => { resolved = true; });
  await new Promise(r => setTimeout(r, 100));
  assert.deepEqual(b.events.logout, [false]);
  assert.equal(resolved, false, 'bleibt offen, damit ein folgendes location.reload() die Weiterleitung nicht abbricht');
  const c = await boot({}); await c.fb.auth().signInWithMicrosoft(); assert.equal(c.events.loginRedirect, 1);
});

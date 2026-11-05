'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startAzurite, testConfig, makeKeys, G } = require('./helpers');
const { createApp } = require('../src/lib/app');
const { createVerifier } = require('../src/lib/auth');
const { Store } = require('../src/lib/store');

let az, keys, app, call;
const user = (oid, mail, groups, name) => keys.token({ oid, preferred_username: mail, groups, name: name || 'Max Muster' });

test.before(async () => {
  az = await startAzurite();
  keys = await makeKeys();
  const cfg = testConfig('t' + Date.now());
  app = createApp({ cfg, verify: createVerifier(cfg, keys.resolver), store: Store.fromConfig(cfg) });
  call = async (token, body) => app.handle(token, body);
});
test.after(() => az && az.stop());

const ok = r => { assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json; };
const denied = (r, code) => { assert.notEqual(r.status, 200, 'sollte abgelehnt werden'); assert.equal(r.json.code, code || 'permission-denied', JSON.stringify(r.json)); };

test('Login-Token: ohne/falsch/abgelaufen wird abgelehnt', async () => {
  denied(await call('', { op: 'get', c: 'news', id: 'o2' }), 'unauthenticated');
  denied(await call('x.y.z', { op: 'get', c: 'news', id: 'o2' }), 'unauthenticated');
  const wrongAud = await keys.token({}, { aud: 'anderer-client' });
  denied(await call(wrongAud, { op: 'get', c: 'news', id: 'o2' }), 'unauthenticated');
  const wrongIss = await keys.token({}, { iss: 'https://login.microsoftonline.com/evil/v2.0' });
  denied(await call(wrongIss, { op: 'get', c: 'news', id: 'o2' }), 'unauthenticated');
  const expired = await keys.token({}, { exp: Math.floor(Date.now() / 1000) - 600 });
  denied(await call(expired, { op: 'get', c: 'news', id: 'o2' }), 'unauthenticated');
});

test('Profil kommt aus Gruppen: Verkaeufer, Admin, ohne Gruppe, fremde Domain', async () => {
  const t = await user('oid-max', 'm.muster@hetec-gmbh.de', [G.aalen]);
  let p = ok(await call(t, { op: 'get', c: 'users', id: 'oid-max' })).doc.data;
  assert.equal(p.active, true); assert.equal(p.status, 'approved'); assert.equal(p.role, 'verkaeufer');
  assert.equal(p.shopId, 'aalen'); assert.equal(p.vorname, 'Max'); assert.equal(p.nachname, 'Muster'); assert.equal(p.allShops, false);

  const a = await user('oid-adm', 'd.dasilva@hetec-gmbh.de', [G.admin], 'Diego da Silva');
  p = ok(await call(a, { op: 'get', c: 'users', id: 'oid-adm' })).doc.data;
  assert.equal(p.role, 'admin'); assert.equal(p.allShops, true); assert.equal(p.vorname, 'Diego'); assert.equal(p.nachname, 'da Silva');

  const n = await user('oid-none', 'x.y@hetec-gmbh.de', []);
  p = ok(await call(n, { op: 'get', c: 'users', id: 'oid-none' })).doc.data;
  assert.equal(p.active, false); assert.equal(p.status, 'no-group');
  denied(await call(n, { op: 'get', c: 'news', id: 'o2' }));
  denied(await call(n, { op: 'set', c: 'analytics', id: 'a1', data: { shopId: 'aalen' } }));

  const f = await user('oid-ext', 'x@fremd.de', [G.aalen]);
  p = ok(await call(f, { op: 'get', c: 'users', id: 'oid-ext' })).doc.data;
  assert.equal(p.active, false); assert.equal(p.status, 'domain');

  // Fremdes Profil lesen / Rolle selbst aendern geht nicht
  denied(await call(t, { op: 'get', c: 'users', id: 'oid-adm' }));
  denied(await call(t, { op: 'update', c: 'users', id: 'oid-max', data: { role: 'admin' } }));
  ok(await call(t, { op: 'update', c: 'users', id: 'oid-max', data: { vorname: 'Maximilian', nachname: 'Muster', name: 'Maximilian Muster' } }));
  p = ok(await call(t, { op: 'get', c: 'users', id: 'oid-max' })).doc.data;
  assert.equal(p.role, 'verkaeufer'); assert.equal(p.name, 'Maximilian Muster');
});

test('Analytics: eigene Zeilen schreiben/lesen, fremde gesperrt, Staff sieht alle, Paging', async () => {
  const max = await user('oid-max', 'm.muster@hetec-gmbh.de', [G.aalen]);
  const eva = await user('oid-eva', 'e.klein@hetec-gmbh.de', [G.hall], 'Eva Klein');
  const reg = await user('oid-reg', 'r.leiter@hetec-gmbh.de', [G.regional], 'Rita Leiter');
  for (let i = 1; i <= 7; i++) {
    ok(await call(max, { op: 'set', c: 'analytics', id: 'm' + i, data: { id: 'm' + i, userUid: 'oid-max', user: 'Max', shopId: 'aalen', ts: '2026-11-0' + i + 'T10:00:00Z' } }));
  }
  ok(await call(eva, { op: 'set', c: 'analytics', id: 'e1', data: { id: 'e1', user: 'Eva', shopId: 'schwaebisch-hall', ts: '2026-11-05T09:00:00Z' } }));
  // userUid wird serverseitig gesetzt
  const e1 = ok(await call(eva, { op: 'get', c: 'analytics', id: 'e1' })).doc.data;
  assert.equal(e1.userUid, 'oid-eva');
  // fremde userUid / fremder Shop / fremde Zeile ueberschreiben
  denied(await call(max, { op: 'set', c: 'analytics', id: 'x1', data: { userUid: 'oid-eva', shopId: 'aalen' } }));
  denied(await call(max, { op: 'set', c: 'analytics', id: 'x2', data: { shopId: 'schwaebisch-hall' } }));
  denied(await call(max, { op: 'set', c: 'analytics', id: 'e1', data: { shopId: 'aalen' } }));
  denied(await call(max, { op: 'get', c: 'analytics', id: 'e1' }));
  denied(await call(max, { op: 'delete', c: 'analytics', id: 'm1' }));
  // Mitarbeiter-Abfrage: nur eigene, auch ohne Filter
  let r = ok(await call(max, { op: 'query', c: 'analytics', where: [['userUid', '==', 'oid-max']], orderBy: [['__name__', 'asc']] }));
  assert.equal(r.docs.length, 7);
  r = ok(await call(max, { op: 'query', c: 'analytics' }));
  assert.equal(r.docs.length, 7);
  denied(await call(max, { op: 'query', c: 'analytics', where: [['userUid', '==', 'oid-eva']] }));
  // Staff: alles, absteigend nach ts, in Seiten zu 3
  r = ok(await call(reg, { op: 'query', c: 'analytics', orderBy: [['ts', 'desc']] }));
  assert.equal(r.docs.length, 8); assert.equal(r.docs[0].id, 'm7'); assert.equal(r.docs[7].id, 'm1');
  const seen = []; let after = null;
  for (let i = 0; i < 10; i++) {
    const p = ok(await call(reg, { op: 'query', c: 'analytics', orderBy: [['ts', 'desc']], limit: 3, after }));
    p.docs.forEach(d => seen.push(d.id));
    if (p.docs.length < 3) break;
    const last = p.docs[p.docs.length - 1];
    after = { id: last.id, values: [last.data.ts] };
  }
  assert.deepEqual(seen, ['m7', 'm6', 'm5', 'e1', 'm4', 'm3', 'm2', 'm1']);
  // Nur Admin darf loeschen / Batch
  const adm = await user('oid-adm', 'd.dasilva@hetec-gmbh.de', [G.admin], 'Diego da Silva');
  denied(await call(reg, { op: 'delete', c: 'analytics', id: 'm1' }));
  ok(await call(adm, { op: 'batch', ops: [{ op: 'update', c: 'analytics', id: 'm2', data: { note: 'x' } }, { op: 'delete', c: 'analytics', id: 'm1' }] }));
  assert.equal(ok(await call(adm, { op: 'get', c: 'analytics', id: 'm1' })).doc, null);
  assert.equal(ok(await call(adm, { op: 'get', c: 'analytics', id: 'm2' })).doc.data.note, 'x');
  denied(await call(adm, { op: 'update', c: 'analytics', id: 'gibtsnicht', data: { a: 1 } }), 'not-found');
});

test('saved_offers und pdf_index: Standort-Trennung', async () => {
  const max = await user('oid-max', 'm.muster@hetec-gmbh.de', [G.aalen]);
  const eva = await user('oid-eva', 'e.klein@hetec-gmbh.de', [G.hall]);
  const spr = await user('oid-spr', 's.sprung@hetec-gmbh.de', [G.springer, G.aalen], 'Sam Sprung');
  ok(await call(max, { op: 'set', c: 'saved_offers', id: 'o1', data: { id: 'o1', shopId: 'aalen', kunde: 'A' } }));
  ok(await call(eva, { op: 'set', c: 'saved_offers', id: 'o2', data: { id: 'o2', shopId: 'schwaebisch-hall', kunde: 'B' } }));
  denied(await call(max, { op: 'set', c: 'saved_offers', id: 'o3', data: { shopId: 'schwaebisch-hall' } }));
  denied(await call(max, { op: 'get', c: 'saved_offers', id: 'o2' }));
  denied(await call(max, { op: 'delete', c: 'saved_offers', id: 'o2' }));
  assert.deepEqual(ok(await call(max, { op: 'query', c: 'saved_offers' })).docs.map(d => d.id), ['o1']);
  assert.equal(ok(await call(spr, { op: 'query', c: 'saved_offers' })).docs.length, 2);
  denied(await call(max, { op: 'query', c: 'saved_offers', where: [['shopId', '==', 'schwaebisch-hall']] }));

  const entry = (n, shop, keys) => ({ fileName: n, shopId: shop, kunde: n, keys, ts: 1, uid: 'fremd' });
  ok(await call(max, { op: 'set', c: 'pdf_index', id: 'f1', data: entry('f1', 'aalen', ['n:mue', 'n:mues', 'p:0711123']) }));
  ok(await call(max, { op: 'set', c: 'pdf_index', id: 'f2', data: entry('f2', 'aalen', ['n:sch']) }));
  ok(await call(eva, { op: 'set', c: 'pdf_index', id: 'f3', data: entry('f3', 'schwaebisch-hall', ['n:mue']) }));
  assert.equal(ok(await call(max, { op: 'get', c: 'pdf_index', id: 'f1' })).doc.data.uid, 'oid-max');
  let r = ok(await call(max, { op: 'query', c: 'pdf_index', where: [['shopId', '==', 'aalen'], ['keys', 'array-contains', 'n:mue']], limit: 150 }));
  assert.deepEqual(r.docs.map(d => d.id), ['f1']);
  r = ok(await call(max, { op: 'query', c: 'pdf_index', where: [['keys', 'array-contains', 'n:mue']] }));
  assert.deepEqual(r.docs.map(d => d.id), ['f1']); // nur eigener Standort
  denied(await call(max, { op: 'query', c: 'pdf_index', where: [['shopId', '==', 'schwaebisch-hall']], limit: 1 }));
  denied(await call(max, { op: 'set', c: 'pdf_index', id: 'f3', data: entry('f3', 'aalen', []) }));
});

test('skip_limits / tool_usage / news / aktionsmappe', async () => {
  const max = await user('oid-max', 'm.muster@hetec-gmbh.de', [G.aalen]);
  const reg = await user('oid-reg', 'r.leiter@hetec-gmbh.de', [G.regional]);
  const adm = await user('oid-adm', 'd.dasilva@hetec-gmbh.de', [G.admin]);
  const inc = { __ps: 'inc', n: 1 };
  const id = 'skip_Max_2026-11';
  ok(await call(max, { op: 'set', c: 'skip_limits', id, merge: true, data: { agent: 'Max', count: inc, ts: 'x' } }));
  ok(await call(max, { op: 'set', c: 'skip_limits', id, merge: true, data: { agent: 'Max', count: inc, ts: 'x' } }));
  assert.equal(ok(await call(max, { op: 'get', c: 'skip_limits', id })).doc.data.count, 2);
  denied(await call(max, { op: 'set', c: 'skip_limits', id, data: { count: 0 } })); // Zaehler zuruecksetzen = nur Staff
  denied(await call(max, { op: 'set', c: 'skip_limits', id: 'limit_Max', merge: true, data: { max_limit: 999 } }));
  ok(await call(reg, { op: 'set', c: 'skip_limits', id: 'limit_Max', merge: true, data: { agent: 'Max', max_limit: 20 } }));
  assert.equal(ok(await call(max, { op: 'get', c: 'skip_limits', id: 'limit_Max' })).doc.data.max_limit, 20);
  ok(await call(reg, { op: 'set', c: 'skip_limits', id, data: { agent: 'Max', count: 0 } }));
  // parallele Zaehler: 10 gleichzeitige increments ergeben 10
  await Promise.all(Array.from({ length: 10 }, () => call(max, { op: 'set', c: 'tool_usage', id: 'tool_Max_11', merge: true, data: { count: inc } })));
  assert.equal(ok(await call(reg, { op: 'get', c: 'tool_usage', id: 'tool_Max_11' })).doc.data.count, 10);
  denied(await call(max, { op: 'get', c: 'tool_usage', id: 'tool_Max_11' }));
  ok(await call(adm, { op: 'set', c: 'news', id: 'o2', data: { text: 'Hallo' } }));
  assert.equal(ok(await call(max, { op: 'get', c: 'news', id: 'o2' })).doc.data.text, 'Hallo');
  denied(await call(max, { op: 'set', c: 'news', id: 'o2', data: { text: 'x' } }));
  ok(await call(adm, { op: 'set', c: 'aktionsmappe', id: 'global', data: { bundles: [1, 2, 3] } }));
  assert.deepEqual(ok(await call(max, { op: 'get', c: 'aktionsmappe', id: 'global' })).doc.data.bundles, [1, 2, 3]);
  denied(await call(reg, { op: 'set', c: 'aktionsmappe', id: 'global', data: { bundles: [] } }));
  denied(await call(max, { op: 'get', c: 'unbekannt', id: 'x' }));
});

test('Grosse Dokumente und Sonderzeichen bleiben erhalten', async () => {
  const max = await user('oid-max', 'm.muster@hetec-gmbh.de', [G.aalen]);
  const text = ('Müller-Lüdenscheidt 😀 äöüß ' + 'x'.repeat(100) + '\n').repeat(1500); // ~ 190k Zeichen, weit ueber 64 KB mit Umlauten
  ok(await call(max, { op: 'set', c: 'saved_offers', id: 'gross/mit#sonder?zeichen', data: { shopId: 'aalen', text, n: 5, nested: { a: [1, { b: true }] } } }));
  const d = ok(await call(max, { op: 'get', c: 'saved_offers', id: 'gross/mit#sonder?zeichen' })).doc.data;
  assert.equal(d.text, text); assert.equal(d.nested.a[1].b, true);
  denied(await call(max, { op: 'set', c: 'saved_offers', id: 'zugross', data: { shopId: 'aalen', text: 'x'.repeat(500000) } }), 'invalid-argument');
  denied(await call(max, { op: 'set', c: 'saved_offers', id: 'p', data: { shopId: 'aalen', ['__proto__']: 1, a: JSON.parse('{"__proto__":{"x":1}}') } }), 'invalid-argument');
});

test('QR-Download (portierung_files): Upload nur angemeldet, Abruf oeffentlich', async () => {
  const max = await user('oid-max', 'm.muster@hetec-gmbh.de', [G.aalen]);
  const base = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
  denied(await call('', { op: 'set', c: 'portierung_files', id: base + '-0', data: { n: 1, i: 0, d: 'QUJD' } }), 'unauthenticated');
  ok(await call(max, { op: 'set', c: 'portierung_files', id: base + '-0', data: { n: 2, i: 0, d: 'QUJD'.repeat(30000), ts: { __ps: 'ts' } } }));
  ok(await call(max, { op: 'set', c: 'portierung_files', id: base + '-1', data: { n: 2, i: 1, d: 'REVG' } }));
  const first = ok(await call('', { op: 'get', c: 'portierung_files', id: base + '-0' }));
  assert.equal(first.doc.data.d.length, 120000); assert.equal(typeof first.doc.data.ts, 'number');
  assert.equal(ok(await call('', { op: 'get', c: 'portierung_files', id: 'f'.repeat(32) + '-0' })).doc, null);
  denied(await call('', { op: 'get', c: 'portierung_files', id: 'zu-kurz-0' }));
  denied(await call('', { op: 'query', c: 'portierung_files' }), 'unauthenticated');
});

test('Erstanmeldung uebernimmt altes Firebase-Profil (Name + alte Zeilen) per E-Mail', async () => {
  const adm = await user('oid-adm', 'd.dasilva@hetec-gmbh.de', [G.admin], 'Diego da Silva');
  ok(await call(adm, { op: 'set', c: 'users', id: 'fbUID123', data: { email: 'l.alt@hetec-gmbh.de', name: 'Lena Alt', vorname: 'Lena', nachname: 'Alt', isTestUser: false, role: 'verkaeufer' } }));
  ok(await call(adm, { op: 'set', c: 'analytics', id: 'alt1', data: { id: 'alt1', userUid: 'fbUID123', user: 'Lena Alt', shopId: 'aalen', ts: '2026-01-01T00:00:00Z' } }));
  const lena = await user('oid-lena', 'l.alt@hetec-gmbh.de', [G.aalen], 'Alt, Lena (HeTec)');
  const p = ok(await call(lena, { op: 'get', c: 'users', id: 'oid-lena' })).doc.data;
  assert.equal(p.name, 'Lena Alt'); assert.deepEqual(p.legacyUids, ['fbUID123']);
  const r = ok(await call(lena, { op: 'query', c: 'analytics', where: [['userUid', '==', 'oid-lena']] }));
  assert.deepEqual(r.docs.map(d => d.id), ['alt1']);
  ok(await call(lena, { op: 'set', c: 'analytics', id: 'alt1', data: { id: 'alt1', userUid: 'fbUID123', shopId: 'aalen', neu: true } }));
});

'use strict';
// Prueft die PHP-Schnittstelle (api/db.php) Ende-zu-Ende: echter PHP-Server, echte MariaDB,
// selbst signierte Entra-Tokens. Deckt Login-Pruefung, Rollen, Regeln und die Abfrage-Engine ab.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startStack, G } = require('./helpers');

let S, call, user;
test.before(async () => { S = await startStack(); call = S.call; user = S.user; });
test.after(() => S && S.stop());

const ok = r => { assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json; };
const denied = (r, code) => { assert.notEqual(r.status, 200, 'sollte abgelehnt werden'); assert.equal(r.json.code, code || 'permission-denied', JSON.stringify(r.json)); };

test('Einrichtungs-Check und falsche Methode', async () => {
  const h = await (await S.raw('/api/health.php')).json();
  assert.equal(h.ok, true); assert.equal(h.database, true); assert.equal(h.openssl, true); assert.equal(h.microsoft_keys, true); assert.equal(h.pdo_mysql, true); assert.equal(h.groups.shops, 2);
  assert.ok(!JSON.stringify(h).includes(S.CLIENT), 'keine Geheimnisse/IDs in der Ausgabe');
  const g = await S.raw('/api/db.php');
  assert.equal(g.status, 405);
  denied(await call('', '{kaputt'), 'invalid-argument');
});

test('Login-Token: ohne/falsch/abgelaufen wird abgelehnt', async () => {
  const q = { op: 'get', c: 'news', id: 'o2' };
  denied(await call('', q), 'unauthenticated');
  denied(await call('x.y.z', q), 'unauthenticated');
  denied(await call(S.keys.token({}, { aud: 'anderer-client' }), q), 'unauthenticated');
  denied(await call(S.keys.token({}, { iss: 'https://login.microsoftonline.com/evil/v2.0' }), q), 'unauthenticated');
  denied(await call(S.keys.token({ tid: 'anderer-tenant' }), q), 'unauthenticated');
  denied(await call(S.keys.token({}, { exp: Math.floor(Date.now() / 1000) - 600 }), q), 'unauthenticated');
  denied(await call(S.keys.token({}, { wrongKey: true }), q), 'unauthenticated');
  denied(await call(S.keys.token({}, { kid: 'unbekannt' }), q), 'unauthenticated');
  denied(await call(S.keys.token({}, { alg: 'none' }), q), 'unauthenticated');
  // Manipulierte Nutzlast mit gueltiger Signatur eines anderen Tokens
  const t = S.keys.token({ groups: [G.aalen] }); const p = t.split('.');
  const evil = Buffer.from(JSON.stringify({ tid: S.TENANT, aud: S.CLIENT, iss: 'https://login.microsoftonline.com/' + S.TENANT + '/v2.0', exp: 9999999999, oid: 'x', preferred_username: 'a@hetec-gmbh.de', groups: [G.admin] })).toString('base64url');
  denied(await call(p[0] + '.' + evil + '.' + p[2], q), 'unauthenticated');
  ok(await call(S.keys.token({ groups: [G.aalen] }), q));
});

test('Profil kommt aus Gruppen: Verkaeufer, Admin, ohne Gruppe, fremde Domain', async () => {
  const t = user('oid-max', 'm.muster@hetec-gmbh.de', [G.aalen]);
  let p = ok(await call(t, { op: 'get', c: 'users', id: 'oid-max' })).doc.data;
  assert.equal(p.active, true); assert.equal(p.status, 'approved'); assert.equal(p.role, 'verkaeufer');
  assert.equal(p.shopId, 'aalen'); assert.equal(p.vorname, 'Max'); assert.equal(p.nachname, 'Muster'); assert.equal(p.allShops, false);
  assert.deepEqual(p.allowedShopIds, ['aalen']);

  const a = user('oid-adm', 'd.dasilva@hetec-gmbh.de', [G.admin], 'Diego da Silva');
  p = ok(await call(a, { op: 'get', c: 'users', id: 'oid-adm' })).doc.data;
  assert.equal(p.role, 'admin'); assert.equal(p.allShops, true); assert.equal(p.vorname, 'Diego'); assert.equal(p.nachname, 'da Silva');

  const n = user('oid-none', 'x.y@hetec-gmbh.de', []);
  p = ok(await call(n, { op: 'get', c: 'users', id: 'oid-none' })).doc.data;
  assert.equal(p.active, false); assert.equal(p.status, 'no-group'); assert.deepEqual(p.allowedShopIds, []);
  denied(await call(n, { op: 'get', c: 'news', id: 'o2' }));
  denied(await call(n, { op: 'set', c: 'analytics', id: 'a1', data: { shopId: 'aalen' } }));

  const f = user('oid-ext', 'x@fremd.de', [G.aalen]);
  p = ok(await call(f, { op: 'get', c: 'users', id: 'oid-ext' })).doc.data;
  assert.equal(p.active, false); assert.equal(p.status, 'domain');

  denied(await call(t, { op: 'get', c: 'users', id: 'oid-adm' }));
  denied(await call(t, { op: 'update', c: 'users', id: 'oid-max', data: { role: 'admin' } }));
  ok(await call(t, { op: 'update', c: 'users', id: 'oid-max', data: { vorname: 'Maximilian', nachname: 'Muster', name: 'Maximilian Muster' } }));
  p = ok(await call(t, { op: 'get', c: 'users', id: 'oid-max' })).doc.data;
  assert.equal(p.role, 'verkaeufer'); assert.equal(p.name, 'Maximilian Muster');
  // Admin sieht alle Profile
  const all = ok(await call(a, { op: 'query', c: 'users' })).docs;
  assert.ok(all.some(d => d.id === 'oid-max'));
  denied(await call(t, { op: 'query', c: 'users' }));
});

test('Analytics: eigene Zeilen schreiben/lesen, fremde gesperrt, Staff sieht alle, Paging', async () => {
  const max = user('oid-max', 'm.muster@hetec-gmbh.de', [G.aalen]);
  const eva = user('oid-eva', 'e.klein@hetec-gmbh.de', [G.hall], 'Eva Klein');
  const reg = user('oid-reg', 'r.leiter@hetec-gmbh.de', [G.regional], 'Rita Leiter');
  for (let i = 1; i <= 7; i++) {
    ok(await call(max, { op: 'set', c: 'analytics', id: 'm' + i, data: { id: 'm' + i, userUid: 'oid-max', user: 'Max', shopId: 'aalen', ts: '2026-11-0' + i + 'T10:00:00Z' } }));
  }
  ok(await call(eva, { op: 'set', c: 'analytics', id: 'e1', data: { id: 'e1', user: 'Eva', shopId: 'schwaebisch-hall', ts: '2026-11-05T09:00:00Z' } }));
  assert.equal(ok(await call(eva, { op: 'get', c: 'analytics', id: 'e1' })).doc.data.userUid, 'oid-eva');
  denied(await call(max, { op: 'set', c: 'analytics', id: 'x1', data: { userUid: 'oid-eva', shopId: 'aalen' } }));
  denied(await call(max, { op: 'set', c: 'analytics', id: 'x2', data: { shopId: 'schwaebisch-hall' } }));
  denied(await call(max, { op: 'set', c: 'analytics', id: 'e1', data: { shopId: 'aalen' } }));
  denied(await call(max, { op: 'get', c: 'analytics', id: 'e1' }));
  denied(await call(max, { op: 'delete', c: 'analytics', id: 'm1' }));
  let r = ok(await call(max, { op: 'query', c: 'analytics', where: [['userUid', '==', 'oid-max']], orderBy: [['__name__', 'asc']] }));
  assert.equal(r.docs.length, 7);
  r = ok(await call(max, { op: 'query', c: 'analytics' }));
  assert.equal(r.docs.length, 7);
  denied(await call(max, { op: 'query', c: 'analytics', where: [['userUid', '==', 'oid-eva']] }));
  r = ok(await call(reg, { op: 'query', c: 'analytics', orderBy: [['ts', 'desc']] }));
  assert.equal(r.docs.length, 8); assert.equal(r.docs[0].id, 'm7'); assert.equal(r.docs[7].id, 'm1'); assert.equal(r.more, false);
  const seen = []; let after = null;
  for (let i = 0; i < 10; i++) {
    const p = ok(await call(reg, { op: 'query', c: 'analytics', orderBy: [['ts', 'desc']], limit: 3, after }));
    p.docs.forEach(d => seen.push(d.id));
    assert.equal(p.more, seen.length < 8);
    if (p.docs.length < 3) break;
    const last = p.docs[p.docs.length - 1];
    after = { id: last.id, values: [last.data.ts] };
  }
  assert.deepEqual(seen, ['m7', 'm6', 'm5', 'e1', 'm4', 'm3', 'm2', 'm1']);
  // aufsteigend + nach Dokument-ID
  r = ok(await call(reg, { op: 'query', c: 'analytics', orderBy: [['ts', 'asc']], limit: 2 }));
  assert.deepEqual(r.docs.map(d => d.id), ['m1', 'm2']); assert.equal(r.more, true);
  r = ok(await call(reg, { op: 'query', c: 'analytics', orderBy: [['__name__', 'desc']], limit: 3, after: { id: 'm5', values: [] } }));
  assert.deepEqual(r.docs.map(d => d.id), ['m4', 'm3', 'm2']);
  const adm = user('oid-adm', 'd.dasilva@hetec-gmbh.de', [G.admin], 'Diego da Silva');
  denied(await call(reg, { op: 'delete', c: 'analytics', id: 'm1' }));
  ok(await call(adm, { op: 'batch', ops: [{ op: 'update', c: 'analytics', id: 'm2', data: { note: 'x' } }, { op: 'delete', c: 'analytics', id: 'm1' }] }));
  assert.equal(ok(await call(adm, { op: 'get', c: 'analytics', id: 'm1' })).doc, null);
  assert.equal(ok(await call(adm, { op: 'get', c: 'analytics', id: 'm2' })).doc.data.note, 'x');
  denied(await call(adm, { op: 'update', c: 'analytics', id: 'gibtsnicht', data: { a: 1 } }), 'not-found');
});

test('Viele Zeilen: Seiten zu 500 in der Datenbank, nichts doppelt/verloren, auch mit gleicher Zeit', async () => {
  const reg = user('oid-reg', 'r.leiter@hetec-gmbh.de', [G.regional], 'Rita Leiter');
  const adm = user('oid-adm', 'd.dasilva@hetec-gmbh.de', [G.admin]);
  await call(adm, { op: 'batch', ops: (await call(adm, { op: 'query', c: 'analytics' })).json.docs.map(d => ({ op: 'delete', c: 'analytics', id: d.id })).concat([{ op: 'set', c: 'news', id: 'x', data: {} }]) });
  const N = 1300;
  for (let i = 0; i < N; i += 400) {
    const ops = [];
    for (let j = i; j < Math.min(N, i + 400); j++) ops.push({ op: 'set', c: 'analytics', id: 'z' + String(j).padStart(4, '0'), data: { id: 'z' + j, shopId: j % 2 ? 'aalen' : 'schwaebisch-hall', user: 'U', ts: '2026-10-' + String(1 + (j % 28)).padStart(2, '0') + 'T00:00:00.000Z', text: 'Müller 😀 ' + j } });
    ok(await call(adm, { op: 'batch', ops }));
  }
  const ids = []; let after = null; let pages = 0;
  for (;;) {
    const p = ok(await call(reg, { op: 'query', c: 'analytics', orderBy: [['ts', 'desc']], limit: 500, after }));
    p.docs.forEach(d => ids.push(d.id)); pages++;
    if (!p.more) break;
    const last = p.docs[p.docs.length - 1]; after = { id: last.id, values: [last.data.ts] };
  }
  assert.equal(ids.length, N); assert.equal(new Set(ids).size, N); assert.equal(pages, 3);
  // Reihenfolge: ts absteigend, bei gleichem ts nach ID aufsteigend
  const all = ok(await call(reg, { op: 'query', c: 'analytics', orderBy: [['ts', 'desc']] })).docs;
  for (let i = 1; i < all.length; i++) {
    const a = all[i - 1].data.ts, b = all[i].data.ts;
    assert.ok(a > b || (a === b && all[i - 1].id < all[i].id), 'Reihenfolge bei ' + i);
  }
  assert.equal(all[0].data.text.startsWith('Müller 😀'), true);
  // Filter nach Standort ueber die Datenbank
  const hall = ok(await call(reg, { op: 'query', c: 'analytics', where: [['shopId', '==', 'schwaebisch-hall']], orderBy: [['ts', 'desc']], limit: 700 }));
  assert.equal(hall.docs.length, 650); assert.equal(hall.more, false);
  // Ein Dokument mit Zahl als ts -> Abfrage faellt auf den allgemeinen Weg zurueck und bleibt korrekt
  ok(await call(adm, { op: 'set', c: 'analytics', id: 'zz-zahl', data: { id: 'zz', shopId: 'aalen', ts: 12345 } }));
  const mixed = ok(await call(reg, { op: 'query', c: 'analytics', orderBy: [['ts', 'desc']], limit: 5 }));
  assert.equal(mixed.docs.length, 5);
  assert.equal(ok(await call(reg, { op: 'query', c: 'analytics', where: [['ts', '==', '2026-10-01T00:00:00.000Z']] })).docs.length > 0, true);
  await call(adm, { op: 'delete', c: 'analytics', id: 'zz-zahl' });
});

test('saved_offers und pdf_index: Standort-Trennung', async () => {
  const max = user('oid-max', 'm.muster@hetec-gmbh.de', [G.aalen]);
  const eva = user('oid-eva', 'e.klein@hetec-gmbh.de', [G.hall]);
  const spr = user('oid-spr', 's.sprung@hetec-gmbh.de', [G.springer, G.aalen], 'Sam Sprung');
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
  ok(await call(max, { op: 'set', c: 'pdf_index', id: 'f2', data: entry('f2', 'aalen', ['n:sch', 'p:100%_!x']) }));
  ok(await call(eva, { op: 'set', c: 'pdf_index', id: 'f3', data: entry('f3', 'schwaebisch-hall', ['n:mue']) }));
  assert.equal(ok(await call(max, { op: 'get', c: 'pdf_index', id: 'f1' })).doc.data.uid, 'oid-max');
  let r = ok(await call(max, { op: 'query', c: 'pdf_index', where: [['shopId', '==', 'aalen'], ['keys', 'array-contains', 'n:mue']], limit: 150 }));
  assert.deepEqual(r.docs.map(d => d.id), ['f1']);
  r = ok(await call(max, { op: 'query', c: 'pdf_index', where: [['keys', 'array-contains', 'n:mue']] }));
  assert.deepEqual(r.docs.map(d => d.id), ['f1']);
  // Sonderzeichen im Suchschluessel (LIKE-Platzhalter) duerfen nichts Falsches treffen
  for (const [k, expect] of [['p:100%_!x', ['f2']], ['p:100', []], ['n:%', []], ['n:_ue', []], ['n:mu', []]]) {
    r = ok(await call(max, { op: 'query', c: 'pdf_index', where: [['keys', 'array-contains', k]] }));
    assert.deepEqual(r.docs.map(d => d.id), expect, k);
  }
  r = ok(await call(max, { op: 'query', c: 'pdf_index', where: [['keys', 'array-contains-any', ['n:sch', 'n:mues']]] }));
  assert.deepEqual(r.docs.map(d => d.id), ['f1', 'f2']);
  denied(await call(max, { op: 'query', c: 'pdf_index', where: [['shopId', '==', 'schwaebisch-hall']], limit: 1 }));
  denied(await call(max, { op: 'set', c: 'pdf_index', id: 'f3', data: entry('f3', 'aalen', []) }));
});

test('skip_limits / tool_usage / news / aktionsmappe', async () => {
  const max = user('oid-max', 'm.muster@hetec-gmbh.de', [G.aalen]);
  const reg = user('oid-reg', 'r.leiter@hetec-gmbh.de', [G.regional]);
  const adm = user('oid-adm', 'd.dasilva@hetec-gmbh.de', [G.admin]);
  const inc = { __ps: 'inc', n: 1 };
  const id = 'skip_Max_2026-11';
  ok(await call(max, { op: 'set', c: 'skip_limits', id, merge: true, data: { agent: 'Max', count: inc, ts: 'x' } }));
  ok(await call(max, { op: 'set', c: 'skip_limits', id, merge: true, data: { agent: 'Max', count: inc, ts: 'x' } }));
  assert.equal(ok(await call(max, { op: 'get', c: 'skip_limits', id })).doc.data.count, 2);
  denied(await call(max, { op: 'set', c: 'skip_limits', id, data: { count: 0 } }));
  denied(await call(max, { op: 'set', c: 'skip_limits', id: 'limit_Max', merge: true, data: { max_limit: 999 } }));
  ok(await call(reg, { op: 'set', c: 'skip_limits', id: 'limit_Max', merge: true, data: { agent: 'Max', max_limit: 20 } }));
  assert.equal(ok(await call(max, { op: 'get', c: 'skip_limits', id: 'limit_Max' })).doc.data.max_limit, 20);
  ok(await call(reg, { op: 'set', c: 'skip_limits', id, data: { agent: 'Max', count: 0 } }));
  // parallele Zaehler: 10 gleichzeitige increments ergeben genau 10
  const rs = await Promise.all(Array.from({ length: 10 }, () => call(max, { op: 'set', c: 'tool_usage', id: 'tool_Max_11', merge: true, data: { count: inc } })));
  rs.forEach(ok);
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

test('Dokument-Treue: {} bleibt {}, [] bleibt [], Zahlen-Schluessel, null, Sonderzeichen, grosse Texte', async () => {
  const max = user('oid-max', 'm.muster@hetec-gmbh.de', [G.aalen]);
  const text = ('Müller-Lüdenscheidt 😀 äöüß ' + 'x'.repeat(100) + '\n').repeat(1500);
  const doc = { shopId: 'aalen', text, n: 5, f: 1.5, neg: -3, big: 1762345678901, nul: null, t: true, leer: {}, liste: [], nested: { a: [1, { b: true, c: {} }, []] }, 0: 'null', 1: 'eins', '': 'leer', 'a.b': 'punkt', pfad: '/x/y', quote: 'a"b\\c' };
  const id = 'gross/mit#sonder?zeichen äö 😀';
  ok(await call(max, { op: 'set', c: 'saved_offers', id, data: doc }));
  const d = ok(await call(max, { op: 'get', c: 'saved_offers', id })).doc;
  assert.equal(d.id, id);
  assert.deepEqual(d.data, doc);
  const txt = (await call(max, { op: 'get', c: 'saved_offers', id })).text;
  assert.ok(txt.includes('"leer":{}') && txt.includes('"liste":[]') && txt.includes('"0":"null"'), 'Rohtext: ' + txt.slice(0, 200));
  // nur Zahlen als Schluessel darf nicht zur Liste werden
  ok(await call(max, { op: 'set', c: 'saved_offers', id: 'num', data: { shopId: 'aalen', map: { 0: 'a', 1: 'b' } } }));
  assert.deepEqual(ok(await call(max, { op: 'get', c: 'saved_offers', id: 'num' })).doc.data.map, { 0: 'a', 1: 'b' });
  // update mit Punkt-Pfad, merge mit verschachtelten Feldern und delete-Platzhalter
  ok(await call(max, { op: 'update', c: 'saved_offers', id: 'num', data: { 'map.2': 'c', 'neu.tief.wert': 7, shopId: 'aalen' } }));
  assert.deepEqual(ok(await call(max, { op: 'get', c: 'saved_offers', id: 'num' })).doc.data.neu, { tief: { wert: 7 } });
  ok(await call(max, { op: 'set', c: 'saved_offers', id: 'num', merge: true, data: { shopId: 'aalen', map: { 9: 'z', 0: { __ps: 'del' } } } }));
  assert.deepEqual(ok(await call(max, { op: 'get', c: 'saved_offers', id: 'num' })).doc.data.map, { 1: 'b', 2: 'c', 9: 'z' });
  denied(await call(max, { op: 'set', c: 'saved_offers', id: 'zugross', data: { shopId: 'aalen', text: 'x'.repeat(2100000) } }), 'invalid-argument');
  denied(await call(max, { op: 'set', c: 'saved_offers', id: 'p', data: { shopId: 'aalen', a: JSON.parse('{"__proto__":{"x":1}}') } }), 'invalid-argument');
  denied(await call(max, { op: 'set', c: 'saved_offers', id: 'x'.repeat(300), data: { shopId: 'aalen' } }), 'invalid-argument');
  denied(await call(max, { op: 'set', c: 'saved_offers', id: 'q', data: [1, 2] }), 'invalid-argument');
});

test('QR-Download (portierung_files): Upload nur angemeldet, Abruf oeffentlich', async () => {
  const max = user('oid-max', 'm.muster@hetec-gmbh.de', [G.aalen]);
  const base = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
  denied(await call('', { op: 'set', c: 'portierung_files', id: base + '-0', data: { n: 1, i: 0, d: 'QUJD' } }), 'unauthenticated');
  ok(await call(max, { op: 'set', c: 'portierung_files', id: base + '-0', data: { n: 2, i: 0, d: 'QUJD'.repeat(30000), ts: { __ps: 'ts' } } }));
  ok(await call(max, { op: 'set', c: 'portierung_files', id: base + '-1', data: { n: 2, i: 1, d: 'REVG' } }));
  const first = ok(await call('', { op: 'get', c: 'portierung_files', id: base + '-0' }));
  assert.equal(first.doc.data.d.length, 120000); assert.equal(typeof first.doc.data.ts, 'number');
  assert.equal(ok(await call('', { op: 'get', c: 'portierung_files', id: 'f'.repeat(32) + '-0' })).doc, null);
  denied(await call('', { op: 'get', c: 'portierung_files', id: 'zu-kurz-0' }));
  denied(await call('', { op: 'query', c: 'portierung_files' }), 'unauthenticated');
  denied(await call(max, { op: 'update', c: 'portierung_files', id: base + '-1', data: { d: 'x' } }));
});

test('Erstanmeldung uebernimmt altes Firebase-Profil (Name + alte Zeilen) per E-Mail', async () => {
  const adm = user('oid-adm', 'd.dasilva@hetec-gmbh.de', [G.admin], 'Diego da Silva');
  ok(await call(adm, { op: 'set', c: 'users', id: 'fbUID123', data: { email: 'l.alt@hetec-gmbh.de', name: 'Lena Alt', vorname: 'Lena', nachname: 'Alt', isTestUser: false, role: 'verkaeufer' } }));
  ok(await call(adm, { op: 'set', c: 'analytics', id: 'alt1', data: { id: 'alt1', userUid: 'fbUID123', user: 'Lena Alt', shopId: 'aalen', ts: '2026-01-01T00:00:00Z' } }));
  const lena = user('oid-lena', 'l.alt@hetec-gmbh.de', [G.aalen], 'Alt, Lena (HeTec)');
  const p = ok(await call(lena, { op: 'get', c: 'users', id: 'oid-lena' })).doc.data;
  assert.equal(p.name, 'Lena Alt'); assert.deepEqual(p.legacyUids, ['fbUID123']);
  const r = ok(await call(lena, { op: 'query', c: 'analytics', where: [['userUid', '==', 'oid-lena']] }));
  assert.deepEqual(r.docs.map(d => d.id), ['alt1']);
  const r2 = ok(await call(lena, { op: 'query', c: 'analytics', orderBy: [['ts', 'desc']] }));
  assert.deepEqual(r2.docs.map(d => d.id), ['alt1']);
  ok(await call(lena, { op: 'set', c: 'analytics', id: 'alt1', data: { id: 'alt1', userUid: 'fbUID123', shopId: 'aalen', neu: true } }));
});

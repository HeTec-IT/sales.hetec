// API, Berechtigungen, Statistik, Angebote, Downloads, Suchindex – gegen echte MariaDB.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv, Client, phpAvailable } from './harness.mjs';

const skip = !phpAvailable() && 'PHP mit pdo_mysql/sodium nicht verfügbar';
let env, max, mia, lena, admin, fritz, tom, sven;
before(async () => {
  if (skip) return;
  env = await startEnv();
  const mk = async email => { const c = new Client(env.app); await c.loginDev(email); return c; };
  max = await mk('test.max.verkauf@hetec-gmbh.de');        // Mitarbeiter Aalen
  mia = await mk('test.mia.verkauf@hetec-gmbh.de');        // Mitarbeiterin Crailsheim
  lena = await mk('test.lena.leiterin@hetec-gmbh.de');     // Shop-Leiterin Crailsheim
  fritz = await mk('test.fritz.betreuer@hetec-gmbh.de');   // Filialbetreuer Aalen + Crailsheim + SHA
  tom = await mk('test.tom.azubi@hetec-gmbh.de');          // Azubi SHA
  sven = await mk('test.sven.springer@hetec-gmbh.de');     // Springer (alle Shops)
  admin = await mk('test.haupt.admin@hetec-gmbh.de');
});
after(async () => { if (env) await env.stop(); });

const row = (id, shopId, extra = {}) => ({ id, ts: new Date().toISOString(), user: 'X', shopId, result: 'Angebot', beratungsId: 'B1', exempt: false, canvasStats: { offer1: { used: true, strokes: 3 } }, ...extra });

test('ohne Anmeldung kein API-Zugriff', { skip }, async () => {
  const c = new Client(env.app);
  for (const u of ['/api/v1/offers', '/api/v1/analytics', '/api/v1/shops', '/api/v1/admin/users', '/api/v1/pdf-index/mine']) {
    assert.equal((await c.get(u)).status, 401, u);
  }
});

test('schreibende Anfragen ohne CSRF-Token werden abgelehnt', { skip }, async () => {
  const r = await max.post('/api/v1/analytics/batch', { rows: [row('csrf_1', 'aalen')] }, { headers: { 'X-PS-CSRF': '' } });
  assert.equal(r.status, 403);
  assert.equal(r.json.error, 'csrf_invalid');
});

test('fremde Origin wird abgelehnt', { skip }, async () => {
  const r = await max.post('/api/v1/analytics/batch', { rows: [] }, { origin: 'https://evil.example' });
  assert.equal(r.status, 403);
  assert.equal(r.json.error, 'origin_not_allowed');
});

test('Statistik: doppelte Synchronisierung erzeugt keine doppelten Zeilen', { skip }, async () => {
  const rows = [row('dup_a1', 'aalen'), row('dup_a2', 'aalen')];
  for (let i = 0; i < 3; i++) {
    const r = await max.post('/api/v1/analytics/batch', { rows });
    assert.deepEqual(r.json.accepted, ['dup_a1', 'dup_a2']);
  }
  const own = await max.get('/api/v1/analytics?scope=own');
  assert.equal(own.json.rows.filter(x => x.id.startsWith('dup_a')).length, 2);
});

test('Statistik: Zeile für fremden Shop wird abgelehnt', { skip }, async () => {
  const r = await max.post('/api/v1/analytics/batch', { rows: [row('foreign_1', 'crailsheim')] });
  assert.deepEqual(r.json.rejected, [{ id: 'foreign_1', reason: 'shop_forbidden' }]);
});

test('Statistik: fremde Zeile kann nicht überschrieben werden', { skip }, async () => {
  await mia.post('/api/v1/analytics/batch', { rows: [row('owned_by_mia', 'crailsheim')] });
  const r = await sven.post('/api/v1/analytics/batch', { rows: [row('owned_by_mia', 'crailsheim', { result: 'Abschluss' })] });
  assert.deepEqual(r.json.rejected, [{ id: 'owned_by_mia', reason: 'conflict' }]);
});

test('Statistik: Mitarbeiter sieht nur eigene Zeilen, Shop-Leitung den eigenen Shop, Admin alles', { skip }, async () => {
  assert.equal((await max.get('/api/v1/analytics?scope=all')).status, 403);
  assert.equal((await max.get('/api/v1/analytics?scope=shops')).status, 403);
  const own = await max.get('/api/v1/analytics?scope=own');
  assert.ok(own.json.rows.length > 0);
  assert.ok(own.json.rows.every(x => x.shopId === 'aalen' && x.user === 'X' || x.userUid));
  const shops = await lena.get('/api/v1/analytics?scope=shops');
  assert.ok(shops.json.rows.length > 0);
  assert.ok(shops.json.rows.every(x => x.shopId === 'crailsheim'));
  const all = await admin.get('/api/v1/analytics?scope=all&limit=50');
  assert.equal(all.json.rows.length, 50);
  assert.ok(all.json.next);
  const page2 = await admin.get('/api/v1/analytics?scope=all&limit=50&cursor=' + encodeURIComponent(all.json.next));
  assert.equal(new Set([...all.json.rows, ...page2.json.rows].map(r => r.id)).size, all.json.rows.length + page2.json.rows.length);
});

test('Statistik-Zusammenfassung ist reproduzierbar und respektiert Rechte', { skip }, async () => {
  const a = await admin.get('/api/v1/statistics/summary?groupBy=shop');
  const b = await admin.get('/api/v1/statistics/summary?groupBy=shop');
  assert.deepEqual(a.json, b.json);
  const l = await lena.get('/api/v1/statistics/summary?groupBy=shop');
  assert.deepEqual(l.json.groups.map(g => g.group), ['crailsheim']);
  const m = await max.get('/api/v1/statistics/summary?groupBy=user');
  assert.ok(m.json.groups.length >= 1);
});

test('Statistik komplett löschen nur Hauptadmin mit Bestätigung', { skip }, async () => {
  assert.equal((await lena.del('/api/v1/analytics?confirm=ALLE-STATISTIKEN-LOESCHEN')).status, 403);
  assert.equal((await admin.del('/api/v1/analytics')).status, 422);
});

test('Angebote: speichern/laden im eigenen Shop, fremder Shop gesperrt, verschlüsselt in der DB', { skip }, async () => {
  const payload = JSON.stringify({ textData: { Kundenname: 'Erika Musterfrau-Synthetisch' }, n: 1 });
  let r = await max.put('/api/v1/offers/offer_test_1', { shopId: 'aalen', payload, label: 'Erika Musterfrau-Synthetisch', kunde: 'Erika Musterfrau-Synthetisch', ts: Date.now() });
  assert.equal(r.status, 200);
  r = await max.put('/api/v1/offers/offer_test_2', { shopId: 'crailsheim', payload, label: 'x' });
  assert.equal(r.status, 403);
  const list = await max.get('/api/v1/offers');
  assert.ok(list.json.offers.some(o => o.id === 'offer_test_1' && o.kunde === 'Erika Musterfrau-Synthetisch'));
  assert.equal((await max.get('/api/v1/offers/offer_test_1')).json.payload, payload);
  // Mia (Crailsheim) darf das Aalener Angebot weder sehen noch laden noch löschen
  assert.ok(!(await mia.get('/api/v1/offers')).json.offers.some(o => o.id === 'offer_test_1'));
  assert.equal((await mia.get('/api/v1/offers/offer_test_1')).status, 404);
  assert.equal((await mia.del('/api/v1/offers/offer_test_1')).status, 404);
  assert.equal((await mia.get('/api/v1/offers?shopId=aalen')).status, 403);
  // Springer sieht alle Shops
  assert.ok((await sven.get('/api/v1/offers')).json.offers.some(o => o.id === 'offer_test_1'));
  // Klartext darf nicht in der Datenbank stehen
  const raw = env.sql("SELECT CONCAT(HEX(label_enc), HEX(kunde_enc), HEX(payload_enc)) AS h FROM saved_offers WHERE id = 'offer_test_1'")[0].h;
  assert.ok(!Buffer.from(raw, 'hex').toString('latin1').includes('Musterfrau'));
});

test('Angebote: zu große Angebote werden wie bisher abgelehnt (too_big)', { skip }, async () => {
  const r = await max.put('/api/v1/offers/offer_big', { shopId: 'aalen', payload: JSON.stringify({ x: 'a'.repeat(900000) }) });
  assert.equal(r.status, 413);
  assert.equal(r.json.error, 'too_big');
});

test('Path Traversal / ungültige IDs werden abgewiesen', { skip }, async () => {
  assert.equal((await max.put('/api/v1/offers/..%2F..%2Fetc', { shopId: 'aalen', payload: '{}' })).status, 404);
  assert.equal((await max.get('/api/v1/downloads/../../config/file')).status, 404);
  assert.equal((await max.get('/api/v1/downloads/abc/file')).status, 404);
});

test('Skip-Limit: eigener Zähler, Verwaltung nur mit Recht', { skip }, async () => {
  const a = await tom.get('/api/v1/skip/me');
  assert.equal(a.json.limit, 15);
  await tom.post('/api/v1/skip/me/increment', {});
  const b = await tom.get('/api/v1/skip/me');
  assert.equal(b.json.count, a.json.count + 1);
  assert.equal((await tom.get('/api/v1/skip/agents')).status, 403);
  const agents = await admin.get('/api/v1/skip/agents');
  const t = agents.json.agents.find(x => x.agent === 'Tom Azubi');
  const u = await admin.put('/api/v1/skip/agents/' + t.userId, { limit: 20, resetCount: true });
  assert.equal(u.json.limit, 20);
  assert.equal(u.json.count, 0);
});

test('News: lesen für alle, schreiben nur mit Recht, max. 5 Einträge', { skip }, async () => {
  assert.equal((await max.put('/api/v1/news/o2', { items: [{ text: 'x' }] })).status, 403);
  const items = Array.from({ length: 8 }, (_, i) => ({ text: 'Meldung ' + i, bis: '' }));
  const r = await admin.put('/api/v1/news/o2', { items });
  assert.equal(r.json.items.length, 5);
  assert.equal((await max.get('/api/v1/news/o2')).json.items.length, 5);
});

test('Werkzeug-Nutzung wird pro Benutzer/Monat gezählt', { skip }, async () => {
  await max.post('/api/v1/tool-usage', { tool: 'wlan-planer' });
  await max.post('/api/v1/tool-usage', { tool: 'wlan-planer' });
  assert.equal((await max.post('/api/v1/tool-usage', { tool: '<script>' })).status, 422);
  const list = await admin.get('/api/v1/tool-usage');
  const r = list.json.rows.find(x => x.agent === 'Max Verkauf' && x.tool === 'wlan-planer');
  assert.equal(Number(r.count), 2);
});

test('Downloads: nur PDF/Bilder, Abruf per Token, Löschen durch Ersteller', { skip }, async () => {
  const pdf = Buffer.from('%PDF-1.4\n% synthetisch\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF').toString('base64');
  assert.equal((await max.post('/api/v1/downloads', { data: Buffer.from('<html>').toString('base64') })).status, 415);
  const r = await max.post('/api/v1/downloads', { data: pdf, shopId: 'aalen' });
  assert.equal(r.status, 200);
  assert.match(r.json.id, /^[a-f0-9]{32}$/);
  const anon = await fetch(env.app + '/api/v1/downloads/' + r.json.id + '/file');
  assert.equal(anon.status, 200);
  assert.equal(anon.headers.get('content-type'), 'application/pdf');
  assert.equal(Buffer.from(await anon.arrayBuffer()).toString('base64'), pdf);
  await mia.del('/api/v1/downloads/' + r.json.id);            // fremd → wirkt nicht
  assert.equal((await fetch(env.app + '/api/v1/downloads/' + r.json.id + '/file')).status, 200);
  await max.del('/api/v1/downloads/' + r.json.id);
  assert.equal((await fetch(env.app + '/api/v1/downloads/' + r.json.id + '/file')).status, 404);
});

test('PDF-Suchindex: Suche nur in erlaubten Shops, fremde Shops 403, Admin alle', { skip }, async () => {
  const entry = (fileName, shopId) => ({ fileName, typ: 'angebot', shopId, kunde: 'Synthetik Kunde', ruf: '01701234567', datum: '2026-11-20', keys: ['n:synthetik', 'p:1701234567'], src: 'app' });
  const id = f => f.toLowerCase().replace(/[^a-z0-9._+\-]/g, '_');
  const f1 = 'PENCIL_Angebot_aalen_Synthetik_2026-11-20.pdf', f2 = 'PENCIL_Angebot_crailsheim_Synthetik_2026-11-20.pdf';
  assert.equal((await max.put('/api/v1/pdf-index/' + id(f1), entry(f1, 'aalen'))).status, 200);
  assert.equal((await mia.put('/api/v1/pdf-index/' + id(f2), entry(f2, 'crailsheim'))).status, 200);
  assert.equal((await max.put('/api/v1/pdf-index/' + id(f2), entry(f2, 'crailsheim'))).status, 403);
  const s1 = await max.get('/api/v1/pdf-index/search?key=n:synthetik');
  assert.deepEqual(s1.json.items.map(x => x.shopId), ['aalen']);
  assert.equal((await max.get('/api/v1/pdf-index/search?key=n:synthetik&shopId=crailsheim')).status, 403);
  assert.equal((await max.get('/api/v1/pdf-index/probe?shopId=crailsheim')).status, 403);
  const sf = await fritz.get('/api/v1/pdf-index/search?key=n:synthetik');
  assert.equal(sf.json.items.length, 2);
  const sa = await admin.get('/api/v1/pdf-index/search?key=p:1701234567');
  assert.equal(sa.json.items.length, 2);
  const mine = await max.get('/api/v1/pdf-index/mine?since=0');
  assert.equal(mine.json.items.length, 1);
  assert.equal(mine.json.items[0].kunde, 'Synthetik Kunde');
});

test('Admin: Rangregeln (Admin kann keinen Hauptadmin ändern, niemand sich selbst)', { skip }, async () => {
  const anna = new Client(env.app);
  await anna.loginDev('test.anna.admin@hetec-gmbh.de');
  const users = (await anna.get('/api/v1/admin/users')).json.users;
  const haupt = users.find(u => u.email === 'test.haupt.admin@hetec-gmbh.de');
  const annaSelf = users.find(u => u.email === 'test.anna.admin@hetec-gmbh.de');
  const maxU = users.find(u => u.email === 'test.max.verkauf@hetec-gmbh.de');
  assert.equal((await anna.patch('/api/v1/admin/users/' + haupt.id, { status: 'blocked' })).status, 403);
  assert.equal((await anna.patch('/api/v1/admin/users/' + annaSelf.id, { role: 'super_admin' })).status, 403);
  assert.equal((await anna.patch('/api/v1/admin/users/' + maxU.id, { role: 'admin' })).status, 403);
  const ok = await anna.patch('/api/v1/admin/users/' + maxU.id, { extraShopIds: ['crailsheim'] });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json.user.extraShopIds, ['crailsheim']);
  // Rechteänderung beendet die Sitzung → neu anmelden, dann neue Shops aktiv
  assert.equal((await max.get('/api/v1/shops')).status, 401);
  await max.loginDev('test.max.verkauf@hetec-gmbh.de');
  assert.deepEqual((await max.get('/api/v1/session')).json.user.allowedShopIds, ['aalen', 'crailsheim']);
  assert.equal((await max.patch('/api/v1/admin/users/' + maxU.id, { status: 'approved' })).status, 403);
});

test('Filialbetreuer sieht nur Benutzer seiner Shops, kann aber nichts ändern', { skip }, async () => {
  const users = (await fritz.get('/api/v1/admin/users')).json.users;
  assert.ok(users.length > 0);
  assert.ok(users.every(u => ['aalen', 'crailsheim', 'schwaebisch-hall'].includes(u.homeShopId) || u.extraShopIds.some(s => ['aalen', 'crailsheim', 'schwaebisch-hall'].includes(s))));
  assert.equal((await fritz.patch('/api/v1/admin/users/' + users[0].id, { status: 'blocked' })).status, 403);
});

test('Antworten tragen Sicherheits-Header und keine Caches', { skip }, async () => {
  const r = await max.get('/api/v1/session');
  assert.equal(r.headers.get('cache-control'), 'no-store, max-age=0');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.match(r.headers.get('content-security-policy'), /default-src 'none'/);
});

test('Archiv-Flow ohne Konfiguration → 503 (kein stiller Fallback)', { skip }, async () => {
  const r = await max.post('/api/v1/archive/flow', { payload: { action: 'status' } });
  assert.equal(r.status, 503);
});

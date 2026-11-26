// Firestore → SQL: Übernahme mit einem SYNTHETISCHEN Export (keine echten Daten).
// Prüft Vollständigkeit, Rollen/Shops, Wiederholbarkeit (keine Dubletten), Testlauf, Rücknahme, Verknüpfung mit Microsoft.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startEnv, Client, phpAvailable, devOid, ROOT } from '../backend/harness.mjs';

const skip = !phpAvailable() && 'PHP fehlt';
let env, file;
const now = Date.now();
const iso = d => new Date(now - d * 86400000).toISOString();

function fixture() {
  return {
    meta: { project: 'synthetisch', exportedAt: new Date().toISOString() },
    collections: {
      users: {
        uidA: { email: 'test.alt.admin@hetec-gmbh.de', name: 'Alt Admin', vorname: 'Alt', nachname: 'Admin', role: 'admin', status: 'approved', active: true, shopId: '', createdAt: now - 400 * 86400000 },
        uidB: { email: 'test.alt.verkauf@hetec-gmbh.de', name: 'Alt Verkauf', role: 'verkaeufer', status: 'approved', active: true, shopId: 'Aalen', extraShopIds: ['crailsheim', 'gibtsnicht'] },
        uidC: { email: 'test.alt.springer@hetec-gmbh.de', name: 'Alt Springer', role: 'verkaeufer', status: 'approved', active: true, shopId: 'sha', isSpringer: true },
        uidD: { email: 'test.alt.wartet@hetec-gmbh.de', name: 'Alt Wartet', role: 'verkaeufer', status: 'pending', active: false, shopId: 'crailsheim' },
        uidE: { email: 'test.alt.gesperrt@hetec-gmbh.de', name: 'Alt Gesperrt', role: 'verkaeufer', status: 'blocked', active: false, shopId: 'aalen', allowedShops: { rosenheim: true, traunstein: false } },
        uidF: { email: 'keine-email', name: 'Kaputt' },
      },
      analytics: {
        a1: { id: 'a1', ts: iso(3), user: 'Alt Verkauf', userUid: 'uidB', shop: 'o2 Shop Aalen', shopId: 'aalen', result: 'Angebot', exempt: false, canvasStats: { offer1: { used: true, strokes: 4 } } },
        a2: { id: 'a2', ts: iso(2), user: 'Alt Verkauf', shop: 'o2 Shop Aalen', shopId: 'aalen', result: 'Abschluss', canvasStats: {} },
        a3: { id: 'a3', ts: iso(1), user: 'Unbekannt X', shopId: 'aalen', result: 'Anfrage' },
        a4: { id: 'a4', user: 'ohne Zeit' },
        'bad id': { id: 'bad id', ts: iso(1) },
      },
      saved_offers: {
        o1: { id: 'o1', ts: now - 86400000, label: 'Synthetik Kunde', kunde: 'Synthetik Kunde', shopId: 'aalen', agent: 'Alt Verkauf', userUid: 'uidB', payload: JSON.stringify({ textData: { Kundenname: 'Synthetik Kunde' } }) },
        o2: { id: 'o2', ts: now - 40 * 86400000, shopId: 'aalen', payload: '{}' },
        o3: { id: 'o3', ts: now, shopId: '', payload: '{}' },
      },
      skip_limits: {
        'limit_Alt Verkauf': { agent: 'Alt Verkauf', max_limit: 20, exempt: false },
        'skip_Alt Verkauf_2026-11': { agent: 'Alt Verkauf', month: '2026-11', count: 4 },
        'limit_Niemand': { agent: 'Niemand', max_limit: 5 },
      },
      tool_usage: { 'wlan_Alt Verkauf_2026-11': { agent: 'Alt Verkauf', tool: 'wlan', month: '2026-11', count: 7 } },
      news: { o2: { items: [{ text: 'Synthetische Meldung', bis: '' }, { text: '' }] }, unbekannt: { items: [] } },
      pdf_index: { 'pencil_angebot_aalen_x.pdf': { fileName: 'PENCIL_Angebot_aalen_X.pdf', typ: 'angebot', shopId: 'aalen', kunde: 'Synthetik Kunde', keys: ['n:synthetik'], src: 'app', uid: 'uidB', ts: now } },
      aktionsmappe: { global: { bundles: [{ id: 'net-mesh', name: 'Mesh-Paket (synthetisch)' }] } },
    },
  };
}

before(async () => {
  if (skip) return;
  env = await startEnv({ seed: false });
  file = path.join(env.tmp, 'export.json');
  fs.writeFileSync(file, JSON.stringify(fixture()));
});
after(async () => { if (env) await env.stop(); });

const imp = (...args) => JSON.parse(execFileSync('php', [path.join(ROOT, 'backend/bin/import-firestore.php'), ...args], { env: env.env }).toString());

test('Testlauf (--dry-run) liefert Bericht und speichert nichts', { skip }, () => {
  const r = imp(file, '--dry-run');
  assert.equal(r.dryRun, true);
  assert.equal(r.report.users.imported, 5);
  assert.equal(Number(env.sql('SELECT COUNT(*) n FROM users')[0].n), 0);
  assert.equal(Number(env.sql('SELECT COUNT(*) n FROM import_batches')[0].n), 0);
});

let batch;
test('Übernahme: vollständig, Rollen/Status/Shops korrekt, ungültige Datensätze mit Grund übersprungen', { skip }, () => {
  const r = imp(file, '--super-admin=test.alt.admin@hetec-gmbh.de');
  batch = r.batch;
  const rep = r.report;
  assert.deepEqual([rep.users.imported, rep.users.skipped['keine gültige E-Mail']], [5, 1]);
  assert.equal(rep.analytics.imported, 3);
  assert.equal(rep.analytics.skipped['kein Zeitstempel'], 1);
  assert.equal(rep.analytics.skipped['ungültige ID'], 1);
  assert.equal(rep.saved_offers.imported, 1);
  assert.equal(rep.saved_offers.skipped['älter als 30 Tage (Löschfrist)'], 1);
  assert.equal(rep.saved_offers.skipped['ohne gültigen Shop (Altbestand)'], 1);
  assert.equal(rep.skip_limits.imported, 2);
  assert.equal(rep.skip_limits.skipped['Agent nicht eindeutig zuordenbar'], 1);
  assert.equal(rep.tool_usage.imported, 1);
  assert.equal(rep.news.imported, 1);
  assert.equal(rep.pdf_index.imported, 1);
  assert.equal(rep.aktionsmappe.imported, 1);
  const u = Object.fromEntries(env.sql('SELECT email, role_id, status, all_shops, home_shop_id, legacy_firebase_uid, entra_object_id FROM users').map(x => [x.email, x]));
  assert.equal(u['test.alt.admin@hetec-gmbh.de'].role_id, 'super_admin');
  assert.equal(u['test.alt.verkauf@hetec-gmbh.de'].home_shop_id, 'aalen');
  assert.equal(Number(u['test.alt.springer@hetec-gmbh.de'].all_shops), 1);
  assert.equal(u['test.alt.springer@hetec-gmbh.de'].home_shop_id, 'schwaebisch-hall');
  assert.equal(u['test.alt.wartet@hetec-gmbh.de'].status, 'pending');
  assert.equal(u['test.alt.gesperrt@hetec-gmbh.de'].status, 'blocked');
  assert.ok(Object.values(u).every(x => x.entra_object_id === null), 'keine automatische Microsoft-Verknüpfung beim Import');
  const extra = env.sql("SELECT us.shop_id FROM user_shops us JOIN users u ON u.id = us.user_id WHERE u.email IN ('test.alt.verkauf@hetec-gmbh.de','test.alt.gesperrt@hetec-gmbh.de') ORDER BY us.shop_id").map(x => x.shop_id);
  assert.deepEqual(extra, ['crailsheim', 'rosenheim'], 'unbekannte Shops und false-Einträge nicht übernommen');
  const a = Object.fromEntries(env.sql('SELECT e.id, u.email FROM analytics_events e LEFT JOIN users u ON u.id = e.user_id').map(x => [x.id, x.email]));
  assert.equal(a.a1, 'test.alt.verkauf@hetec-gmbh.de', 'per Firebase-UID');
  assert.equal(a.a2, 'test.alt.verkauf@hetec-gmbh.de', 'per eindeutigem Namen');
  assert.equal(a.a3, null, 'nicht zuordenbar → bleibt ohne Benutzer erhalten (Historie)');
  const off = env.sql("SELECT HEX(payload_enc) h FROM saved_offers WHERE id = 'o1'")[0].h;
  assert.ok(!Buffer.from(off, 'hex').toString('latin1').includes('Synthetik'), 'Angebot verschlüsselt');
});

test('Wiederholte Übernahme erzeugt keine Dubletten', { skip }, () => {
  const before = env.sql('SELECT (SELECT COUNT(*) FROM users) u, (SELECT COUNT(*) FROM analytics_events) a, (SELECT COUNT(*) FROM saved_offers) o')[0];
  const r = imp(file);
  assert.equal(r.report.users.imported, 0);
  assert.equal(r.report.users.existing, 5);
  assert.equal(r.report.analytics.imported, 0);
  const after = env.sql('SELECT (SELECT COUNT(*) FROM users) u, (SELECT COUNT(*) FROM analytics_events) a, (SELECT COUNT(*) FROM saved_offers) o')[0];
  assert.deepEqual(after, before);
});

test('Migrierter Benutzer wird bei der ersten Microsoft-Anmeldung eindeutig über die E-Mail verknüpft und sieht seine Historie', { skip }, async () => {
  const c = new Client(env.app);
  const email = 'test.alt.verkauf@hetec-gmbh.de';
  const { session } = await c.loginEntra(env, { oid: await devOid(email), email, name: 'Alt Verkauf', given: 'Alt', family: 'Verkauf' });
  assert.equal(session.authenticated, true);
  assert.deepEqual(session.user.allowedShopIds, ['aalen', 'crailsheim']);
  const own = await c.get('/api/v1/analytics?scope=own');
  assert.deepEqual(own.json.rows.map(r => r.id).sort(), ['a1', 'a2']);
  const offers = await c.get('/api/v1/offers');
  assert.ok(offers.json.offers.some(o => o.id === 'o1' && o.kunde === 'Synthetik Kunde'));
  assert.equal(env.sql(`SELECT entra_object_id IS NOT NULL l FROM users WHERE email = '${email}'`)[0].l, 1);
});

test('Rücknahme eines Laufs entfernt genau die übernommenen Datensätze', { skip }, () => {
  const r = imp('--rollback=' + batch);
  assert.ok(r.deleted.users >= 5);
  assert.equal(Number(env.sql('SELECT COUNT(*) n FROM users WHERE legacy_firebase_uid IS NOT NULL')[0].n), 0);
  assert.equal(Number(env.sql('SELECT COUNT(*) n FROM analytics_events')[0].n), 0);
  assert.equal(Number(env.sql('SELECT COUNT(*) n FROM saved_offers')[0].n), 0);
  assert.equal(Number(env.sql('SELECT COUNT(*) n FROM shops')[0].n), 12, 'Stammdaten bleiben');
});

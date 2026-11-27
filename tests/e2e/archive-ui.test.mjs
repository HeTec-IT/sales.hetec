// Archivierung über die echte Oberfläche: Fertigstellen → Angebot teilen → Ins Archiv & neuer Kunde.
// Echte PDF-Erzeugung im Browser, Firebase-Testersatz, Power-Automate-ATTRAPPEN (kein echter Flow, synthetische Daten).
// Prüft die Rückmeldung an den Mitarbeiter: "erfolgreich" nur nach Fund in SharePoint.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { browsers, staticServer, ROOT } from './lib.mjs';

const FAKE = fs.readFileSync(path.join(ROOT, 'tests/e2e/fake-firebase-compat.js'), 'utf8');
const NS = 'o2-pencil-selling';
const SEED = { accounts: [{ uid: 'uidA', email: 'test.anna@hetec-gmbh.de', password: 'Synthetik-123' }], docs: { [NS + '|users/uidA']: { email: 'test.anna@hetec-gmbh.de', name: 'Anna Archiv', vorname: 'Anna', nachname: 'Archiv', role: 'verkaeufer', active: true, status: 'approved', shopId: 'aalen' } } };
let srv, browser;
before(async () => { srv = await staticServer(ROOT); const l = await browsers(['chromium']); browser = l[0] && l[0].b; });
after(async () => { if (browser) await browser.close(); if (srv) await srv.close(); });

async function run({ archiveDown = false, storeAfterMs = 3000, neverStore = false, kunde = 'Max Synthetik' }) {
  const ctx = await browser.newContext();
  const pg = await ctx.newPage({ viewport: { width: 1280, height: 900 } });
  const errs = [];
  pg.on('pageerror', e => errs.push(String(e).slice(0, 300)));
  await ctx.addInitScript(seed => { window.__FAKE_FB_SEED = seed; }, SEED);
  const stored = new Set(); const payloads = [];
  await ctx.route(u => !u.href.startsWith(srv.url) && !/^(data|blob):/.test(u.href), async r => {
    const u = r.request().url();
    if (/firebase-app-compat\.js$/.test(u)) return r.fulfill({ contentType: 'text/javascript', body: FAKE });
    if (/gstatic\.com\/firebasejs\//.test(u)) return r.fulfill({ contentType: 'text/javascript', body: '' });
    if (u.includes('6e4980d3dcb74b89bec5b9d88d14e5eb')) {
      if (archiveDown) return r.abort('internetdisconnected');
      const p = JSON.parse(r.request().postData() || '{}');
      payloads.push({ name: p.archiveFileName, subject: p.archiveSubject, pdfLen: (p.pdfBase64 || '').length, agent: p.agent, shop: p.shop });
      if (!neverStore) setTimeout(() => stored.add(String(p.archiveFileName).toLowerCase()), storeAfterMs);
      return r.fulfill({ status: 202, body: '' });
    }
    if (u.includes('b2b28ed9cc334864ab329d8369175831')) {
      const p = JSON.parse(r.request().postData() || '{}');
      const found = (p.names || []).filter(n => stored.has(String(n).toLowerCase()));
      return r.fulfill({ status: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, found }) });
    }
    return r.abort();
  });
  const click = async t => { await pg.locator('button', { hasText: t }).first().click({ timeout: 15000 }); await pg.waitForTimeout(700); };
  await pg.goto(srv.url + '/index.html');
  await pg.waitForSelector('#ps-gate-email', { timeout: 30000 });
  await pg.fill('#ps-gate-email', 'test.anna@hetec-gmbh.de'); await pg.fill('#ps-gate-pw', 'Synthetik-123'); await pg.click('#ps-gate-submit');
  await pg.waitForSelector('header', { timeout: 40000 }); await pg.waitForTimeout(2000);
  await click('Überspringen');
  await pg.selectOption('select', { index: 1 });
  await click('Bestätigen & Springen');
  await pg.locator('footer button, .fixed.bottom-0 button').nth(1).click().catch(() => {}); // Tastatur-Modus
  await pg.waitForTimeout(600);
  await pg.evaluate(() => { const t = [...document.querySelectorAll('textarea')].find(e => e.offsetParent); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(t, 'Synthetisches Testangebot'); t.dispatchEvent(new Event('input', { bubbles: true })); });
  await pg.waitForTimeout(400);
  await click('Offen');
  await click('Fertigstellen');
  await click('Angebot teilen und Archivieren');
  await pg.fill('#offer-validity-modal-input', '2026-12-31');
  await click('Speichern & Weiter');
  await pg.fill('input[placeholder^="Vorname Nachname"]', kunde);
  await click('Weiter & PDF erstellen');
  await click('Jetzt teilen');
  await pg.waitForSelector('text=Ins Archiv & neuer Kunde', { timeout: 90000 });
  // Schritt 1 abschließen (Desktop-Browser ohne Teilen-Menü): "Kunde möchte nichts mitnehmen"
  await pg.locator('button', { hasText: 'Kunde möchte nichts mitnehmen' }).first().click({ timeout: 3000 }).catch(() => {});
  await pg.waitForTimeout(500);
  const phases = [];
  const watch = setInterval(async () => {
    try {
      const ph = await pg.getAttribute('[data-archiv-phase]', 'data-archiv-phase', { timeout: 150 });
      if (ph && phases[phases.length - 1] !== ph) phases.push(ph);
      if (ph === 'verifying' && neverStore) await pg.locator('button', { hasText: 'Nicht warten' }).click({ timeout: 300 }).catch(() => {});
    } catch (e) {}
  }, 200);
  await Promise.all([pg.waitForEvent('load', { timeout: 120000 }), click('Ins Archiv & neuer Kunde')]);
  clearInterval(watch);
  await pg.waitForFunction(() => window.PSArchivQueue && window.__PS_USER_UID === 'uidA', null, { timeout: 40000 });
  const queue = await pg.evaluate(async () => (await PSArchivQueue.queue('o2').all()).map(r => ({ status: r.status, fileName: r.fileName, uid: r.uid, shopId: r.shopId, hasPdf: !!r.pdfBlob })));
  const index = await pg.evaluate(() => { const d = firebase.__state().docs; return Object.keys(d).filter(k => k.includes('|pdf_index/')).map(k => ({ fileName: d[k].fileName, uid: d[k].uid, shopId: d[k].shopId })); });
  await ctx.close();
  return { phases, queue, index, payloads, errs };
}

test('Oberfläche: Archivierung bestätigt → "Archivierung erfolgreich" erst nach Fund in SharePoint', { timeout: 240000 }, async t => {
  if (!browser) return t.skip('kein Browser');
  const r = await run({ storeAfterMs: 3000 });
  assert.deepEqual(r.phases, ['verifying', 'verified']);
  assert.equal(r.payloads.length, 1);
  assert.match(r.payloads[0].name, /^PENCIL_Max-Synthetik--\d{4}[0-9a-z]{3}_Aalen_Angebot_\d{4}-\d{2}-\d{2}\.pdf$/);
  assert.match(r.payloads[0].subject, /^PENCIL\|angebot\|\d{4}-\d{2}-\d{2}\|Anna$/);
  assert.ok(r.payloads[0].pdfLen > 20000, 'echte PDF übertragen');
  assert.deepEqual(r.queue.map(q => [q.status, q.uid, q.shopId, q.hasPdf]), [['verified', 'uidA', 'aalen', false]]);
  assert.deepEqual(r.index.map(i => [i.fileName, i.uid, i.shopId]), [[r.payloads[0].name, 'uidA', 'aalen']]);
  assert.deepEqual(r.errs, []);
});

test('Oberfläche: Flow nicht erreichbar → "Archivierung ausstehend", Vorgang gesichert (kein Schein-Erfolg)', { timeout: 240000 }, async t => {
  if (!browser) return t.skip('kein Browser');
  const r = await run({ archiveDown: true, kunde: 'Erika Synthetik' });
  assert.deepEqual(r.phases, ['queued']);
  assert.equal(r.queue.length, 1);
  assert.equal(r.queue[0].status, 'pending'); assert.equal(r.queue[0].hasPdf, true); assert.equal(r.queue[0].uid, 'uidA');
  assert.equal(r.index.length, 0, 'kein Index-Eintrag ohne Übergabe');
});

test('Oberfläche: übergeben, aber (noch) nicht in SharePoint → "An das Archiv übergeben", nicht "erfolgreich"', { timeout: 240000 }, async t => {
  if (!browser) return t.skip('kein Browser');
  const r = await run({ neverStore: true, kunde: 'Hans Synthetik' });
  assert.deepEqual(r.phases, ['verifying', 'handed']);
  assert.equal(r.queue[0].status, 'handed'); assert.equal(r.queue[0].hasPdf, true, 'PDF bleibt bis zur Bestätigung gesichert');
});

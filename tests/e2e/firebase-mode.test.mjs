// Firebase-Betrieb (GitHub-Pages-Beta, Repo-Konfiguration backend:'firebase') mit Firebase-TESTERSATZ:
// prüft Anmeldung, App-Start und die Datenwege des Migrationsadapters, ohne echte Firebase-Verbindung.
// Echte Firebase-Server und echte Konten werden NICHT verwendet (synthetische Daten).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { browsers, staticServer, ROOT } from './lib.mjs';

const FAKE = fs.readFileSync(path.join(ROOT, 'tests/e2e/fake-firebase-compat.js'), 'utf8');
const NS = 'o2-pencil-selling';
const SEED = {
  accounts: [{ uid: 'uidMax', email: 'test.max.verkauf@hetec-gmbh.de', password: 'Synthetik-123' }],
  docs: {
    [NS + '|users/uidMax']: { email: 'test.max.verkauf@hetec-gmbh.de', name: 'Max Verkauf', vorname: 'Max', nachname: 'Verkauf', role: 'verkaeufer', active: true, status: 'approved', shopId: 'aalen' },
    [NS + '|news/o2']: { items: [{ text: 'Synthetische Testmeldung', bis: '' }] }
  }
};
let srv, list = [];
// PS_FB_ROOT/PS_FB_PATH: dieselbe Prüfung gegen eine gebaute Testversion (scripts/build-preview.mjs)
const FB_ROOT = process.env.PS_FB_ROOT || ROOT, FB_PATH = process.env.PS_FB_PATH || '/index.html';
before(async () => { srv = await staticServer(FB_ROOT); list = await browsers(); }); // Chromium + WebKit (wenn installiert)
after(async () => { for (const { b } of list) await b.close(); if (srv) await srv.close(); });

async function open(ctx) {
  const pg = await ctx.newPage({ viewport: { width: 1280, height: 860 } });
  pg.errs = []; pg.ext = [];
  pg.on('pageerror', e => pg.errs.push(String(e).slice(0, 300)));
  await pg.addInitScript(seed => { window.__FAKE_FB_SEED = seed; }, SEED);
  await pg.route(u => !u.href.startsWith(srv.url) && !/^(data|blob):/.test(u.href), route => {
    const u = route.request().url();
    if (/^https:\/\/www\.gstatic\.com\/firebasejs\/[\d.]+\/firebase-app-compat\.js$/.test(u)) return route.fulfill({ contentType: 'text/javascript', body: FAKE });
    if (/^https:\/\/www\.gstatic\.com\/firebasejs\//.test(u)) return route.fulfill({ contentType: 'text/javascript', body: '/* im Ersatz enthalten */' });
    pg.ext.push(new URL(u).host);
    return route.abort();
  });
  await pg.goto(srv.url + FB_PATH);
  return pg;
}

test('Firebase-Betrieb: Anmeldung, App-Start, Datenwege des Adapters, Abmeldung', { timeout: 150000 }, async t => {
  if (!list.length) return t.skip('kein Browser');
  for (const { name: bn, b } of list) {
  const ctx = await b.newContext();
  const pg = await open(ctx);
  await pg.waitForSelector('#ps-gate-email', { timeout: 30000 });
  assert.equal(await pg.evaluate('PSBackend.mode'), 'firebase');
  await pg.fill('#ps-gate-email', 'test.max.verkauf@hetec-gmbh.de');
  await pg.fill('#ps-gate-pw', 'Synthetik-123');
  await pg.click('#ps-gate-submit');
  await pg.waitForSelector('header', { timeout: 40000 });
  await pg.waitForFunction('window.PSBackend && PSBackend.auth.isSignedIn()');
  await pg.waitForTimeout(2000);
  assert.equal(await pg.evaluate('window.__PS_PROFILE_NAME'), 'Max Verkauf');

  const r = await pg.evaluate(async () => {
    const out = {};
    out.news = await PSBackend.news.load('o2');
    const id = 'fb_e2e_' + Date.now();
    out.write = await PSBackend.analytics.write({ id, ts: new Date().toISOString(), user: 'Max Verkauf', userUid: PSBackend.auth.currentUid(), shopId: 'aalen', result: 'Angebot', canvasStats: {} });
    out.own = (await PSBackend.analytics.loadOwn(PSBackend.auth.currentUid())).map(x => x.id).includes(id);
    out.skipCount = await PSBackend.skip.getCount('Max Verkauf');
    await PSBackend.skip.increment('Max Verkauf');
    out.skipCount2 = await PSBackend.skip.getCount('Max Verkauf');
    await PSBackend.tools.track('wlan', 'Max Verkauf');
    const oid = 'off_e2e_' + Date.now();
    await PSBackend.offers.save({ id: oid, ts: Date.now(), label: 'Synthetik', agent: 'Max Verkauf', userUid: PSBackend.auth.currentUid(), shopId: 'aalen', kunde: 'Synthetik Kunde' }, JSON.stringify({ textData: { Kundenname: 'Synthetik Kunde' } }));
    out.offerListed = (await PSBackend.offers.list({ shopId: 'aalen', isAdmin: false, maxAgeMs: 30 * 86400000 })).some(o => o.id === oid);
    out.offerLoaded = (await PSBackend.offers.load(oid)).textData.Kundenname;
    out.offerRemoved = await PSBackend.offers.remove(oid);
    const st = firebase.__state();
    out.analyticsDoc = !!st.docs['o2-pencil-selling|analytics/' + id];
    out.toolDocs = Object.keys(st.docs).filter(k => k.includes('tool_usage/')).length;
    return out;
  });
  assert.deepEqual(r.news, [{ text: 'Synthetische Testmeldung', bis: '' }]);
  assert.equal(r.write, true);
  assert.equal(r.analyticsDoc, true);
  assert.equal(r.own, true);
  assert.equal(r.skipCount2, r.skipCount + 1);
  assert.ok(r.toolDocs >= 1);
  assert.deepEqual([r.offerListed, r.offerLoaded, r.offerRemoved], [true, 'Synthetik Kunde', true]);
  assert.deepEqual(pg.errs, [], 'Skriptfehler');
  assert.deepEqual([...new Set(pg.ext)].filter(h => !/gstatic|googleapis|firebase/.test(h)), [], 'unerwartete externe Hosts: ' + pg.ext);

  await Promise.all([pg.waitForEvent('load'), pg.evaluate('PSBackend.auth.signOutAndReload()')]);
  await pg.waitForSelector('#ps-gate-email', { timeout: 30000 });
  await ctx.close();
  t.diagnostic(bn + ': ok');
  }
});

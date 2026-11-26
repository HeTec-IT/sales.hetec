// Ende-zu-Ende gegen das RELEASE-Artefakt (npm run release): echter OIDC-Ablauf über den Mock-Entra-Provider,
// echtes PHP-Backend + MariaDB, Service Worker, Offline, Synchronisierung, Netzwerk-Allowlist, CSP, Update.
// Kein Test-Login (backend/dev ist im Release nicht enthalten).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startEnv, phpAvailable, devOid } from '../backend/harness.mjs';
import { browsers, ROOT } from './lib.mjs';

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const REL = path.join(ROOT, 'release', `pencil-selling-${pkg.version}`);
const skip = (!phpAvailable() && 'PHP fehlt') || (!fs.existsSync(path.join(REL, 'public/index.html')) && 'Release fehlt (npm run release)');
let env, list = [];

before(async () => {
  if (skip) return;
  env = await startEnv({ releaseDir: REL });
  list = await browsers(['chromium']);  // Service Worker + Offline in Chromium (WebKit separat)
});
after(async () => { for (const { b } of list) await b.close(); if (env) await env.stop(); });

const ident = async (email, name) => ({ oid: await devOid(email), email, name, given: name.split(' ')[0], family: name.split(' ')[1] || '' });

async function login(ctx, email, name) {
  await env.mock.setMode('ok', await ident(email, name));
  const pg = await ctx.newPage({ viewport: { width: 1280, height: 860 } });
  pg.errs = []; pg.ext = []; pg.csp = [];
  pg.on('pageerror', e => pg.errs.push(String(e).slice(0, 300)));
  pg.on('request', r => { const u = new URL(r.url()); if (!/^(data|blob):/.test(r.url()) && u.host !== new URL(env.app).host && u.host !== '127.0.0.1:' + env.mock.port) pg.ext.push(u.host); });
  await pg.addInitScript(() => { document.addEventListener('securitypolicyviolation', e => { (window.__csp = window.__csp || []).push(e.violatedDirective + ' ' + e.blockedURI); }); });
  await pg.goto(env.app + '/');
  await pg.waitForSelector('#ps-ms-login', { timeout: 20000 });
  assert.equal(await pg.locator('#ps-dev-login button').count(), 0, 'kein Test-Login im Release');
  await pg.click('#ps-ms-login');
  await pg.waitForSelector('header', { timeout: 40000 });
  await pg.waitForFunction('window.__PS_USER_UID && window.PSBackend && PSBackend.auth.isSignedIn()');
  return pg;
}

test('Release: Microsoft-Anmeldung (Mock) → App läuft, keine externen Verbindungen, keine CSP-Verstöße, keine Skriptfehler', { skip, timeout: 120000 }, async t => {
  if (!list.length) return t.skip('kein Chromium');
  const ctx = await list[0].b.newContext();
  const pg = await login(ctx, 'test.max.verkauf@hetec-gmbh.de', 'Max Verkauf');
  await pg.waitForTimeout(2500);
  assert.equal(await pg.evaluate('window.__PS_PROFILE_NAME'), 'Max Verkauf');
  assert.equal(await pg.evaluate('PSBackend.mode'), 'hetec');
  assert.equal(await pg.evaluate('typeof window.firebase'), 'undefined');
  // Power-Automate-Flows laufen über das Backend (Platzhalter statt signierter URL; hier nicht konfiguriert → 503)
  assert.equal(await pg.evaluate("fetch('ps-flow:followup', { method: 'POST', mode: 'no-cors', body: JSON.stringify({ shop: 'Aalen' }) }).then(r => r.status)"), 503);
  assert.deepEqual(pg.ext, [], 'externe Hosts: ' + pg.ext);
  assert.deepEqual(await pg.evaluate('window.__csp || []'), []);
  assert.deepEqual(pg.errs, []);
  assert.match(await pg.evaluate('window.APP_VERSION'), new RegExp(pkg.version.replace(/\./g, '\\.')));
  await ctx.close();
});

test('Release: Statistikzeile offline erfassen → nach dem Online-Gehen genau einmal auf dem Server (keine Doppelzählung)', { skip, timeout: 120000 }, async t => {
  if (!list.length) return t.skip('kein Chromium');
  const ctx = await list[0].b.newContext();
  const pg = await login(ctx, 'test.mia.verkauf@hetec-gmbh.de', 'Mia Verkauf');
  await ctx.setOffline(true);
  const id = 'e2e_offline_' + Date.now();
  await pg.evaluate(id => appendAnalyticsRow({ id, ts: new Date().toISOString(), user: 'Mia Verkauf', shop: CURRENT_SHOP.name, shopId: CURRENT_SHOP.id, result: 'Angebot', beratungsId: 'E2E', exempt: false, canvasStats: {} }), id);
  await pg.waitForTimeout(1500);
  assert.equal(await pg.evaluate('PSBackend.analytics.pendingCount()'), 1, 'offline in IndexedDB eingereiht');
  await ctx.setOffline(false);
  await pg.evaluate('PSBackend.analytics.flush()');
  await pg.waitForFunction('PSBackend.analytics.pendingCount().then(n => n === 0)', null, { timeout: 15000 }).catch(() => {});
  assert.equal(await pg.evaluate('PSBackend.analytics.pendingCount()'), 0);
  // dieselbe Zeile erneut senden (Wiederholung/Neustart) → weiterhin genau eine
  await pg.evaluate(id => PSBackend.analytics.write({ id, ts: new Date().toISOString(), user: 'Mia Verkauf', shopId: CURRENT_SHOP.id, result: 'Angebot', canvasStats: {} }).then(() => PSBackend.analytics.flush()), id);
  await pg.waitForTimeout(800);
  const rows = env.sql(`SELECT COUNT(*) AS n FROM analytics_events WHERE id = '${id}'`);
  assert.equal(Number(rows[0].n), 1);
  await ctx.close();
});

test('Release: Service Worker lädt die App offline aus dem Cache (zeitlich begrenzte Offline-Sitzung)', { skip, timeout: 120000 }, async t => {
  if (!list.length) return t.skip('kein Chromium');
  const ctx = await list[0].b.newContext();
  const pg = await login(ctx, 'test.max.verkauf@hetec-gmbh.de', 'Max Verkauf');
  await pg.waitForFunction('navigator.serviceWorker.controller !== null || navigator.serviceWorker.ready.then(() => true)', null, { timeout: 30000 });
  await pg.evaluate('navigator.serviceWorker.ready');
  await pg.reload();                                   // jetzt vom Service Worker kontrolliert
  await pg.waitForSelector('header', { timeout: 30000 });
  await ctx.setOffline(true);
  await pg.reload();
  await pg.waitForSelector('header', { timeout: 30000 });
  assert.equal(await pg.evaluate('PSBackend.auth.isOffline()'), true, 'Offline-Start mit dem zuletzt bestätigten Profil');
  assert.equal(await pg.evaluate('window.__PS_PROFILE_NAME'), 'Max Verkauf');
  await ctx.setOffline(false);
  await ctx.close();
});

test('Release: Abmelden beendet die Sitzung serverseitig; danach nur noch Anmeldeseite', { skip, timeout: 120000 }, async t => {
  if (!list.length) return t.skip('kein Chromium');
  const ctx = await list[0].b.newContext();
  const pg = await login(ctx, 'test.max.verkauf@hetec-gmbh.de', 'Max Verkauf');
  pg.on('dialog', d => d.accept());
  await pg.click('#ps-logout-icon');
  await pg.waitForSelector('#ps-ms-login', { timeout: 30000 });
  const s = await pg.evaluate(() => fetch('api/v1/session', { credentials: 'same-origin' }).then(r => r.json()));
  assert.equal(s.authenticated, false);
  assert.equal(await pg.evaluate("PSSyncQueue.kvGet('session')"), undefined, 'kein Offline-Profil mehr auf dem Gerät');
  await ctx.close();
});

test('Release: Benutzerwechsel auf geteiltem Tablet – Warteschlange des Vorgängers wird nicht unter neuer Anmeldung gesendet', { skip, timeout: 150000 }, async t => {
  if (!list.length) return t.skip('kein Chromium');
  const ctx = await list[0].b.newContext();
  const pg = await login(ctx, 'test.max.verkauf@hetec-gmbh.de', 'Max Verkauf');
  const maxUid = await pg.evaluate('window.__PS_USER_UID');
  const id = 'e2e_switch_' + Date.now();
  await pg.evaluate(([uid, id]) => PSSyncQueue.put('analytics', uid, { id, ts: new Date().toISOString(), user: 'Max Verkauf', shopId: 'aalen', result: 'Angebot', canvasStats: {} }), [maxUid, id]);
  pg.on('dialog', d => d.accept());
  await pg.click('#ps-logout-icon');
  await pg.waitForSelector('#ps-ms-login');
  await pg.close();
  // Beim Abmelden wird Max' offene Zeile noch unter Max gesendet (kein stiller Verlust)
  const sent = env.sql(`SELECT u.email FROM analytics_events e JOIN users u ON u.id = e.user_id WHERE e.id = '${id}'`);
  assert.deepEqual(sent.map(x => x.email), ['test.max.verkauf@hetec-gmbh.de'], 'beim Abmelden unter Max gesendet');
  const pg2 = await login(ctx, 'test.mia.verkauf@hetec-gmbh.de', 'Mia Verkauf');
  // Restbestand von Max (z. B. aus einem anderen Tab) darf nicht unter Mias Anmeldung gesendet werden
  const id2 = id + '_rest';
  await pg2.evaluate(([uid, id]) => PSSyncQueue.put('analytics', uid, { id, ts: new Date().toISOString(), user: 'Max Verkauf', shopId: 'aalen', result: 'Angebot', canvasStats: {} }), [maxUid, id2]);
  await pg2.evaluate('PSBackend.analytics.flush()');
  await pg2.waitForTimeout(1000);
  assert.equal(Number(env.sql(`SELECT COUNT(*) AS n FROM analytics_events WHERE id = '${id2}'`)[0].n), 0, 'Zeile von Max nicht unter Mia gesendet');
  assert.equal(await pg2.evaluate(uid => PSSyncQueue.count(uid), maxUid), 1, 'bleibt für Max liegen');
  await ctx.close();
});

test('Release: neue Version wird erkannt, wartet und ersetzt die alte vollständig (keine Mischung)', { skip, timeout: 150000 }, async t => {
  if (!list.length) return t.skip('kein Chromium');
  const pub = path.join(REL, 'public');
  const swFile = path.join(pub, 'sw.js'), manFile = path.join(pub, 'sw-manifest.js');
  const swOrig = fs.readFileSync(swFile, 'utf8'), manOrig = fs.readFileSync(manFile, 'utf8');
  const ctx = await list[0].b.newContext();
  try {
    const pg = await login(ctx, 'test.max.verkauf@hetec-gmbh.de', 'Max Verkauf');
    await pg.evaluate('navigator.serviceWorker.ready');
    const v1 = await pg.evaluate(() => new Promise(r => { const ch = new MessageChannel(); ch.port1.onmessage = e => r(e.data.version); navigator.serviceWorker.controller ? navigator.serviceWorker.controller.postMessage({ type: 'GET_VERSION' }, [ch.port2]) : navigator.serviceWorker.ready.then(reg => reg.active.postMessage({ type: 'GET_VERSION' }, [ch.port2])); }));
    // "Neues Release" einspielen: anderer Versionsstempel
    fs.writeFileSync(manFile, manOrig.replace(/"version":"([^"]+)"/, '"version":"$1-neu"'));
    fs.writeFileSync(swFile, '/* neues Release */\n' + swOrig);
    await pg.evaluate('navigator.serviceWorker.getRegistration().then(r => r.update())');
    await pg.waitForSelector('#ps-update-banner', { timeout: 30000 });
    // Bis zur Bestätigung läuft weiter die alte Version
    const still = await pg.evaluate(() => new Promise(r => { const ch = new MessageChannel(); ch.port1.onmessage = e => r(e.data.version); navigator.serviceWorker.controller.postMessage({ type: 'GET_VERSION' }, [ch.port2]); }));
    assert.equal(still, v1);
    await Promise.all([pg.waitForEvent('load', { timeout: 30000 }), pg.click('#ps-update-banner button')]);
    await pg.waitForSelector('header', { timeout: 30000 });
    const v2 = await pg.evaluate(() => new Promise(r => { const ch = new MessageChannel(); ch.port1.onmessage = e => r(e.data.version); navigator.serviceWorker.controller.postMessage({ type: 'GET_VERSION' }, [ch.port2]); }));
    assert.equal(v2, v1 + '-neu');
    const caches = await pg.evaluate('caches.keys()');
    assert.equal(caches.filter(k => k.startsWith('ps-app-')).length, 1, 'genau ein App-Cache (alte Version entfernt): ' + caches);
  } finally {
    fs.writeFileSync(swFile, swOrig);
    fs.writeFileSync(manFile, manOrig);
    await ctx.close();
  }
});

// Archivierung Ende-zu-Ende im Browser (GitHub-Pages-Beta, Firebase-Testersatz, Power-Automate-ATTRAPPEN).
// Synthetische Mitarbeiter/Kunden. Es wird KEIN echter Flow, KEIN echtes SharePoint und KEIN echtes Firebase aufgerufen.
//   Archiv-Flow (no-cors)        → Attrappe legt den Dateinamen in "SharePoint" (Set) ab – wahlweise verzögert/gestört
//   PDF Archiv API V3 (exists)   → Attrappe antwortet aus demselben Set (wahlweise Fehlerantwort)
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { browsers, staticServer, ROOT } from './lib.mjs';

const FAKE = fs.readFileSync(path.join(ROOT, 'tests/e2e/fake-firebase-compat.js'), 'utf8');
const NS = 'o2-pencil-selling';
const PW = 'Synthetik-123';
const prof = (name, vorname, shopId, extra = {}) => ({ email: '', name, vorname, nachname: name.split(' ')[1], role: 'verkaeufer', active: true, status: 'approved', shopId, ...extra });
const ACC = [
  ['uidA', 'test.anna@hetec-gmbh.de', prof('Anna Archiv', 'Anna', 'aalen')],
  ['uidB', 'test.bernd@hetec-gmbh.de', prof('Bernd Beispiel', 'Bernd', 'aalen')],
  ['uidC', 'test.clara@hetec-gmbh.de', prof('Clara Crails', 'Clara', 'crailsheim')],
  ['uidS', 'test.sven@hetec-gmbh.de', prof('Sven Springer', 'Sven', 'aalen', { springer: true })],
  ['uidAdm', 'test.admin@hetec-gmbh.de', prof('Ada Admin', 'Ada', '', { role: 'admin' })]
];
const SEED = { accounts: ACC.map(([uid, email]) => ({ uid, email, password: PW })), docs: Object.fromEntries(ACC.map(([uid, email, p]) => [NS + '|users/' + uid, { ...p, email }])) };
const EMAIL = Object.fromEntries(ACC.map(([uid, email]) => [uid, email]));

let srv, browser;
before(async () => { srv = await staticServer(ROOT); const l = await browsers(['chromium']); browser = l[0] && l[0].b; });
after(async () => { if (browser) await browser.close(); if (srv) await srv.close(); });

/** Attrappen-Zustand je Test (läuft in Node, Playwright-Routen greifen darauf zu) */
function flows() {
  return { stored: new Set(), payloads: [], archiveDown: false, storeDelayMs: 0, v3Broken: false, pendingStore: [] };
}
async function setup(fl) {
  const ctx = await browser.newContext();
  await ctx.addInitScript(seed => { window.__FAKE_FB_SEED = seed; window.__PS_TEST_HOOKS = true; }, SEED);
  await ctx.route(u => !u.href.startsWith(srv.url) && !/^(data|blob):/.test(u.href), async route => {
    const u = route.request().url();
    if (/firebase-app-compat\.js$/.test(u)) return route.fulfill({ contentType: 'text/javascript', body: FAKE });
    if (/gstatic\.com\/firebasejs\//.test(u)) return route.fulfill({ contentType: 'text/javascript', body: '' });
    if (u.includes('6e4980d3dcb74b89bec5b9d88d14e5eb')) { // Archiv-Flow
      if (fl.archiveDown) return route.abort('internetdisconnected');
      let p = {};
      try { p = JSON.parse(route.request().postData() || '{}'); } catch (e) {}
      fl.payloads.push({ archiveFileName: p.archiveFileName, archiveSubject: p.archiveSubject, agent: p.agent, shop: p.shop, type: p.type, key: p.key, pdf: !!p.pdfBase64 });
      const id = String(p.archiveFileName || '').toLowerCase().replace(/[^a-z0-9._+\-]/g, '_').slice(0, 180);
      if (fl.storeDelayMs) setTimeout(() => fl.stored.add(id), fl.storeDelayMs); else fl.stored.add(id);
      return route.fulfill({ status: 202, body: '' });
    }
    if (u.includes('b2b28ed9cc334864ab329d8369175831')) { // PDF Archiv API V3
      const h = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
      if (fl.v3Broken) return route.fulfill({ status: 500, headers: h, body: JSON.stringify({ ok: false, error: 'server' }) });
      let p = {};
      try { p = JSON.parse(route.request().postData() || '{}'); } catch (e) {}
      if (p.action === 'exists') {
        const found = (p.names || []).filter(n => fl.stored.has(String(n).toLowerCase().replace(/[^a-z0-9._+\-]/g, '_').slice(0, 180)));
        return route.fulfill({ status: 200, headers: h, body: JSON.stringify({ ok: true, found }) });
      }
      if (p.action === 'list') return route.fulfill({ status: 200, headers: h, body: JSON.stringify({ ok: true, items: [...fl.stored].map((n, i) => ({ id: i + 1, name: n })), lastId: fl.stored.size, done: true }) });
      return route.fulfill({ status: 200, headers: h, body: JSON.stringify({ ok: true }) });
    }
    return route.abort();
  });
  return ctx;
}
async function page(ctx) {
  const pg = await ctx.newPage({ viewport: { width: 1280, height: 860 } });
  pg.errs = [];
  pg.on('pageerror', e => pg.errs.push(String(e).slice(0, 300)));
  return pg;
}
async function login(pg, uid) {
  await pg.goto(srv.url + '/index.html');
  await pg.waitForSelector('#ps-gate-email', { timeout: 30000 });
  await pg.fill('#ps-gate-email', EMAIL[uid]);
  await pg.fill('#ps-gate-pw', PW);
  await pg.click('#ps-gate-submit');
  await pg.waitForSelector('header', { timeout: 40000 });
  await pg.waitForFunction(u => window.__PS_USER_UID === u && window.__psArchivTest && window.__psArchivQueueDeps, uid, { timeout: 20000 });
}
async function logout(pg) {
  await Promise.all([pg.waitForEvent('load'), pg.evaluate('PSBackend.auth.signOutAndReload()')]);
  await pg.waitForSelector('#ps-gate-email', { timeout: 30000 });
}
/** Archivierung über denselben Weg wie "Ins Archiv" (dispatchArchiveMail → Archiv-Ausgang), mit synthetischer PDF */
const submit = (pg, { typ = 'angebot', kennung = 'keinName', kunde = '', pdf = true, shop, uidMeta } = {}) => pg.evaluate(async o => {
  const T = window.__psArchivTest;
  const datum = PSArchivQueue.localDate();
  const name = T.name(o.typ, datum, o.kennung, o.shop);
  const betreff = T.betreff(o.typ, datum, window.__PS_PROFILE_NAME);
  const blob = o.pdf ? new Blob(['%PDF-1.4\n' + 'synthetisch '.repeat(80) + '\n%%EOF'], { type: 'application/pdf' }) : new Blob(['<html>kaputt</html>'], { type: 'text/html' });
  const r = await T.submit(blob, name, betreff, { kunde: o.kunde, ruf: o.typ === 'abschluss' ? o.kennung : '', ...(o.uidMeta ? { uid: o.uidMeta } : {}) });
  return { ...r, error: r && r.error ? String(r.error.message || r.error) : undefined, name };
}, { typ, kennung, kunde, pdf, shop, uidMeta });
const qAll = pg => pg.evaluate(async () => (await PSArchivQueue.queue('o2').all()).map(r => ({ id: r.archiveId, uid: r.uid, status: r.status, fileName: r.fileName, shopId: r.shopId, employeeName: r.employeeName, hasPdf: !!r.pdfBlob, sends: r.sends })));
const process = pg => pg.evaluate(async () => PSArchivQueue.queue('o2').process(window.__psArchivQueueDeps()));
const idxDocs = pg => pg.evaluate(() => { const d = firebase.__state().docs; return Object.keys(d).filter(k => k.includes('|pdf_index/')).map(k => ({ id: k.split('/').pop(), ...d[k] })); });
/** "Meine Archivierungen" (Statistik → Archiv) rendern und Zeilen lesen */
const view = pg => pg.evaluate(async () => {
  const div = document.createElement('div'); div.id = 'archiv-view-test'; document.body.appendChild(div);
  ReactDOM.render(React.createElement(ArchivProtokollView, null), div);
  for (let i = 0; i < 80; i++) { await new Promise(r => setTimeout(r, 100)); if (!/Lade Archiv-Protokoll/.test(div.textContent)) break; }
  div.querySelectorAll('button[aria-expanded="false"]').forEach(b => b.click());
  await new Promise(r => setTimeout(r, 150));
  const txt = div.textContent;
  ReactDOM.unmountComponentAtNode(div); div.remove();
  return txt;
});

test('Archivierung: Zuordnung, Bestätigung, Benutzerwechsel, Fehler und Wiederherstellung (synthetisch)', { timeout: 420000 }, async t => {
  if (!browser) return t.skip('kein Browser');
  const fl = flows();
  const ctx = await setup(fl);
  const pg = await page(ctx);

  await t.test('1+2: normale Archivierung → erst nach SharePoint-Fund "erfolgreich", sofort im Archiv sichtbar', async () => {
    await login(pg, 'uidA');
    fl.storeDelayMs = 1500; // Ablage-Kette braucht etwas
    const r = await submit(pg, { kennung: 'Mueller', kunde: 'Mueller' });
    assert.equal(r.ok, true); assert.equal(r.status, 'handed', 'übergeben, noch nicht bestätigt');
    assert.match(r.name, /^PENCIL_Mueller--\d{4}[0-9a-z]{3}_Aalen_Angebot_\d{4}-\d{2}-\d{2}\.pdf$/);
    let v = await view(pg);
    assert.match(v, /wird überprüft/, 'vor Fund in SharePoint kein "erfolgreich"');
    await pg.waitForTimeout(1700);
    await process(pg);
    const q = await qAll(pg);
    assert.equal(q[0].status, 'verified'); assert.equal(q[0].hasPdf, false, 'PDF nach Bestätigung gelöscht');
    v = await view(pg);
    assert.match(v, /Archivierung erfolgreich/); assert.match(v, /Mueller/);
    const d = await idxDocs(pg);
    assert.equal(d.length, 1); assert.equal(d[0].uid, 'uidA'); assert.equal(d[0].shopId, 'aalen');
    fl.storeDelayMs = 0;
  });

  await t.test('3: Abruf nach erneutem Login', async () => {
    await logout(pg); await login(pg, 'uidA');
    assert.match(await view(pg), /Archivierung erfolgreich[\s\S]*|Mueller/);
    assert.match(await view(pg), /Mueller/);
  });

  await t.test('4: zwei Mitarbeiter, gleiches Tablet, gleicher Kunde/Shop/Tag ("keinName") → getrennt, keine Überschreibung', async () => {
    const rA = await submit(pg, { kennung: 'keinName' });
    await logout(pg); await login(pg, 'uidB');
    const rB = await submit(pg, { kennung: 'keinName' });
    assert.notEqual(rA.name, rB.name, 'verschiedene Dateinamen');
    const d = await idxDocs(pg);
    const kn = d.filter(x => /^pencil_keinname/.test(x.id));
    assert.equal(kn.length, 2, 'zwei Index-Einträge statt Überschreiben');
    assert.deepEqual(kn.map(x => x.uid).sort(), ['uidA', 'uidB']);
    assert.equal(fl.stored.has(rA.name.toLowerCase()) && fl.stored.has(rB.name.toLowerCase()), true, 'beide PDFs in "SharePoint"');
    const vB = await view(pg);
    assert.ok(!/Mueller/.test(vB), 'B sieht A nicht');
    await logout(pg); await login(pg, 'uidA');
    const vA = await view(pg);
    assert.match(vA, /Mueller/);
    assert.equal((await qAll(pg)).filter(x => x.uid === 'uidA').length, 2);
  });

  await t.test('5: zwei Standorte → Dateiname/Index mit eigenem Standort', async () => {
    await logout(pg); await login(pg, 'uidC');
    const r = await submit(pg, { kennung: 'Schmidt', kunde: 'Schmidt' });
    assert.match(r.name, /_Crailsheim_Angebot_/);
    const doc = (await idxDocs(pg)).find(x => x.fileName === r.name);
    assert.equal(doc.shopId, 'crailsheim'); assert.equal(doc.uid, 'uidC');
    const pl = fl.payloads.find(p => p.archiveFileName === r.name);
    assert.equal(pl.shop, 'crailsheim'); assert.equal(pl.agent, 'Clara'); assert.equal(pl.key, 'hetec-ps-9f3k');
  });

  await t.test('6: Springer – Archivierung in Shop X bleibt nach Wechsel zu Shop Y sichtbar und bei Shop X', async () => {
    await logout(pg); await login(pg, 'uidS');
    const r1 = await submit(pg, { kennung: 'Weber', kunde: 'Weber' });
    assert.match(r1.name, /_Aalen_/);
    await pg.evaluate(() => { localStorage.setItem('ps_shop', 'crailsheim'); });
    await pg.reload(); await pg.waitForFunction(() => window.__PS_SHOP_ORT === 'crailsheim' && window.__psArchivTest, null, { timeout: 30000 });
    const v = await view(pg);
    assert.match(v, /Weber/, 'Archivierung aus dem anderen Shop weiterhin sichtbar');
    // Geparkter Vorgang (Nummer fehlte) aus Aalen, nachgetragen in Crailsheim → bleibt Aalen
    const ok = await pg.evaluate(async () => {
      await parkArchiveEntry({ id: 'park_spr', ts: Date.now(), type: 'abschluss', agent: 'Sven Springer', datum: PSArchivQueue.localDate(), kunde: 'Weber', dateiname: 'x.pdf', shopId: 'aalen', pdfBlob: new Blob(['%PDF-1.4\n' + 'y'.repeat(900) + '\n%%EOF'], { type: 'application/pdf' }) });
      const e = (await listParkedArchiveForUser()).find(x => x.id === 'park_spr');
      return window.__psArchivTest.resume(e, '0176 1234567');
    });
    assert.equal(ok, true);
    const p = fl.payloads[fl.payloads.length - 1];
    assert.match(p.archiveFileName, /^PENCIL_01761234567--[0-9a-z]{7}_Aalen_Abschluss_/);
  });

  await t.test('7+19: Admin – eigene Ansicht nur eigene, Diagnose liest alle; Mitarbeiteransicht zeigt nie fremde', async () => {
    await logout(pg); await login(pg, 'uidAdm');
    const v = await view(pg);
    assert.ok(!/Mueller|Schmidt|Weber/.test(v), '„Meine Archivierungen“ des Admins enthält keine fremden');
    const a = await pg.evaluate(async () => { const items = await PSBackend.pdfIndex.recent(Date.now() - 86400000, 5000); return { n: items.length, an: psArchDiagAnalyze(items, { shopIds: Object.keys(SHOPS) }) }; });
    assert.ok(a.n >= 5); assert.equal(a.an.noUid.length, 0); assert.equal(a.an.legacyName.length, 0);
    // Diagnose-Oberfläche öffnen (nur Admin)
    await pg.evaluate(() => { const d = document.createElement('div'); d.id = 'diag'; document.body.appendChild(d); ReactDOM.render(React.createElement(PsArchivDiagnose, { onClose: () => {} }), d); });
    await pg.click('text=Suchindex analysieren');
    await pg.waitForSelector('text=Alte Dateinamen ohne Kennzeichen', { timeout: 10000 });
    await pg.click('text=Mit SharePoint abgleichen');
    await pg.waitForSelector('text=PDF in SharePoint nicht gefunden', { timeout: 15000 });
    await pg.evaluate(() => { ReactDOM.unmountComponentAtNode(document.getElementById('diag')); });
  });

  await t.test('8: Benutzerwechsel während ausstehender Archivierung → bleibt bei A, B sieht nichts', async () => {
    await logout(pg); await login(pg, 'uidA');
    fl.archiveDown = true;
    const r = await submit(pg, { kennung: 'Offline-Kunde', kunde: 'Offline Kunde' });
    assert.equal(r.ok, true); assert.equal(r.status, 'pending');
    await logout(pg);
    fl.archiveDown = false;
    await login(pg, 'uidB');
    const toasts = [];
    await pg.exposeFunction('__toastSpy', s => toasts.push(s)).catch(() => {});
    await pg.evaluate(async () => { const q = PSArchivQueue.queue('o2'); for (const r of await q.all()) if (r.status === 'pending') await q.update(r.archiveId, { lastTryAt: 0 }); });
    await process(pg);
    const rec = (await qAll(pg)).find(x => x.fileName === r.name);
    assert.equal(rec.uid, 'uidA'); assert.equal(rec.employeeName, 'Anna Archiv');
    assert.ok(['handed', 'verified'].includes(rec.status), 'unter B übergeben, nicht verloren: ' + rec.status);
    const pl = fl.payloads.find(p => p.archiveFileName === r.name);
    assert.equal(pl.agent, 'Anna', 'Betreff/Agent bleibt A');
    assert.equal((await idxDocs(pg)).find(x => x.fileName === r.name), undefined, 'kein Index-Eintrag unter B');
    assert.ok(!/Offline Kunde/.test(await view(pg)), 'B sieht A nicht');
    // A meldet sich wieder an → Index-Eintrag mit uid A, A sieht die Archivierung
    await logout(pg); await login(pg, 'uidA');
    await process(pg);
    const doc = (await idxDocs(pg)).find(x => x.fileName === r.name);
    assert.equal(doc && doc.uid, 'uidA', 'Index-Eintrag gehört A');
    assert.match(await view(pg), /Offline Kunde/);
    await logout(pg); await login(pg, 'uidB');
  });

  await t.test('9: Doppelklick → ein Eintrag, ein Versand', async () => {
    const before = fl.payloads.length;
    const rs = await pg.evaluate(async () => {
      const T = window.__psArchivTest; const datum = PSArchivQueue.localDate();
      const name = T.name('angebot', datum, 'Doppel'); const betreff = T.betreff('angebot', datum, window.__PS_PROFILE_NAME);
      const blob = new Blob(['%PDF-1.4\n' + 'z'.repeat(900) + '\n%%EOF'], { type: 'application/pdf' });
      const [a, b] = await Promise.all([T.submit(blob, name, betreff, {}), T.submit(blob, name, betreff, {})]);
      return [a.ok, b.ok, a.archiveId === b.archiveId];
    });
    assert.deepEqual(rs, [true, true, true]);
    assert.equal(fl.payloads.length - before, 1);
  });

  await t.test('10: mehrere Beratungen gleichzeitig → alle getrennt archiviert', async () => {
    const names = await pg.evaluate(async () => {
      const T = window.__psArchivTest; const datum = PSArchivQueue.localDate();
      const blob = () => new Blob(['%PDF-1.4\n' + 'p'.repeat(900) + '\n%%EOF'], { type: 'application/pdf' });
      const jobs = ['Eins', 'Zwei', 'Drei'].map(k => T.submit(blob(), T.name('angebot', datum, k), T.betreff('angebot', datum, window.__PS_PROFILE_NAME), { kunde: k }));
      return (await Promise.all(jobs)).map(r => r.ok && r.status);
    });
    assert.deepEqual(names, ['handed', 'handed', 'handed']);
  });

  await t.test('11+20: Netzunterbrechung → ausstehend → Wiederherstellung → übergeben → bestätigt', async () => {
    fl.archiveDown = true;
    const r = await submit(pg, { kennung: 'Netz', kunde: 'Netz' });
    assert.equal(r.status, 'pending');
    assert.match(await view(pg), /Archivierung ausstehend/);
    fl.archiveDown = false;
    await pg.evaluate(async id => PSArchivQueue.queue('o2').update(id, { lastTryAt: 0 }), r.archiveId);
    await process(pg);
    await process(pg);
    const rec = (await qAll(pg)).find(x => x.id === r.archiveId);
    assert.equal(rec.status, 'verified');
  });

  await t.test('12: fehlerhafte Antwort des Prüfdienstes → bleibt "wird überprüft", kein Schein-Erfolg', async () => {
    fl.v3Broken = true;
    const r = await submit(pg, { kennung: 'Pruef', kunde: 'Pruef' });
    await process(pg);
    const rec = (await qAll(pg)).find(x => x.id === r.archiveId);
    assert.equal(rec.status, 'handed');
    const v = await view(pg);
    assert.ok(/wird überprüft|übergeben/i.test(v));
    fl.v3Broken = false;
    await pg.evaluate(async id => PSArchivQueue.queue('o2').update(id, { lastVerifyAt: 0 }), r.archiveId);
    await process(pg);
    assert.equal((await qAll(pg)).find(x => x.id === r.archiveId).status, 'verified');
  });

  await t.test('13: verzögerte Ablage → erst übergeben, später bestätigt', async () => {
    fl.storeDelayMs = 2500;
    const r = await submit(pg, { kennung: 'Spaet', kunde: 'Spaet' });
    const now1 = await pg.evaluate(async id => (await PSArchivQueue.queue('o2').verifyNow(id, window.__psArchivQueueDeps())).status, r.archiveId);
    assert.equal(now1, 'handed');
    await pg.waitForTimeout(2700);
    const now2 = await pg.evaluate(async id => (await PSArchivQueue.queue('o2').verifyNow(id, window.__psArchivQueueDeps())).status, r.archiveId);
    assert.equal(now2, 'verified');
    fl.storeDelayMs = 0;
  });

  await t.test('14: fehlerhafte PDF → kein Versand, keine Erfolgsmeldung, Vorgang bleibt offen', async () => {
    const before = fl.payloads.length;
    const r = await submit(pg, { kennung: 'Kaputt', pdf: false });
    assert.equal(r.ok, false);
    assert.equal(fl.payloads.length, before);
  });

  await t.test('15+18: Browser-Neustart / Neuladen (z. B. nach Update) → ausstehende Archivierung wird nachgesendet', async () => {
    fl.archiveDown = true;
    const r = await submit(pg, { kennung: 'Neustart', kunde: 'Neustart' });
    assert.equal(r.status, 'pending');
    await pg.close();
    fl.archiveDown = false;
    const pg2 = await page(ctx);
    await pg2.goto(srv.url + '/index.html');
    await pg2.waitForFunction(() => window.__PS_USER_UID === 'uidB' && window.__psArchivQueueDeps, null, { timeout: 40000 });
    await pg2.evaluate(async id => PSArchivQueue.queue('o2').update(id, { lastTryAt: 0 }), r.archiveId);
    await process(pg2);
    const rec = (await qAll(pg2)).find(x => x.id === r.archiveId);
    assert.ok(['handed', 'verified'].includes(rec.status));
    assert.ok(fl.payloads.some(p => p.archiveFileName === r.name));
    t.pg2 = pg2;
  });

  const pg2 = t.pg2 || (await ctx.pages())[0];

  await t.test('17: alte Archivierungen (alter Dateiname, alte Feldtypen) bleiben sichtbar', async () => {
    await pg2.evaluate(async () => {
      await PSBackend.pdfIndex.write('pencil_altkunde_aalen_angebot_2026-11-20.pdf', { fileName: 'PENCIL_Altkunde_Aalen_Angebot_2026-11-20.pdf', typ: 'angebot', shopId: 'aalen', kunde: 'Altkunde', uid: 'uidB', src: 'app', ts: String(Date.now() - 5 * 86400000), datum: '2026-11-20', v: 1 });
    });
    assert.match(await view(pg2), /Altkunde/);
  });

  await t.test('21: mehr als 300 Einträge eines Mitarbeiters → neueste bleiben sichtbar', async () => {
    const res = await pg2.evaluate(async () => {
      for (let i = 0; i < 305; i++) await PSBackend.pdfIndex.write('pencil_a' + String(i).padStart(4, '0'), { fileName: 'PENCIL_a' + i + '_Aalen_Angebot_2025-01-01.pdf', uid: 'uidB', src: 'app', ts: 1000 + i });
      await PSBackend.pdfIndex.write('pencil_zz-neu_aalen_angebot_x.pdf', { fileName: 'PENCIL_Zz-Neu_Aalen_Angebot_2026-11-27.pdf', uid: 'uidB', src: 'app', ts: Date.now() });
      return (await PSBackend.pdfIndex.mine('uidB', [''], Date.now() - 86400000))[0].items.map(x => x.fileName);
    });
    assert.ok(res.includes('PENCIL_Zz-Neu_Aalen_Angebot_2026-11-27.pdf'));
    assert.ok(res.length < 50, 'Zeitfilter greift');
  });

  await t.test('Geparkt: nichts wird nach 24 h gelöscht, fremde geparkte Vorgänge sind unsichtbar', async () => {
    const r = await pg2.evaluate(async () => {
      const blob = new Blob(['%PDF-1.4\n' + 'q'.repeat(900) + '\n%%EOF'], { type: 'application/pdf' });
      await parkArchiveEntry({ id: 'park_alt_b', uid: 'uidB', ts: Date.now() - 30 * 3600e3, type: 'abschluss', agent: 'Bernd', datum: '2026-11-26', dateiname: 'x.pdf', pdfBlob: blob });
      await parkArchiveEntry({ id: 'park_fremd_a', uid: 'uidA', ts: Date.now(), type: 'abschluss', agent: 'Anna', datum: '2026-11-27', dateiname: 'y.pdf', pdfBlob: blob });
      const all = (await listParkedArchive()).map(x => x.id);
      const own = (await listParkedArchiveForUser()).map(x => x.id + ':' + x.overdue);
      return { all, own };
    });
    assert.ok(r.all.includes('park_alt_b') && r.all.includes('park_fremd_a'), 'nichts gelöscht');
    assert.ok(r.own.includes('park_alt_b:true'), 'überfällig markiert');
    assert.ok(!r.own.some(x => x.startsWith('park_fremd_a')), 'fremd unsichtbar');
  });

  await t.test('Versandbereite geparkte Vorgänge (Altbestand) → beim Start mit Original-Eigentümer übernommen', async () => {
    const r = await pg2.evaluate(async () => {
      await parkArchiveEntry({ id: 'park_ready_a', uid: 'uidA', shopId: 'aalen', ts: Date.now() - 3600e3, type: 'angebot', agent: 'Anna Archiv', datum: PSArchivQueue.localDate(), kunde: 'Altpark', dateiname: 'PENCIL_Altpark_Aalen_Angebot_' + PSArchivQueue.localDate() + '.pdf', betreff: 'PENCIL|angebot|' + PSArchivQueue.localDate() + '|Anna', readyToAutoSend: true, pdfBlob: new Blob(['%PDF-1.4\n' + 'r'.repeat(900) + '\n%%EOF'], { type: 'application/pdf' }) });
      await window.__psArchivTest.autoFlush();
      const left = (await listParkedArchive()).some(x => x.id === 'park_ready_a');
      const rec = (await PSArchivQueue.queue('o2').all()).find(x => /^PENCIL_Altpark--/.test(x.fileName));
      return { left, uid: rec && rec.uid, status: rec && rec.status, name: rec && rec.fileName };
    });
    assert.equal(r.left, false); assert.equal(r.uid, 'uidA'); assert.ok(['handed', 'verified'].includes(r.status));
    assert.equal((await idxDocs(pg2)).find(x => x.fileName === r.name), undefined, 'Index erst unter der Anmeldung von A');
  });

  await t.test('20b: fehlgeschlagene Archivierung → Knopf "Erneut senden" in Meine Archivierungen', async () => {
    const id = await pg2.evaluate(async () => {
      const T = window.__psArchivTest; const datum = PSArchivQueue.localDate();
      const r = await T.submit(new Blob(['%PDF-1.4\n' + 'f'.repeat(900) + '\n%%EOF'], { type: 'application/pdf' }), T.name('angebot', datum, 'Fehlgeschlagen'), T.betreff('angebot', datum, window.__PS_PROFILE_NAME), { kunde: 'Fehlgeschlagen' });
      await PSArchivQueue.queue('o2').update(r.archiveId, { status: 'failed', sends: 3 });
      return r.archiveId;
    });
    await pg2.evaluate(() => { const d = document.createElement('div'); d.id = 'av2'; document.body.appendChild(d); ReactDOM.render(React.createElement(ArchivProtokollView, null), d); });
    await pg2.waitForSelector('#av2 >> text=Meine Archivierungen', { timeout: 10000 });
    await pg2.waitForFunction(() => !/Lade Archiv-Protokoll/.test(document.getElementById('av2').textContent));
    await pg2.evaluate(() => document.querySelectorAll('#av2 button[aria-expanded="false"]').forEach(b => b.click()));
    await pg2.click('#av2 >> text=Erneut senden');
    await pg2.waitForFunction(async i => ['handed', 'verified'].includes((await PSArchivQueue.queue('o2').get(i)).status), id, { timeout: 10000 });
  });

  assert.deepEqual((pg2.errs || []), [], 'Skriptfehler');
  await ctx.close();
});

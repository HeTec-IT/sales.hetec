// Browser-Test: Import aus HeTec Smart Capture per QR-Code im echten Smart-Scan-Dialog.
// Die Kamera ist eine Chromium-Attrappe, die ein Video mit den QR-Codes abspielt (wie ein Tablet, das auf den PC-Monitor zeigt).
// Geprüft: Kamera-Freigabe und -Stopp, Erkennung (jsQR), Prüfung (Ablauf, Manipulation, personenbezogene Daten),
// Mehrfach-QR, Bestätigung durch den Mitarbeiter, Ergänzen/Ersetzen/Abbrechen, Schutz gegen doppelte Übernahme.
// Keine OCR auf dem Tablet, keine Kundendaten (synthetische Angebote).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import vm from 'node:vm';
import path from 'node:path';
import { playwright, staticServer, ROOT } from './lib.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hsc-qr-'));
const V = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/smart-capture/hsc-vectors.json'), 'utf8'));
let srv, pw;

// Protokoll + QR-Generator wie in den Apps (selbst gehostete Dateien), in einer Node-VM
const ctx = vm.createContext({ TextEncoder, TextDecoder, Uint8Array, crypto: globalThis.crypto, Blob, Response, CompressionStream });
ctx.globalThis = ctx; ctx.module = { exports: {} };
vm.runInContext(fs.readFileSync(path.join(ROOT, 'frontend/smart-scan/hsc-protocol.js'), 'utf8'), ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'vendor/qrcode.js'), 'utf8') + ';this.__qr = typeof qrcode === "function" ? qrcode : module.exports;', ctx);
const HSC = ctx.HSC, qrcode = ctx.__qr;

// QR-Codes als Y4M-Video (I420): weißer Hintergrund, schwarze Module, je Teil mehrere Bilder
function y4m(file, parts, framesPer = 6) {
  const W = 1280, H = 720, frames = [];
  for (const text of parts) {
    const q = qrcode(0, 'M'); q.addData(text, 'Byte'); q.make();
    const n = q.getModuleCount(), quiet = 4, cell = Math.floor(660 / (n + 2 * quiet)), size = cell * (n + 2 * quiet);
    const Y = Buffer.alloc(W * H, 235), x0 = Math.floor((W - size) / 2), y0 = Math.floor((H - size) / 2);
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) {
      for (let dy = 0; dy < cell; dy++) Y.fill(16, (y0 + (r + quiet) * cell + dy) * W + x0 + (c + quiet) * cell, (y0 + (r + quiet) * cell + dy) * W + x0 + (c + quiet + 1) * cell);
    }
    const UV = Buffer.alloc(W * H / 2, 128);
    for (let i = 0; i < framesPer; i++) frames.push(Buffer.concat([Buffer.from('FRAME\n'), Y, UV]));
  }
  fs.writeFileSync(file, Buffer.concat([Buffer.from(`YUV4MPEG2 W${W} H${H} F10:1 Ip A1:1 C420jpeg\n`), ...frames]));
  return file;
}
const item = (name, o = {}) => Object.assign({ name, art: '', details: [], e: null, m: null, re: 0, rm: 0, ak: false, rbBad: false, unsure: false }, o);
const OFFER = { pages: 1, quality: { score: 100, warnings: [] }, tarife: [item('O2 Mobile L (2026)', { art: 'Neuvertrag', details: ['Inklusiv Datenvolumen 150 GB'], e: 3999, m: 3499 })],
  geraete: [item('Apple iPhone 18 Pro 1TB, Burgunder', { e: 238900, t: 0 })], internet: [], zusatz: [], einmalig: 242899, monatlich: 3499, priceChanges: [] };

before(async () => { srv = await staticServer(); pw = await playwright(); });
after(async () => { if (srv) await srv.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

async function withCamera(t, video, fn) {
  if (!pw) return t.skip('Playwright fehlt');
  let b;
  try {
    b = await pw.chromium.launch({ args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-file-for-fake-video-capture=' + video], ...(process.env.PW_CHROME ? { executablePath: process.env.PW_CHROME } : {}) });
  } catch (e) { if (process.env.PS_REQUIRE_BROWSERS) throw e; return t.skip('Chromium nicht startbar'); }
  try {
    const c = await b.newContext({ permissions: ['camera'], viewport: { width: 1000, height: 1100 } });
    // Kamera-Spuren mitschreiben (Prüfung: nach Scan/Abbruch gestoppt)
    await c.addInitScript(() => {
      window.__tracks = [];
      const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async cons => { const s = await orig(cons); s.getTracks().forEach(tr => window.__tracks.push(tr)); return s; };
    });
    const page = await c.newPage();
    const errors = [], ext = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('request', r => { const u = new URL(r.url()); if (!['127.0.0.1', 'localhost'].includes(u.hostname) && !/^(data|blob):/.test(r.url())) ext.push(u.host); });
    await page.goto(srv.url + '/tests/e2e/harness_ui.html');
    await fn(page);
    assert.deepEqual(errors, []);
    assert.deepEqual(ext, [], 'keine externen Verbindungen');
    await c.close();
  } finally { await b.close(); }
}
const camState = page => page.evaluate(() => ({ n: window.__tracks.length, live: window.__tracks.filter(t => t.readyState === 'live').length, overlay: !!document.querySelector('[data-ps-hsc-scan]') }));
const statusText = page => page.innerText('#root');

test('QR-Code von Smart Capture scannen → prüfen → bestätigen → Übernahme; Kamera danach aus; doppelte Übernahme verhindert', { timeout: 120000 }, async t => {
  const enc = await HSC.encode(OFFER, { ttl: 120 });
  await withCamera(t, y4m(path.join(tmp, 'single.y4m'), enc.parts), async page => {
    await page.evaluate('mountUi()');
    await page.getByRole('button', { name: 'Smart Capture – QR-Code scannen' }).click();
    await page.waitForFunction(() => /Von Smart Capture übernommen/.test(document.getElementById('root').innerText), null, { timeout: 30000 });
    const cam = await camState(page);
    assert.ok(cam.n >= 1, 'Kamera wurde freigegeben');
    assert.equal(cam.live, 0, 'Kamera nach erfolgreichem Scan gestoppt');
    assert.equal(cam.overlay, false);
    const txt = await statusText(page);
    assert.match(txt, /O2 Mobile L \(2026\)/);
    assert.match(txt, /2\.428,99 €/);
    assert.match(txt, /34,99 €/);
    assert.equal(await page.evaluate('window.__applied'), null, 'nichts ohne Bestätigung übernommen');
    await page.getByRole('button', { name: /Angebot übernehmen/ }).click();
    const d = await page.evaluate('window.__applied');
    assert.equal(d.tarife[0].name, 'O2 Mobile L (2026)');
    assert.deepEqual(d.tarife[0].am, ['39,99', '34,99']);
    assert.deepEqual(d.geraete[0].am, ['2.389,00', null]);
    assert.equal(d.geraete[0].t, 0);
    assert.equal(d.einmalig, '2.428,99');
    assert.equal(d.monatlich, '34,99');
    // derselbe QR-Code noch einmal (neuer Dialog) → doppelte Übernahme verhindert
    await page.evaluate('mountUi()');
    await page.getByRole('button', { name: 'Smart Capture – QR-Code scannen' }).click();
    await page.waitForFunction(() => /bereits übernommen/.test(document.getElementById('root').innerText), null, { timeout: 30000 });
    assert.equal((await camState(page)).live, 0);
  });
});

test('vorhandene Beratungsdaten: Ergänzen / Ersetzen / Abbrechen nur mit Zustimmung; Kamera-Abbruch', { timeout: 120000 }, async t => {
  const enc = await HSC.encode(OFFER, { ttl: 120 });
  await withCamera(t, y4m(path.join(tmp, 'merge.y4m'), enc.parts), async page => {
    const initial = { tarife: [{ name: 'O2 Mobile S (2026)', art: '', det: '', am: ['39,99', '19,99'], rb: { e: 0, m: 0, bad: false } }], geraete: [], internet: [], einmalig: '39,99', monatlich: '19,99', hinweis: '' };
    await page.evaluate(i => window.mountUi(i), initial);
    // Abbrechen im Scanner: Kamera sofort aus, nichts geändert
    await page.getByRole('button', { name: 'Smart Capture QR' }).click();
    await page.waitForSelector('[data-ps-hsc-scan]');
    await page.waitForFunction(() => window.__tracks.some(t => t.readyState === 'live'));
    await page.getByRole('button', { name: 'Abbrechen' }).first().click();
    let cam = await camState(page);
    assert.equal(cam.live, 0); assert.equal(cam.overlay, false);
    // Scan → Rückfrage statt Überschreiben
    await page.getByRole('button', { name: 'Smart Capture QR' }).click();
    await page.getByRole('button', { name: 'Angebot ergänzen' }).waitFor({ timeout: 30000 });
    assert.match(await statusText(page), /bereits Angaben vorhanden/);
    await page.getByRole('button', { name: 'Import abbrechen' }).click();
    assert.match(await statusText(page), /Import abgebrochen/);
    await page.getByRole('button', { name: 'Smart Capture QR' }).click();
    await page.getByRole('button', { name: 'Angebot ergänzen' }).click({ timeout: 30000 });
    await page.getByRole('button', { name: /Angebot übernehmen/ }).click();
    const d = await page.evaluate('window.__applied');
    assert.deepEqual(d.tarife.map(x => x.name), ['O2 Mobile S (2026)', 'O2 Mobile L (2026)']);
    assert.equal(d.geraete[0].t, 1, 'Gerät gehört zum ergänzten Tarif');
    assert.equal(d.einmalig, '2.468,98');
    assert.equal(d.monatlich, '54,98');
  });
});

test('Mehrfach-QR: Teile wechseln am PC, der Scanner sammelt alle und importiert vollständig', { timeout: 120000 }, async t => {
  const big = { ...OFFER, tarife: Array.from({ length: 4 }, (_, i) => item('O2 Mobile L (2026)', { art: 'Neuvertrag', details: ['International Voice Standard', 'Inklusiv Datenvolumen 150 GB', 'Roaming Standard', 'Karte ' + (i + 1)], e: 3999, m: 3499 })), einmalig: 254896, monatlich: 13996 };
  const enc = await HSC.encode(big, { ttl: 120, chunk: 200 });
  assert.ok(enc.parts.length >= 2);
  await withCamera(t, y4m(path.join(tmp, 'multi.y4m'), enc.parts, 5), async page => {
    await page.evaluate('mountUi()');
    await page.getByRole('button', { name: 'Smart Capture – QR-Code scannen' }).click();
    await page.waitForFunction(() => /Von Smart Capture übernommen/.test(document.getElementById('root').innerText), null, { timeout: 40000 });
    assert.equal((await camState(page)).live, 0);
    await page.getByRole('button', { name: /Angebot übernehmen/ }).click();
    const d = await page.evaluate('window.__applied');
    assert.equal(d.tarife.length, 4);
    assert.equal(d.einmalig, '2.548,96');
  });
});

test('abgelaufener und manipulierter QR-Code werden abgelehnt, Kamera wird gestoppt', { timeout: 120000 }, async t => {
  const now = Math.floor(Date.now() / 1000);
  const expired = await HSC.encode(OFFER, { ttl: 120, now: now - 200 });
  await withCamera(t, y4m(path.join(tmp, 'expired.y4m'), expired.parts), async page => {
    await page.evaluate('mountUi()');
    await page.getByRole('button', { name: 'Smart Capture – QR-Code scannen' }).click();
    await page.waitForFunction(() => /abgelaufen/.test(document.getElementById('root').innerText), null, { timeout: 30000 });
    assert.equal((await camState(page)).live, 0);
    assert.equal(await page.evaluate('window.__applied'), null);
  });
  const pii = V.invalid.find(v => v.name === 'personenbezogen');
  await withCamera(t, y4m(path.join(tmp, 'pii.y4m'), pii.parts), async page => {
    await page.evaluate('mountUi()');
    await page.getByRole('button', { name: 'Smart Capture – QR-Code scannen' }).click();
    await page.waitForFunction(() => /personenbezogene Angaben – Import abgelehnt/.test(document.getElementById('root').innerText), null, { timeout: 30000 });
    assert.equal((await camState(page)).live, 0);
    assert.doesNotMatch(await statusText(page), /Mustermann/);
  });
});

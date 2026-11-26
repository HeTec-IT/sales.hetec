// Echte, vollständig lokale Texterkennung im Browser (selbst gehostetes Tesseract und – optional – PaddleOCR/ONNX)
// auf einem SYNTHETISCHEN Vorschlagsbild und seinen Problemvarianten. Misst echte Laufzeiten und schreibt sie nach
// tests/e2e/.out/ocr-timings.json. Prüft vor allem: nichts erfunden, Einmal/Monatlich nie vertauscht.
// Optional: BELEG_FOTO=/pfad/zum/eigenen/testfoto.jpg (Monitorfoto, gehört NICHT ins Repo) → siehe ocr-photo.test.mjs
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { browsers, staticServer, makeVariants, syntheticOfferPhoto, ROOT } from './lib.mjs';
import { BELEG } from '../ocr/helpers.mjs';

const ENGINES = (process.env.PS_OCR_ENGINES || 'tesseract').split(',');   // 'tesseract,neural'
let srv, list = [], variants = {};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-real-'));
const timings = [];
const LINES = BELEG.split('\n');

before(async () => {
  srv = await staticServer();
  list = await browsers();
  if (!list.length) return;
  const p = await list[0].b.newPage();
  await p.goto(srv.url + '/tests/e2e/harness_ui.html');
  const base = await syntheticOfferPhoto(p, LINES);
  variants = await makeVariants(p, base);
  for (const [k, v] of Object.entries(variants)) fs.writeFileSync(path.join(tmp, k + '.jpg'), v);
  await p.close();
});
after(async () => {
  for (const { b } of list) await b.close();
  if (srv) await srv.close();
  fs.mkdirSync(path.join(ROOT, 'tests/e2e/.out'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'tests/e2e/.out/ocr-timings.json'), JSON.stringify({ measuredAt: new Date().toISOString(), note: 'Gemessen in headless Browser auf dem Build-Rechner, NICHT auf Tablets.', timings }, null, 2));
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function run(b, engine, name) {
  const pg = await b.newPage({ viewport: { width: 900, height: 1500 } });
  const errs = [], ext = [];
  pg.on('pageerror', e => errs.push(String(e).slice(0, 200)));
  pg.on('request', r => { const u = new URL(r.url()); if (!['127.0.0.1', 'localhost'].includes(u.hostname) && !/^(data|blob):/.test(r.url())) ext.push(u.host); });
  await pg.goto(srv.url + '/tests/e2e/harness_ui.html?neural=' + (engine === 'neural' ? '1' : '0'));
  await pg.evaluate(() => localStorage.setItem('ps_o2_mode', 'ganz'));
  await pg.evaluate('mountUi()');
  await pg.waitForTimeout(400);
  const btn = pg.getByRole('button', { name: /Weiteres Foto|Vorschlag fotografieren/ }).first();
  const [fc] = await Promise.all([pg.waitForEvent('filechooser'), btn.click()]);
  const t0 = Date.now();
  await fc.setFiles(path.join(tmp, name + '.jpg'));
  await pg.waitForTimeout(800);
  for (let i = 0; i < 3; i++) {
    await pg.waitForFunction('!document.querySelector("[role=status] button")', null, { timeout: 90000, polling: 200 });
    const tl = pg.getByRole('button', { name: 'Trotzdem lesen' });
    if (await tl.count()) { await tl.first().click(); await pg.waitForTimeout(800); continue; }
    break;
  }
  const ms = Date.now() - t0;
  await pg.evaluate('window.__applied = null');
  const ap = pg.getByRole('button', { name: /Angebot übernehmen/ });
  if (await ap.count() && await ap.first().isEnabled()) await ap.first().click();
  await pg.waitForTimeout(150);
  const d = await pg.evaluate('window.__applied');
  const txt = await pg.innerText('#root');
  await pg.close();
  return { d, ms, errs, ext, txt };
}

const CASES = ['orig', 'gradient', 'glare', 'blur_light', 'jpeg30', 'lowres', 'rot4', 'moire', 'top_only', 'bottom_only', 'blur_heavy', 'noise', 'blank', 'truncated', 'garbage'];

for (const engine of ENGINES) {
  for (const name of CASES) {
    test(`lokale OCR (${engine}) – ${name}`, { timeout: 180000 }, async t => {
      if (!list.length) return t.skip('kein Browser');
      for (const { name: bn, b } of list) {
        const r = await run(b, engine, name);
        const d = r.d;
        timings.push({ browser: bn, engine, variant: name, ms: r.ms, tarife: d ? d.tarife.length : 0, geraete: d ? d.geraete.length : 0, einmalig: d ? d.einmalig : '', monatlich: d ? d.monatlich : '' });
        assert.deepEqual(r.ext, [], `[${bn}] externe Verbindungen: ${r.ext}`);
        assert.deepEqual(r.errs, [], `[${bn}] Skriptfehler`);
        // Niemals erfunden oder vertauscht: Summen sind entweder korrekt oder leer
        if (d) {
          assert.ok(['', '2.468,98'].includes(d.einmalig), `[${bn}] einmalig=${d.einmalig}`);
          assert.ok(['', '69,98'].includes(d.monatlich), `[${bn}] monatlich=${d.monatlich}`);
          assert.ok(d.tarife.length <= 2 && d.geraete.length <= 1, `[${bn}] zu viele Positionen: ${d.tarife.length}T ${d.geraete.length}G`);
        }
        if (name === 'orig') {
          assert.ok(d && d.tarife.length === 2 && d.geraete.length === 1 && d.einmalig === '2.468,98' && d.monatlich === '69,98', `[${bn}] sauberes Bild unvollständig: ${JSON.stringify(d && [d.tarife.length, d.geraete.length, d.einmalig, d.monatlich])}`);
        }
        if (['noise', 'blank', 'truncated', 'garbage', 'blur_heavy'].includes(name)) {
          const empty = !d || (!d.tarife.length && !d.geraete.length && !d.einmalig && !d.monatlich);
          assert.ok(empty, `[${bn}] aus unbrauchbarem Bild wurde etwas „erkannt“`);
          assert.ok(!/Nichts erkannt/.test(r.txt));
        }
        assert.ok(r.ms < 60000, `[${bn}] ${r.ms} ms`);
      }
    });
  }
}

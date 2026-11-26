// Browser-Test des echten Smart-Scan-Dialogs (frontend/smart-scan/ui-dialog.js) mit lokaler Texterkennung.
// Ersetzt tests/e2e/ui_cloud.py: dieselben Abläufe, aber ohne Cloud-Dienst – die Attrappe ersetzt nur Tesseract
// (liefert die Texte der Belege A/B), alles andere ist der echte Code: Parser, Zusammenführen, Summenschutz,
// Abbruch, Zeitlimit, Rückfragen. Kein Foto und keine Kundendaten nötig.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { browsers, staticServer, dummyPhoto } from './lib.mjs';
import { BELEG, BELEG_B } from '../ocr/helpers.mjs';

let srv, list = [], photo1, photo2;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-dialog-'));
before(async () => {
  srv = await staticServer();
  list = await browsers();
  if (list.length) {
    const p = await list[0].b.newPage();
    await p.goto(srv.url + '/tests/e2e/harness_ui.html?fake=1');
    photo1 = path.join(tmp, 'dummy1.jpg'); fs.writeFileSync(photo1, await dummyPhoto(p, 3));
    photo2 = path.join(tmp, 'dummy2.jpg'); fs.writeFileSync(photo2, await dummyPhoto(p, 7));
    await p.close();
  }
});
after(async () => { for (const { b } of list) await b.close(); if (srv) await srv.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const PARTIAL = BELEG.split('\n').filter(l => !/Kosten|^HANDY$|2\.389,00|iPhone/.test(l)).join('\n');
// Abweichung in mehreren Stellen (echte andere Summe) → Konflikt-Hinweis; Abweichung in genau einer Ziffer → Lesefehler (siehe unten)
const A_BAD = BELEG.replace('Monatliche Kosten 69,98 €', 'Monatliche Kosten 84,98 €');
const A_SLIP = BELEG.replace('Monatliche Kosten 69,98 €', 'Monatliche Kosten 69,93 €');

async function newPage(b) {
  const pg = await b.newPage({ viewport: { width: 900, height: 1500 } });
  pg.errs = [];
  pg.on('pageerror', e => pg.errs.push(String(e).slice(0, 200)));
  await pg.goto(srv.url + '/tests/e2e/harness_ui.html?fake=1&neural=0');
  await pg.waitForFunction('window.__ready === true');
  await pg.evaluate(() => { localStorage.setItem('ps_o2_mode', 'ganz'); localStorage.removeItem('ps_o2_owncam2'); });
  await pg.evaluate('mountUi()');
  await pg.waitForTimeout(400);
  return pg;
}
async function ocr(pg, text, extra = {}) { await pg.evaluate(o => Object.assign(window.__ocr, { delay: 0, hang: false }, o), { text, ...extra }); }
async function settle(pg) {
  await pg.waitForTimeout(700);
  // fertig, sobald die Fortschrittsanzeige (Status mit Abbrechen-Knopf) verschwunden ist
  await pg.waitForFunction('!document.querySelector("[role=status] button")', null, { timeout: 60000, polling: 150 });
  await pg.waitForTimeout(250);
}
async function shoot(pg, file = photo1, wait = true) {
  const btn = pg.getByRole('button', { name: /Weiteres Foto|Vorschlag fotografieren/ }).first();
  const [fc] = await Promise.all([pg.waitForEvent('filechooser'), btn.click()]);
  await fc.setFiles(file);
  if (wait) await settle(pg);
}
async function state(pg) {
  await pg.evaluate('window.__applied = null');
  const btn = pg.getByRole('button', { name: /Angebot übernehmen/ });
  if (await btn.count() && await btn.first().isEnabled()) { await btn.first().click(); await pg.waitForTimeout(150); }
  return pg.evaluate('window.__applied');
}
const text = pg => pg.innerText('#root');
const cnt = d => d ? [d.tarife.length, d.geraete.length, d.internet.length, d.einmalig, d.monatlich] : null;

const scenarios = [
  ['Angebot A: Handy + 2 gleiche Tarife (getrennt) + 2.468,98 / 69,98, "Summen stimmen", < 5 s', async pg => {
    await ocr(pg, BELEG); const t0 = Date.now(); await shoot(pg); const d = await state(pg); const t = await text(pg);
    assert.deepEqual(cnt(d), [2, 1, 0, '2.468,98', '69,98']);
    assert.equal(d.tarife[0].name, d.tarife[1].name);
    assert.ok(/Summen stimmen/.test(t), t.slice(-300));
    assert.ok(Date.now() - t0 < 5000, (Date.now() - t0) + ' ms');
    assert.deepEqual(pg.errs, []);
  }],
  ['Angebot B: Internet + Handy + Tarif, Rabatte nachvollzogen, keine Abweichungsmeldung', async pg => {
    await ocr(pg, BELEG_B); await shoot(pg); const d = await state(pg); const t = await text(pg);
    assert.deepEqual(cnt(d), [1, 1, 1, '2.438,98', '69,98']);
    assert.ok(/Summen stimmen/.test(t) && !/weichen ab/.test(t));
  }],
  ['Teilerfolg: Tarife erkannt, Gesamtkosten fehlen → genaue Meldung; fehlgeschlagener 2. Versuch löscht nichts', async pg => {
    await ocr(pg, PARTIAL); await shoot(pg); const t1 = await text(pg); const d1 = await state(pg);
    assert.equal(cnt(d1)[0], 2);
    assert.ok(/Gesamtkosten (fehlen noch|konnten nicht sicher zugeordnet werden)/.test(t1), t1.slice(-300));
    assert.ok(!/Nichts erkannt/.test(t1));
    await ocr(pg, ''); await shoot(pg, photo2); const d2 = await state(pg);
    assert.deepEqual(cnt(d2), cnt(d1));
  }],
  ['Zwei Fotos desselben Angebots: keine doppelten Positionen', async pg => {
    await ocr(pg, BELEG_B); await shoot(pg); await shoot(pg, photo2); const d = await state(pg);
    assert.deepEqual(cnt(d), [1, 1, 1, '2.438,98', '69,98']);
  }],
  ['Anderes Angebot: Rückfrage statt Vermischung; „ersetzen“ übernimmt nur Angebot B', async pg => {
    await ocr(pg, BELEG); await shoot(pg); await ocr(pg, BELEG_B); await shoot(pg, photo2);
    assert.ok(/Anderes Angebot erkannt/.test(await text(pg)));
    assert.deepEqual(cnt(await state(pg)), [2, 1, 0, '2.468,98', '69,98']);
    await pg.getByRole('button', { name: 'Neues Angebot – bisherige Angaben ersetzen' }).click(); await settle(pg);
    assert.deepEqual(cnt(await state(pg)), [1, 1, 1, '2.438,98', '69,98']);
  }],
  ['Anderes Angebot → „Trotzdem zusammenführen“: bewusst gemischt, nichts verloren', async pg => {
    await ocr(pg, BELEG); await shoot(pg); await ocr(pg, BELEG_B); await shoot(pg, photo2);
    await pg.getByRole('button', { name: 'Trotzdem zusammenführen' }).click(); await settle(pg);
    const d = await state(pg);
    assert.ok(d && d.tarife.length >= 3 && d.internet.length === 1, JSON.stringify(cnt(d)));
  }],
  ['Anderes Angebot → „Foto verwerfen“: Angebot A bleibt', async pg => {
    await ocr(pg, BELEG); await shoot(pg); await ocr(pg, BELEG_B); await shoot(pg, photo2);
    await pg.getByRole('button', { name: 'Foto verwerfen' }).click(); await pg.waitForTimeout(200);
    assert.deepEqual(cnt(await state(pg)), [2, 1, 0, '2.468,98', '69,98']);
  }],
  ['Summenschutz: abweichende Gesamtkosten desselben Angebots werden nicht still übernommen', async pg => {
    await ocr(pg, BELEG); await shoot(pg); await ocr(pg, A_BAD); await shoot(pg, photo2);
    const d = await state(pg); const t = await text(pg);
    assert.equal(d.monatlich, '69,98');
    assert.ok(/Gesamtkosten weichen ab/.test(t), t.slice(-300));
  }],
  ['Lesefehler in einer Ziffer der Gesamtsumme (69,93 statt 69,98): Summe bleibt leer statt falsch, Rest übernommen', async pg => {
    await ocr(pg, A_SLIP); await shoot(pg);
    const d = await state(pg);
    assert.equal(d.monatlich, '', 'falsch gelesene Summe nicht übernommen');
    assert.equal(d.einmalig, '2.468,98');
    assert.deepEqual(cnt(d).slice(0, 3), [2, 1, 0]);
  }],
  ['Zeitlimit: hängende Texterkennung → Dialog frei, klare Meldung, Arbeiter beendet', async pg => {
    await ocr(pg, '', { hang: true }); const t0 = Date.now(); await shoot(pg); const dt = Date.now() - t0; const t = await text(pg);
    assert.ok(dt < 45000, dt + ' ms');
    assert.ok(!/Nichts erkannt/.test(t));
    assert.ok(/Angebot übernehmen|Vorschlag fotografieren|Weiteres Foto/.test(t));
    assert.ok(await pg.evaluate('window.__ocr.terminated') >= 1);
  }],
  ['Abbrechen wirkt sofort (< 1 s); verspätetes Ergebnis ändert danach nichts', async pg => {
    await ocr(pg, BELEG, { delay: 4000 }); await shoot(pg, photo1, false);
    await pg.waitForSelector('[role=status] button', { timeout: 8000 }); await pg.waitForTimeout(500);
    const t0 = Date.now(); await pg.click('[role=status] button'); await pg.waitForSelector('[role=status] button', { state: 'detached', timeout: 3000 });
    assert.ok(Date.now() - t0 < 1000, (Date.now() - t0) + ' ms');
    assert.ok(/abgebrochen/.test(await text(pg)));
    await pg.waitForTimeout(4500);
    const d = await state(pg);
    assert.ok(d === null || JSON.stringify(cnt(d)) === JSON.stringify([0, 0, 0, '', '']), JSON.stringify(cnt(d)));
  }],
  ['Zwei schnelle Fotos: nur der letzte Lauf zählt, nichts doppelt, kein Hänger', async pg => {
    await ocr(pg, BELEG, { delay: 1500 }); await shoot(pg, photo1, false); await pg.waitForTimeout(250);
    await ocr(pg, BELEG_B, { delay: 200 });
    await pg.setInputFiles('input[aria-label="Foto aufnehmen"]', photo2);
    await settle(pg); await pg.waitForTimeout(2000);
    const d = await state(pg);
    assert.deepEqual(cnt(d), [1, 1, 1, '2.438,98', '69,98']);
    assert.equal(await pg.locator('[role=status] button').count(), 0, 'keine hängende Fortschrittsanzeige');
  }],
];

for (const [name, fn] of scenarios) {
  test(name, { timeout: 120000 }, async t => {
    if (!list.length) return t.skip('kein Browser (npx playwright install chromium)');
    for (const { name: bn, b } of list) {
      const pg = await newPage(b);
      try { await fn(pg); } catch (e) { e.message = `[${bn}] ` + e.message; throw e; } finally { await pg.close(); }
    }
  });
}

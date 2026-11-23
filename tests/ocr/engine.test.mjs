// Ablauf der Erkennung mit Attrappen: Zeitlimits, Abbruch, Neustart des Arbeiters, Wiederholungen, "alte" Ergebnisse.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadOcr, fakeTesseract, hooks, BELEG } from './helpers.mjs';

// Zeitlimits fuer Tests kurz (ein Durchgang wartet mindestens 2 s, siehe psO2Pass)
const FAST = { workerCold: 1500, workerWarm: 1500, pass: 2000, budget: 9000, minPass: 500, script: 1000 };
const LUECKE = BELEG.replace(/Monatliche Kosten.*\n/, ''); // Summe fehlt -> loest einen weiteren Durchgang aus
const run = (X, file = {}, o = {}) => X.psO2ReadLocal(file, o.onMsg || null, () => true, { t: FAST, hooks: hooks(o), job: o.job });

test('guter Beleg: ein Durchgang, Arbeiter wird erzeugt und danach wiederverwendet', async () => {
  const T = fakeTesseract([{ text: BELEG }]);
  const X = loadOcr(T);
  const a = await run(X);
  assert.equal(a.tries, 1);
  assert.equal(a.fail, '');
  assert.equal(a.r.tarife.length, 2);
  assert.equal(a.r.einmalig, '2.468,98');
  assert.equal(a.r.monatlich, '69,98');
  const b = await run(X);
  assert.equal(b.tries, 1);
  assert.equal(T.created.length, 1, 'Arbeiter wiederverwendet statt neu gebaut');
  assert.equal(T.terminated.length, 0);
  X.psO2Release();
});

test('Statusmeldungen laufen in der vorgesehenen Reihenfolge', async () => {
  const T = fakeTesseract([{ text: BELEG }]);
  const X = loadOcr(T); const msgs = [];
  await run(X, {}, { onMsg: m => msgs.push(m) });
  const seq = ['Foto wird vorbereitet …', 'Text wird erkannt …', 'Produkte und Tarife werden zugeordnet …', 'Preise werden geprüft …'];
  let i = 0; msgs.forEach(m => { if (m === seq[i]) i++; });
  assert.equal(i, seq.length, JSON.stringify(msgs));
  X.psO2Release();
});

test('Luecke -> zweiter Durchgang; der schwaechere ueberschreibt nichts', async () => {
  const T = fakeTesseract([{ text: LUECKE }, { text: 'HANDY\n2.389,00 € –\nApple iPhone 18 Pro 1TB, Burgunder' }, { text: BELEG }]);
  const X = loadOcr(T);
  const o = await run(X);
  assert.ok(o.tries >= 2);
  assert.equal(o.r.tarife.length, 2);
  assert.equal(o.r.geraete.length, 1);
  assert.equal(o.r.einmalig, '2.468,98');
  X.psO2Release();
});

test('weiterer Durchgang bringt nichts Neues -> es wird nicht endlos wiederholt', async () => {
  const T = fakeTesseract([{ text: LUECKE }]);
  const X = loadOcr(T);
  const o = await run(X);
  assert.ok(o.tries <= 2, 'Versuche: ' + o.tries);
  assert.equal(o.r.tarife.length, 2);
  X.psO2Release();
});

test('haengender Arbeiter: Zeitlimit, Arbeiter wird beendet, naechstes Foto baut neu auf', async () => {
  const T = fakeTesseract([{ hang: true }, { hang: true }, { text: BELEG }]);
  const X = loadOcr(T);
  const t0 = Date.now();
  const a = await run(X);
  assert.equal(a.fail, 'timeout');
  assert.equal(a.timedOut, true);
  assert.ok(Date.now() - t0 < FAST.budget + 2000, 'Gesamtdauer begrenzt: ' + (Date.now() - t0));
  assert.ok(T.terminated.length >= 1, 'haengender Arbeiter wirklich beendet');
  assert.equal(X.peek('__psO2W'), null);
  const b = await run(X); // Foto nach dem Timeout
  assert.equal(b.fail, '');
  assert.equal(b.r.tarife.length, 2);
  assert.ok(T.created.length >= 2, 'neuer Arbeiter aufgebaut');
  X.psO2Release();
});

test('Timeout nach erfolgreichem Durchgang: Ergebnis bleibt erhalten', async () => {
  const T = fakeTesseract([{ text: LUECKE }, { hang: true }]);
  const X = loadOcr(T);
  const o = await run(X);
  assert.equal(o.fail, '', 'kein Gesamtfehler, wenn schon etwas gelesen wurde');
  assert.equal(o.r.tarife.length, 2);
  assert.equal(o.r.geraete.length, 1);
  assert.equal(o.r.einmalig, '2.468,98');
  X.psO2Release();
});

test('Abbruch durch den Benutzer waehrend der Erkennung wirkt sofort', async () => {
  const T = fakeTesseract([{ hang: true }]);
  const X = loadOcr(T);
  const job = X.psO2NewJob();
  const p = run(X, {}, { job });
  await new Promise(r => setTimeout(r, 150));
  const t0 = Date.now();
  job.cancel('user');
  const o = await p;
  assert.ok(Date.now() - t0 < 500, 'Abbruch dauerte ' + (Date.now() - t0) + ' ms');
  assert.equal(o.cancelled, true);
  assert.equal(o.fail, 'cancelled');
  assert.ok(T.terminated.length >= 1, 'rechnender Arbeiter beendet');
  X.psO2Release();
});

test('neue Aufnahme bricht die alte ab; ein altes Ergebnis ueberschreibt das neue nie', async () => {
  const T = fakeTesseract([{ text: 'HANDY\n2.389,00 € –\nApple iPhone 18 Pro 1TB, Burgunder', delay: 700 }, { text: BELEG }]);
  const X = loadOcr(T);
  const j1 = X.psO2NewJob();
  const p1 = run(X, {}, { job: j1 });
  await new Promise(r => setTimeout(r, 100));
  const j2 = X.psO2NewJob(); // neue Aufnahme
  assert.equal(j1.cancelled, true);
  const p2 = run(X, {}, { job: j2 });
  const [a, b] = await Promise.all([p1, p2]);
  assert.equal(a.cancelled, true);
  assert.equal(b.cancelled, false);
  assert.equal(b.r.tarife.length, 2);
  assert.equal(b.r.monatlich, '69,98');
  assert.equal(a.r.tarife.length, 0, 'alter Lauf liefert nichts Neues');
  X.psO2Release();
});

test('Foto nicht lesbar: sofortiger, klarer Fehler ohne Texterkennung zu starten', async () => {
  const T = fakeTesseract([{ text: BELEG }]);
  const X = loadOcr(T);
  const t0 = Date.now();
  const o = await run(X, {}, { badImage: true });
  assert.equal(o.fail, 'image');
  assert.equal(o.tries, 0);
  assert.equal(T.recognized, 0);
  assert.ok(Date.now() - t0 < 300);
  X.psO2Release();
});

test('Texterkennung nicht startbar: fail "engine", kein Haenger', async () => {
  const T = fakeTesseract([{ text: BELEG }], { failCreate: true });
  const X = loadOcr(T);
  const o = await run(X);
  assert.equal(o.fail, 'engine');
  assert.equal(T.recognized, 0);
  X.psO2Release();
});

test('Arbeiter-Aufbau haengt: Zeitlimit statt endlosem Warten', async () => {
  const T = fakeTesseract([{ text: BELEG }], { createDelay: 60000 });
  const X = loadOcr(T);
  const t0 = Date.now();
  const o = await run(X);
  assert.equal(o.fail, 'engine');
  assert.ok(Date.now() - t0 < 5000, 'dauerte ' + (Date.now() - t0));
  X.psO2Release();
});

test('Kein Text / Rauschen: kein Erfolg vorgetaeuscht, Dauer begrenzt', async () => {
  const T = fakeTesseract([{ text: 'N | | A U ll ! |' }]);
  const X = loadOcr(T);
  const o = await run(X);
  assert.equal(o.r.tarife.length + o.r.geraete.length, 0);
  assert.equal(o.fail, '');
  assert.equal(X.psO2Verdict(o.r, { txt: o.txt }).kind, 'notext');
  assert.ok(o.tries <= 3 && o.ms < FAST.budget + 2000);
  X.psO2Release();
});

test('Quell-Bild wird nach jedem Lauf freigegeben (Speicher)', async () => {
  const T = fakeTesseract([{ text: BELEG }]);
  const X = loadOcr(T);
  hooks.closed = 0;
  await run(X); await run(X);
  assert.equal(hooks.closed, 2);
  X.psO2Release();
});

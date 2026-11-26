// HeTec Smart Capture → Pencil Selling: QR-Protokoll (gemeinsame Testvektoren mit Smart Capture), Umwandlung ins interne
// Datenmodell, bestehende Preisprüfung und Angebotskarten, Ergänzen, Schutz gegen doppelte Übernahme. Ohne Browser (Node-VM).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url)), ROOT = path.resolve(HERE, '..', '..');
const SS = path.join(ROOT, 'frontend/smart-scan');
const V = JSON.parse(fs.readFileSync(path.join(HERE, 'hsc-vectors.json'), 'utf8'));
const plain = x => JSON.parse(JSON.stringify(x));

function load() {
  const store = {};
  const localStorage = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } };
  const ctx = vm.createContext({ console, TextEncoder, TextDecoder, Uint8Array, crypto: globalThis.crypto, localStorage, navigator: {}, document: {}, setTimeout, clearTimeout });
  ctx.globalThis = ctx; ctx.window = ctx;
  const src = ['hsc-protocol.js', 'parser.js', 'transfer.js', 'hsc-import.js'].map(f => fs.readFileSync(path.join(SS, f), 'utf8')).join('\n;\n');
  vm.runInContext(src + '\n;this.__x = { psHscToProposal, psHscMerge, psHscWasImported, psHscMarkImported, psHscWarnText, psO2Check, psO2Cards, psO2Cents };', ctx);
  return { HSC: ctx.HSC, X: ctx.__x, store };
}
const { HSC, X, store } = load();

test('Protokoll-Datei identisch mit HeTec Smart Capture (vereinbarte Fassung)', () => {
  const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(SS, 'hsc-protocol.js'))).digest('hex');
  assert.equal(sha, fs.readFileSync(path.join(HERE, 'hsc-protocol.sha256'), 'utf8').trim());
});

test('gemeinsame Testvektoren: gültige Codes werden gelesen, ungültige mit passender Meldung abgelehnt', () => {
  for (const v of V.valid) {
    const d = HSC.decode(v.parts, { now: V.now + 10 });
    assert.equal(d.ok, true, v.name + ': ' + d.message);
    assert.deepEqual(plain(d.offer), v.offer, v.name);
  }
  for (const v of V.invalid) {
    const d = HSC.decode(v.parts, { now: v.now || V.now + 10 });
    assert.equal(d.ok, false, v.name);
    assert.equal(d.code, v.code, v.name);
  }
  // Echte Uhrzeit: die Vektoren sind längst abgelaufen
  assert.equal(HSC.decode(V.valid[0].parts).code, 'EXPIRED');
});

test('Umwandlung ins interne Datenmodell: Preise, Rabatte, Aktionskarte, Geräte-Zuordnung, Hinweise', () => {
  const o = HSC.decode(V.valid.find(v => v.name === 'handy_zwei_tarife_aktionskarte').parts, { now: V.now }).offer;
  const d = plain(X.psHscToProposal(o));
  assert.deepEqual(d.tarife[0], { name: 'O2 Mobile L (2026)', art: 'Neuvertrag', det: 'International Voice Standard\nInklusiv Datenvolumen 150 GB', am: ['39,99', '34,99'], rb: { e: 0, m: 0, bad: false } });
  assert.equal(d.tarife[1].ak, true);
  assert.deepEqual(d.geraete[0], { name: 'Apple iPhone 18 Pro 1TB, Burgunder', art: '', det: '', am: ['2.389,00', null], rb: { e: 0, m: 0, bad: false }, t: 0 });
  assert.equal(d.einmalig, '2.428,99');
  assert.equal(d.monatlich, '34,99');
  assert.match(d.hinweis, /Ab dem 25\. Monat: 39,99 € monatlich/);
  assert.equal(d.beratungsId, '');
  const i = HSC.decode(V.valid.find(v => v.name === 'internet_rabatt').parts, { now: V.now }).offer;
  const di = plain(X.psHscToProposal(i));
  assert.deepEqual(di.tarife[0].rb, { e: 0, m: -1500, bad: false });
  assert.match(di.hinweis, /Zusatzprodukte: O2 TV L \(10,00 € mtl\.\)/);
});

test('bestehende Preisprüfung und Angebotskarten arbeiten unverändert mit importierten Daten', () => {
  const o = HSC.decode(V.valid.find(v => v.name === 'einzeltarif').parts, { now: V.now }).offer;
  const d = X.psHscToProposal(o);
  const c = X.psO2Check(d);
  assert.ok(c.e.ok && c.m.ok, 'Summen stimmen');
  const cards = X.psO2Cards(d);
  assert.equal(cards.length, 3);
  assert.match(cards[0], /O₂ Mobile S \(2026\)/);
  assert.equal(cards[1], null); assert.equal(cards[2], null);
  // Handy + Aktionskarte: Aktionskarte erscheint bei Tarif 1 als „inkl. Aktionskarte“
  const a = X.psHscToProposal(HSC.decode(V.valid.find(v => v.name === 'handy_zwei_tarife_aktionskarte').parts, { now: V.now }).offer);
  const ca = X.psO2Cards(a);
  assert.match(ca[0], /inkl\. Aktionskarte/);
  assert.match(ca[0], /iPhone 18 Pro/);
});

test('Angebot ergänzen: Listen angehängt, Geräte-Zuordnung verschoben, Summen addiert (Integer-Cent)', () => {
  const a = X.psHscToProposal(HSC.decode(V.valid[0].parts, { now: V.now }).offer);
  const b = X.psHscToProposal(HSC.decode(V.valid[1].parts, { now: V.now }).offer);
  const m = plain(X.psHscMerge(a, b, { tarife: 6, geraete: 6, internet: 2 }));
  assert.equal(m.tarife.length, 3);
  assert.equal(m.geraete[0].t, 1, 'Gerät gehört weiter zu seinem Tarif');
  assert.equal(X.psO2Cents(m.einmalig), 3999 + 242899);
  assert.equal(X.psO2Cents(m.monatlich), 1999 + 3499);
});

test('doppelte Übernahme derselben Angebots-ID wird erkannt; gespeichert wird nur ID + Version', () => {
  const o = { id: 'abcdefghij', rev: 1 };
  assert.equal(X.psHscWasImported(o), false);
  X.psHscMarkImported([o]);
  assert.equal(X.psHscWasImported(o), true);
  assert.equal(X.psHscWasImported({ id: 'abcdefghij', rev: 2 }), false, 'neue Version (weitere Seite) ist ein neuer Import');
  const raw = store.ps_hsc_imported;
  assert.match(raw, /^\{"abcdefghij\.1":\d+\}$/);
  // nach 24 Stunden vergessen
  store.ps_hsc_imported = JSON.stringify({ 'abcdefghij.1': Date.now() - 25 * 3600 * 1000 });
  assert.equal(X.psHscWasImported(o), false);
  // manipulierter Speicher stört nicht
  store.ps_hsc_imported = '{kaputt';
  assert.equal(X.psHscWasImported(o), false);
});

test('Hinweise vom PC als feste Texte', () => {
  assert.equal(X.psHscWarnText({ quality: { warnings: ['SUM_M', 'PAGES'] } }), 'Monatliche Summe passt nicht zu den Einzelpreisen · Möglicherweise fehlt eine Seite');
});

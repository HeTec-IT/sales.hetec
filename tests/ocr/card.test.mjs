// Kompaktansicht (v56.0-beta.3): Titel/Untertitel der Produktkarten (nur Anzeige)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadOcr } from './helpers.mjs';

const HTML = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'index.html');
const src = fs.readFileSync(HTML, 'utf8').replace(/\r\n/g, '\n');
const a = src.indexOf('function psO2CardText(');
assert.ok(a > 0, 'psO2CardText nicht gefunden');
const fn = src.slice(a, src.indexOf('\n}\n', a) + 2);
const X = loadOcr();
const ctx = vm.createContext({ psO2Fmt: X.psO2Fmt });
vm.runInContext(fn + '\n;this.f = psO2CardText;', ctx);
const card = (k, it) => JSON.parse(JSON.stringify(ctx.f(k, it)));

test('Handy: "Name, Farbe" -> Titel + Farbe', () => {
  assert.deepEqual(card('geraete', { name: 'Apple iPhone 18 Pro 1TB, Burgunder', det: '' }), { title: 'Apple iPhone 18 Pro 1TB', sub: 'Burgunder' });
});

test('Tarif: Datenvolumen + monatlicher Rabatt', () => {
  const r = card('tarife', { name: 'O2 Mobile M Plus (2026)', det: 'International Voice Standard\nInklusiv Datenvolumen 60 GB', rb: { e: 0, m: -1500 } });
  assert.equal(r.title, 'O2 Mobile M Plus (2026)');
  assert.equal(r.sub, '60 GB · 15,00 € monatlicher Rabatt');
});

test('Tarif mit einmaligem Rabatt; Aktionskarte steht als eigenes Kennzeichen, nicht im Untertext', () => {
  assert.equal(card('tarife', { name: 'O2 Mobile S', det: '', rb: { e: -1000, m: 0 }, ak: true }).sub, '10,00 € einmaliger Rabatt');
});

test('Internet@Home: Vertragsart + erste Inhaltszeilen (max. 2)', () => {
  assert.equal(card('internet', { name: 'O2 Home XL 600', art: 'Analog Option', det: 'Download bis zu 600 MBit/s\nInstallationsservice\nDritte Zeile' }).sub, 'Analog Option · Download bis zu 600 MBit/s · Installationsservice');
});

test('Leerer Name bekommt einen Platzhalter, nichts bricht', () => {
  assert.equal(card('geraete', {}).title, 'Handy');
  assert.equal(card('tarife', { name: '' }).title, 'Tarif');
  assert.equal(card('internet', { name: '  ' }).sub, '');
});

test('Aktionskarte (SIM-Knopf): ein Haupttarif + eine markierte Aktionskarte -> Zeile bei Tarif 1, nur ein Tarif bleibt', () => {
  const merge = X.peek('psO2AkMerge');
  const t = { name: 'O2 Mobile M Plus (2026)', det: 'Inklusiv Datenvolumen 50 GB', am: ['39,99', '29,99'] };
  const r = JSON.parse(JSON.stringify(merge([{ ...t }, { ...t, ak: true }], [])));
  assert.equal(r.tar.length, 1);
  assert.match(r.tar[0].det, /inkl\. Aktionskarte 50 GB/);
});

test('Alle Tarife als Aktionskarte markiert: ohne Wirkung (es muss ein Haupttarif bleiben)', () => {
  const merge = X.peek('psO2AkMerge');
  const t = { name: 'O2 Mobile M Plus (2026)', det: '', am: ['39,99', '29,99'], ak: true };
  assert.equal(merge([{ ...t }, { ...t }], []).tar.length, 2);
});

// Gültigkeit der ausgelieferten Preisdateien (läuft auch vor jedem Release). Falsche Daten dürfen nicht live gehen.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = f => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
const datum = /^\d{2}\.\d{2}\.\d{4}$/;
const preis = (v, min, max) => typeof v === 'number' && isFinite(v) && v >= min && v <= max;

test('Netflix/Disney+: drei Tarife, aufsteigende plausible Preise, Prüfdatum', () => {
  for (const f of ['netflix-preise.json', 'disney-preise.json']) {
    const d = read(f);
    assert.match(d.geprueft, datum, f);
    assert.ok(Array.isArray(d.tarife) && d.tarife.length >= 2, f);
    for (const t of d.tarife) assert.ok(preis(t.preis, 1, 50), f + ' ' + t.id);
    for (let i = 1; i < d.tarife.length; i++) assert.ok(d.tarife[i].preis >= d.tarife[i - 1].preis, f + ' Reihenfolge');
  }
});
test('Kabel, Telekom-TV, Vodafone-TV, o2-TV: plausible Monatspreise', () => {
  const k = read('kabel-preise.json'); assert.ok(preis(k.preis, 1, 40)); assert.match(k.geprueft, datum);
  const t = read('telekom-tv-preise.json'); for (const v of Object.values(t.preise)) assert.ok(preis(v, 1, 100));
  const v = read('vodafone-tv-preise.json'); assert.ok(preis(v.preise.s, 1, 60) && preis(v.preise.m, 1, 80));
  const o = read('tv-preise.json'); for (const x of Object.values(o.o2.preise)) assert.ok(preis(x, 1, 60));
});
test('Pixel-Geräte: eindeutige Zuordnung Modell/Speicher, plausible Preise, nur o2-Adressen', () => {
  const p = read('pixel-geraete.json');
  assert.ok(Array.isArray(p.geraete) && p.geraete.length >= 1);
  const keys = new Set();
  for (const g of p.geraete) {
    assert.ok(/^Google Pixel /.test(g.name), g.name);
    assert.ok(preis(g.preis, 99, 3000), g.name + ' Preis');
    assert.ok(g.rate === undefined || preis(g.rate, 1, 120), g.name + ' Rate');
    const k = g.modell + '|' + g.speicher;
    assert.ok(!keys.has(k), 'doppelt: ' + k);
    keys.add(k);
    if (g.url) assert.match(g.url, /^https:\/\/www\.o2online\.de\//);
  }
});

// Smart Scan 2: Layout der neuronalen OCR, exakte Summen, gleiche Tarife, keine Cloud-Erkennung im Code.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadOcr, BELEG } from '../tests/ocr/helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const x = loadOcr();
const layout = x.peek('psSmartLayout'), exact = x.peek('psSmartExact'), region = x.peek('psSmartCostRegion');

test('Zeilenboxen nach Höhe gruppiert und von links nach rechts sortiert', () => {
  const b = (text, X, y, w) => ({ text, score: .99, poly: [[X, y], [X + w, y], [X + w, y + 12], [X, y + 12]] });
  const o = layout([b('69,98 €', 210, 50, 50), b('Monatliche Kosten', 10, 50, 130), b('TARIF', 10, 10, 40)]);
  assert.equal(o.text, 'TARIF\nMonatliche Kosten 69,98 €');
  assert.equal(o.words[1].ln, 2);
  assert.ok(region(o, { width: 300, height: 300 }));
});
test('exakte Summen und doppelte Tarife', () => {
  const r = x.psO2Parse(BELEG);
  assert.equal(r.tarife.length, 2);
  assert.equal(exact(r, BELEG), true);
  r.monatlich = '79,98';
  assert.equal(exact(r, BELEG), false);
});
test('ungruppierte vierstellige Summe bleibt erhalten', () => {
  const r = x.psO2Parse('Einmalige Kosten 2468,98 €\nMonatliche Kosten 69,98 €');
  assert.equal(x.psO2Cents(r.einmalig), 246898);
  assert.equal(r.monatlich, '69,98');
});
test('Smart Scan enthält keine Cloud-Erkennung und keine externen Adressen', () => {
  const dir = path.join(ROOT, 'frontend/smart-scan');
  for (const f of fs.readdirSync(dir)) {
    const s = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.doesNotMatch(s, /psO2CloudRead|cloudfunctions\.net|vertex|gemini|googleapis/i, f);
    assert.doesNotMatch(s, /https:\/\/(?!www\.o2online)/, f + ' enthält eine externe https-Adresse');
  }
  const ui = fs.readFileSync(path.join(dir, 'ui-dialog.js'), 'utf8');
  const a = ui.indexOf('const readPhoto = async (jobP, stage, retryFile, ovF, pre)'), b = ui.indexOf('const pendingGo = mode', a);
  assert.ok(a >= 0 && b > a);
});
test('index.html enthält Smart Scan nicht mehr inline, lädt aber alle Module', () => {
  const h = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.ok(!h.includes('function PsO2Import('));
  assert.ok(!h.includes('function psO2Parse('));
  for (const f of ['config.js', 'parser.js', 'preprocess.js', 'neural.js', 'engine.js', 'transfer.js', 'camera.js', 'snip.js', 'qr-transfer.js', 'ui-crop.js', 'ui-dialog.js']) {
    assert.ok(h.includes(`src="frontend/smart-scan/${f}"`), f);
  }
});

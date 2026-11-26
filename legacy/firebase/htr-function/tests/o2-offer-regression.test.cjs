'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname, '../index.js'), 'utf8');
// Test the pure normalizer without importing the Firebase Cloud Function.
const start = source.indexOf('function cleanO2(j) {');
const end = source.indexOf('\n\nasync function handle', start);
assert.ok(start >= 0 && end > start, 'cleanO2 source exists');
const cleanO2 = vm.runInNewContext(source.slice(start, end) + '\ncleanO2;');

const item = (name, einmalig, monatlich, rabattMonatlich = '') => ({
  name, details: [], einmalig, monatlich, rabattMonatlich
});

test('readable is true for a partial but populated offer', () => {
  const data = cleanO2({ readable: false, geraete: [
    item('Apple iPhone 18 Pro 1TB, Burgunder', '2.389,00', '')
  ], tarife: [
    item('O2 Mobile L (2026)', '39,99', '34,99'),
    item('O2 Mobile L (2026)', '39,99', '34,99')
  ], einmalig: '2.468,98', monatlich: '69,98' });
  assert.equal(data.readable, true);
  assert.equal(data.tarife.length, 2, 'duplicate tariff names are distinct positions');
  assert.equal(data.einmalig, '2.468,98');
  assert.equal(data.monatlich, '69,98');
});

test('Internet + handset + mobile tariff: printed net costs and discount survive parsing', () => {
  const data = cleanO2({ readable: false,
    internet: [item('O2 Home XL 600', '9,99', '54,99')],
    geraete: [item('Apple iPhone 18 Pro 1TB, Burgunder', '2.389,00', '')],
    tarife: [item('O2 Mobile M Plus (2026)', '39,99', '29,99', '-15,00')],
    einmalig: '2.438,98', monatlich: '69,98'
  });
  assert.equal(data.readable, true);
  assert.equal(data.internet[0].einmalig, '9,99');
  assert.equal(data.tarife[0].rabattMonatlich, '15,00');
  assert.equal(data.einmalig, '2.438,98');
  assert.equal(data.monatlich, '69,98');
});

test('empty structured offer is not reported as readable', () => {
  assert.equal(cleanO2({ readable: true }).readable, false);
});

test('OCR prompt tells model to avoid double-counting a discounted setup fee', () => {
  assert.match(source, /rabattEinmalig fuer dieses Internetprodukt leer lassen/);
  assert.match(source, /Internet@Home nie als Mobilfunktarif erfassen/);
  assert.match(source, /readable=true, sobald mindestens ein echtes Produkt/);
});

test('Angebotskennzeichen (Zeitstempel, Beratungs-ID) werden normalisiert, nichts anderes aus dem Kopf uebernommen', () => {
  const d = cleanO2({ tarife: [item('O2 Mobile L (2026)', '39,99', '34,99')], erstelltAm: 'erstellt am 23.11.2026 17:15 Uhr', beratungsId: 'ID 4711-0815' });
  assert.equal(d.erstelltAm, '23.11.2026 17:15');
  assert.equal(d.beratungsId, '47110815');
  assert.equal(cleanO2({ tarife: [item('O2 Mobile L (2026)', '39,99', '34,99')], erstelltAm: 'gestern' }).erstelltAm, '');
});

test('Prompt: Ersparnis ist keine Kostenposition, Kennzeichen nur zur Zuordnung', () => {
  assert.match(source, /Ersparnis \.\.\.\" ist keine Kostenposition/);
  assert.match(source, /erstelltAm = Datum und Uhrzeit/);
});

test('Angebot B: Kopfzeilenpreise + Plus-Rabatt ergeben die gedruckten Summen (2.438,98 / 69,98)', () => {
  const d = cleanO2({ internet: [item('O2 Home XL 600', '9,99', '54,99')], geraete: [item('Apple iPhone 18 Pro 1TB, Burgunder', '2.389,00', '')],
    tarife: [item('O2 Mobile M Plus (2026)', '39,99', '29,99', '15,00')], einmalig: '2.438,98', monatlich: '69,98' });
  const cents = v => v ? Math.round(parseFloat(v.replace(/\./g, '').replace(',', '.')) * 100) : 0;
  const all = [].concat(d.internet, d.geraete, d.tarife);
  assert.equal(all.reduce((a, x) => a + cents(x.einmalig), 0), cents(d.einmalig));
  assert.equal(all.reduce((a, x) => a + cents(x.monatlich) - cents(x.rabattMonatlich), 0), cents(d.monatlich));
});

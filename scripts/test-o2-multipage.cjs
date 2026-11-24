'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
const start = html.indexOf('const PS_O2_AMT');
const end = html.indexOf('// === v55.176 (Beta)', start);
assert.ok(start >= 0 && end > start, 'OCR module exists');
const api = vm.runInNewContext(html.slice(start, end) +
  '\n({psO2Parse,psO2CloudShape,psO2CloudNeedsLocal,psO2SuspectTotals,psO2Page2InternetDetails,psO2JoinDetails});',
  { console, window: {} }, { timeout: 10000 });

test('page 1 keeps the Internet@Home header and its separate prices', () => {
  const page = [
    'Vorschlag', 'HANDY',
    'Apple IPHONE 18 PRO MAX 256GB BURGUNDER 1.729,00 €',
    'TARIF','O2 Mobile S (2026) 39,99 € 19,99 €',
    'TARIF','O2 Mobile M (2026) 39,99 € 29,99 €',
    'TARIF','O2 Mobile L (2026) 39,99 € 34,99 €',
    'INTERNET@HOME', 'O2 Home XL 600 9,99 € 54,99 €',
    'Seite 1 von 2'
  ].join('\n');
  const d = api.psO2Parse(page);
  assert.equal(d.tarife.length, 3);
  assert.equal(d.internet.length, 1);
  assert.equal(d.internet[0].am[0], '9,99');
  assert.equal(d.internet[0].am[1], '54,99');
});

test('page 2 costs are separate and its internet details do not create a second product', () => {
  const page = [
    'Vorschlag', 'Installationsadresse: [aus Datenschutzgruenden entfernt]',
    'Analog Option', 'International Voice Standard',
    '40 EUR Rabatt auf den Anschlusspreis -40,00 €',
    'Einmaliger Anschlusspreis 49,99 €',
    'O2 Installationsservice',
    'Einmalige Kosten 1.858,96 €',
    'Monatliche Kosten 139,96 €',
    'Aktuell', 'Beratung'
  ].join('\n');
  const d = api.psO2Parse(page);
  assert.equal(d.einmalig, '1.858,96');
  assert.equal(d.monatlich, '139,96');
  assert.equal(d.internet.length, 0);
  const details = api.psO2Page2InternetDetails(page);
  assert.ok(details.includes('Analog Option'));
  assert.ok(details.includes('International Voice Standard'));
  assert.ok(details.includes('O2 Installationsservice'));
  assert.equal(details.some(x => /Adresse|Rabatt|49,99/i.test(x)), false);
  const combined = api.psO2JoinDetails('', details);
  assert.ok(combined.includes('Analog Option'));
});

test('incomplete cloud item prices force a second local read', () => {
  const d = api.psO2CloudShape({ geraete: [{name:'iPhone 18 Pro Max',einmalig:'1.729,00'}],
    tarife: [{name:'O2 Mobile S (2026)'}], internet:[{name:'O2 Home XL 600'}] });
  assert.equal(api.psO2CloudNeedsLocal(d, 'ganz', { internet: [] }), true);
});

test('same high amount in both total fields is suspicious', () => {
  assert.equal(api.psO2SuspectTotals({einmalig:'1.858,96',monatlich:'1.858,96'}), true);
  assert.equal(api.psO2SuspectTotals({einmalig:'1.858,96',monatlich:'139,96'}), false);
  assert.equal(api.psO2CloudNeedsLocal({ tarife:[],geraete:[],internet:[],einmalig:'1.858,96',monatlich:'139,96' },
    'ganz', { internet:[{name:'O2 Home XL 600'}] }), true);
});

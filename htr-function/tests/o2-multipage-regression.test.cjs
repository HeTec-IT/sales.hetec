'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../index.js'), 'utf8');
const start = source.indexOf('function cleanO2(j) {');
const end = source.indexOf('\n\nasync function handle', start);
assert.ok(start >= 0 && end > start);
const cleanO2 = vm.runInNewContext(source.slice(start, end) + '\ncleanO2;');

test('page 2 continuation retains service features but not an address', () => {
  const d = cleanO2({ readable: true, tarife: [], geraete: [], internet: [],
    internetFortsetzung: ['Analog Option', 'International Voice Standard', 'O2 Installationsservice',
      'Installationsadresse: [sensitive]', '40 EUR Rabatt auf Anschlusspreis'],
    einmalig: '1.858,96', monatlich: '139,96'
  });
  assert.equal(d.internetFortsetzung.length, 3);
  assert.ok(!d.internetFortsetzung.some(x => /Adresse|Rabatt/i.test(x)));
  assert.equal(d.einmalig, '1.858,96');
  assert.equal(d.monatlich, '139,96');
  assert.equal(d.internet.length, 0);
});
test('model instruction mentions continuation and independent monthly amount', () => {
  assert.match(source, /internetFortsetzung zurueck/);
  assert.match(source, /1\.858,96/);
  assert.match(source, /Monatliche Kosten 139,96/);
});

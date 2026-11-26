// Mehrseitige o2-Vorschläge (Internet@Home über zwei Seiten), Summenschutz, fehlende Einzelpreise.
// Migriert aus scripts/test-o2-multipage.cjs; die Cloud-spezifischen Prüfungen sind durch lokale ersetzt.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadOcr } from './helpers.mjs';

const X = loadOcr();
const api = {
  psO2Parse: X.peek('psO2Parse'), psO2Page2InternetDetails: X.peek('psO2Page2InternetDetails'),
  psO2JoinDetails: X.peek('psO2JoinDetails'), psO2SuspectTotals: X.peek('psO2SuspectTotals'), psO2Gaps: X.peek('psO2Gaps'),
  psO2Combine: X.peek('psO2Combine'),
};

test('Seite 1 behält Internet@Home mit eigenen Preisen', () => {
  const page = ['Vorschlag', 'HANDY', 'Apple IPHONE 18 PRO MAX 256GB BURGUNDER 1.729,00 €',
    'TARIF', 'O2 Mobile S (2026) 39,99 € 19,99 €', 'TARIF', 'O2 Mobile M (2026) 39,99 € 29,99 €',
    'TARIF', 'O2 Mobile L (2026) 39,99 € 34,99 €', 'INTERNET@HOME', 'O2 Home XL 600 9,99 € 54,99 €', 'Seite 1 von 2'].join('\n');
  const d = api.psO2Parse(page);
  assert.equal(d.tarife.length, 3);
  assert.equal(d.internet.length, 1);
  assert.equal(d.internet[0].am[0], '9,99');
  assert.equal(d.internet[0].am[1], '54,99');
});

test('Seite 2: Gesamtkosten getrennt, Internet-Details erzeugen kein zweites Produkt, keine Adresse', () => {
  const page = ['Vorschlag', 'Installationsadresse: [aus Datenschutzgruenden entfernt]', 'Analog Option', 'International Voice Standard',
    '40 EUR Rabatt auf den Anschlusspreis -40,00 €', 'Einmaliger Anschlusspreis 49,99 €', 'O2 Installationsservice',
    'Einmalige Kosten 1.858,96 €', 'Monatliche Kosten 139,96 €', 'Aktuell', 'Beratung'].join('\n');
  const d = api.psO2Parse(page);
  assert.equal(d.einmalig, '1.858,96');
  assert.equal(d.monatlich, '139,96');
  assert.equal(d.internet.length, 0);
  const details = api.psO2Page2InternetDetails(page);
  assert.ok(details.includes('Analog Option'));
  assert.ok(details.includes('International Voice Standard'));
  assert.ok(details.includes('O2 Installationsservice'));
  assert.equal(details.some(x => /Adresse|Rabatt|49,99/i.test(x)), false);
  assert.ok(api.psO2JoinDetails('', details).includes('Analog Option'));
});

test('Gleiche hohe Summe in Einmalig und Monatlich gilt als verdächtig (Verwechslungsschutz)', () => {
  assert.equal(api.psO2SuspectTotals({ einmalig: '1.858,96', monatlich: '1.858,96' }), true);
  assert.equal(api.psO2SuspectTotals({ einmalig: '1.858,96', monatlich: '139,96' }), false);
});

test('Fehlende Einzelpreise (Mobile S, Home) verlangen einen weiteren Durchgang', () => {
  const p = { tarife: [{ name: 'O2 Mobile S (2026)', am: null, details: [], rb: { e: 0, m: 0, bad: false } }], geraete: [],
    internet: [{ name: 'O2 Home XL 600', am: null, details: [], rb: { e: 0, m: 0, bad: false } }], einmalig: '', monatlich: '', hdr: { tarife: 1, geraete: 0, internet: 1 } };
  assert.ok(api.psO2Gaps(p, 'TARIF O2 Mobile S (2026) INTERNET@HOME O2 Home XL 600').includes('einzelpreise'));
});

test('Seite 1 + Seite 2 zusammengeführt: Produkte von Seite 1, Summen von Seite 2, nichts doppelt (ersetzt Cloud-Nachlesen)', () => {
  const p1 = api.psO2Parse(['HANDY', 'Apple IPHONE 18 PRO MAX 256GB BURGUNDER 1.729,00 €', 'TARIF', 'O2 Mobile S (2026) 39,99 € 19,99 €',
    'INTERNET@HOME', 'O2 Home XL 600 9,99 € 54,99 €', 'Seite 1 von 2'].join('\n'));
  const p2 = api.psO2Parse(['Installationsadresse: [entfernt]', 'Analog Option', 'Einmalige Kosten 1.858,96 €', 'Monatliche Kosten 139,96 €'].join('\n'));
  const c = api.psO2Combine([p1, p2]);
  assert.equal(c.tarife.length, 1);
  assert.equal(c.internet.length, 1);
  assert.equal(c.geraete.length, 1);
  assert.equal(c.einmalig, '1.858,96');
  assert.equal(c.monatlich, '139,96');
});

test('Zeilenversatz: Einmalsumme im Monatsfeld wird nicht übernommen, korrekter Durchgang gewinnt (v57)', () => {
  const shifted = api.psO2Parse(['TARIF', '39,99 € 34,99 €', 'O2 Mobile L (2026)', 'Einmaliger Anschlusspreis —', 'Einmalige Kosten 39,99 €', 'Monatliche Kosten 2.468,98 €'].join('\n'));
  const correct = api.psO2Parse(['TARIF', '39,99 € 34,99 €', 'O2 Mobile L (2026)', 'Einmalige Kosten 2.468,98 €', 'Monatliche Kosten 69,98 €'].join('\n'));
  assert.equal(shifted.monatlich, '2.468,98', 'Voraussetzung: der verschobene Durchgang liest die Summen vertauscht');
  for (const order of [[shifted, correct], [correct, shifted]]) {
    const c = api.psO2Combine(order);
    assert.equal(c.einmalig, '2.468,98');
    assert.equal(c.monatlich, '69,98');
  }
});

test('Zeilenversatz ohne korrekten Durchgang: Summen bleiben leer statt vertauscht (v57)', () => {
  const shifted = api.psO2Parse(['TARIF', '39,99 € 34,99 €', 'O2 Mobile L (2026)', 'Einmalige Kosten 39,99 €', 'Monatliche Kosten 2.468,98 €'].join('\n'));
  const c = api.psO2Combine([shifted]);
  assert.equal(c.monatlich, '');
  assert.equal(c.einmalig, '');
});

test('Plausible hohe Einmalsumme und normale Monatssumme bleiben unverändert', () => {
  const ok = api.psO2Parse(['Einmalige Kosten 2.468,98 €', 'Monatliche Kosten 699,98 €'].join('\n'));
  const c = api.psO2Combine([ok]);
  assert.equal(c.einmalig, '2.468,98');
  assert.equal(c.monatlich, '699,98');
});

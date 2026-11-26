import test from 'node:test';
import assert from 'node:assert/strict';
import { loadOcr, BELEG, plain } from './helpers.mjs';

const X = loadOcr();
const names = l => l.map(t => t.name);

test('Pflichtfall: Handy + 2 gleiche Tarife + Summen 2.468,98 / 69,98', () => {
  const r = X.psO2Parse(BELEG);
  assert.equal(r.einmalig, '2.468,98');
  assert.equal(r.monatlich, '69,98');
  assert.equal(r.tarife.length, 2, 'zwei gleiche Tarifnamen duerfen nicht zusammengelegt werden');
  assert.deepEqual(plain(names(r.tarife)), ['O2 Mobile L (2026)', 'O2 Mobile L (2026)']);
  r.tarife.forEach(t => assert.deepEqual(plain(t.am), ['39,99', '34,99']));
  assert.equal(r.geraete.length, 1);
  assert.match(X.psO2Pretty(r.geraete[0].name), /Apple iPhone 18 Pro 1TB, Burgunder/);
  assert.equal(r.geraete[0].am[0], '2.389,00');
});

test('Pflichtfall: Einzelpreise ergeben exakt die Summen', () => {
  const c = X.psO2Check(X.psO2Parse(BELEG));
  assert.ok(c && c.e.ok && c.m.ok, JSON.stringify(c));
  assert.deepEqual(plain(c.e.calc), [246898]);
  assert.deepEqual(plain(c.m.calc), [6998]);
});

test('Schreibweisen: 39.99 / O₂ / 02 / ITB', () => {
  const t = BELEG.replace(/39,99/g, '39.99').replace(/34,99/g, '34.99').replace(/O2 Mobile/g, '02 Mobile').replace('1TB', 'ITB');
  const r = X.psO2Parse(t);
  assert.equal(r.tarife.length, 2);
  assert.match(X.psO2Pretty(r.geraete[0].name), /1TB/);
  const t2 = BELEG.replace(/O2 Mobile/g, 'O₂ Mobile');
  assert.equal(X.psO2Parse(t2).tarife.length, 2);
});

test('verlesener Tarifname ("uOrMebile L (2026)") verliert den Tarif nicht', () => {
  const t = BELEG.replace('TARIF\nO2 Mobile L (2026) 39,99 € 34,99 €', 'TARIF\nuOrMebile L (2026) 39,99 € 34,99 €');
  const r = X.psO2Parse(t);
  assert.equal(r.tarife.length, 2);
  assert.equal(r.tarife[0].name, 'O2 Mobile L (2026)');
});

test('Summen nur im Kostenblock unten: einmalig und monatlich bleiben getrennt', () => {
  const r = X.psO2Parse('Einmalige Kosten 2.468,98 €\nMonatliche Kosten 69,98 €\nAktuell');
  assert.equal(r.einmalig, '2.468,98');
  assert.equal(r.monatlich, '69,98');
});

test('Summen stimmen nicht -> Pruefung schlaegt an, gelesene Summe bleibt', () => {
  const r = X.psO2Parse(BELEG.replace('69,98', '79,98'));
  assert.equal(r.monatlich, '79,98');
  const c = X.psO2Check(r);
  assert.equal(c.m.ok, false);
  assert.ok(X.psO2Gaps(r, BELEG).includes('summen'));
});

test('Tarif ohne Monatspreis: "unvollstaendig", nicht "falsch"', () => {
  const r = X.psO2Parse(BELEG);
  r.tarife[1].am = ['39,99', null];
  const c = X.psO2Check(r);
  assert.equal(c.m.ok, false);
  assert.equal(c.m.incomplete, true);
  assert.equal(r.monatlich, '69,98', 'gelesene Summe wird nie durch eine berechnete ersetzt');
});

test('Summe fehlt, Einzelpreise komplett -> nur Vorschlag, nie automatisch', () => {
  const r = X.psO2Parse(BELEG.replace(/Einmalige Kosten.*\n/, '').replace(/Monatliche Kosten.*\n/, ''));
  assert.equal(r.einmalig, '');
  assert.equal(r.monatlich, '');
  const s = X.psO2Suggest(r);
  assert.deepEqual(plain(s), { einmalig: [246898], monatlich: [6998] });
});

test('Verdict: kein Text / Text ohne Zuordnung / technische Fehler unterscheiden sich', () => {
  const empty = { tarife: [], geraete: [], internet: [], einmalig: '', monatlich: '' };
  assert.equal(X.psO2Verdict(empty, { txt: '  | |  ' }).kind, 'notext');
  assert.equal(X.psO2Verdict(empty, { txt: 'Dies ist irgendein anderer Text ohne Bezug zum Vorschlag' }).kind, 'nopos');
  assert.equal(X.psO2Verdict(empty, { fail: 'timeout' }).kind, 'fail');
  assert.match(X.psO2Verdict(empty, { fail: 'timeout' }).msg, /zu lange/);
  assert.match(X.psO2Verdict(empty, { fail: 'engine' }).msg, /nicht verfügbar/);
  assert.match(X.psO2Verdict(empty, { fail: 'image' }).msg, /Foto konnte nicht geöffnet/);
  assert.equal(X.psO2Verdict(empty, { cancelled: true }).kind, 'cancelled');
});

test('Verdict: "Nichts erkannt" kommt nie, wenn etwas erkannt wurde', () => {
  const r = X.psO2Parse(BELEG);
  const v = X.psO2Verdict(r, { txt: BELEG });
  assert.equal(v.kind, 'ok');
  assert.match(v.msg, /^✓ Erkennung abgeschlossen: 2 Tarife, 1 Handy/);
  const onlyT = { ...r, einmalig: '', monatlich: '', geraete: [] };
  const v2 = X.psO2Verdict(onlyT, { txt: BELEG });
  assert.equal(v2.kind, 'partial');
  assert.match(v2.msg, /^2 Tarife erkannt\. Gesamtkosten konnten nicht sicher zugeordnet werden/);
  assert.doesNotMatch(v2.msg, /Nichts erkannt/);
});

test('Verdict: nur eine der beiden Summen / Einzelpreis fehlt / Summen passen nicht', () => {
  const r = X.psO2Parse(BELEG);
  assert.match(X.psO2Verdict({ ...r, monatlich: '' }, { txt: BELEG }).msg, /Nur die einmaligen Gesamtkosten/);
  assert.match(X.psO2Verdict({ ...r, einmalig: '' }, { txt: BELEG }).msg, /Nur die monatlichen Gesamtkosten/);
  const inc = X.psO2Parse(BELEG); inc.tarife[1].am = ['39,99', null];
  const v = X.psO2Verdict(inc, { txt: BELEG });
  assert.equal(v.kind, 'check');
  assert.match(v.msg, /Einige Angaben benötigen eine Kontrolle/);
  const bad = X.psO2Verdict(X.psO2Parse(BELEG.replace('69,98', '79,98')), { txt: BELEG });
  assert.equal(bad.kind, 'check');
});

test('Combine: ein spaeterer schwacher Durchgang loescht nichts', () => {
  const good = X.psO2Parse(BELEG);
  const weak = X.psO2Parse('HANDY\nApple iPhone 18 Pro 1TB, Burgunder 2.389,00 €\nEinmalige Kosten 2.468,98 €');
  const c = X.psO2Combine([good, weak]);
  assert.equal(c.tarife.length, 2);
  assert.equal(c.geraete.length, 1);
  assert.equal(c.einmalig, '2.468,98');
  assert.equal(c.monatlich, '69,98');
  const rev = X.psO2Combine([weak, good]);
  assert.equal(rev.tarife.length, 2);
  assert.equal(rev.monatlich, '69,98');
});

test('Combine: fehlender Preis wird aus anderem Durchgang ergaenzt, nichts doppelt', () => {
  const a = X.psO2Parse(BELEG); a.tarife[1].am = ['39,99', null];
  const b = X.psO2Parse(BELEG);
  const c = X.psO2Combine([a, b]);
  assert.equal(c.tarife.length, 2);
  assert.deepEqual(plain(c.tarife[1].am), ['39,99', '34,99']);
  assert.equal(c.geraete.length, 1);
});

test('Summe mit genau einer falsch gelesenen Ziffer wird nicht übernommen (leer statt falsch)', () => {
  const ok = X.psO2Parse(BELEG);
  assert.deepEqual([...X.psO2TotalsDigitSlip(ok)], [], 'korrekte Summen bleiben');
  const slip = X.psO2Parse(BELEG.replace('2.468,98', '2.468,96'));
  assert.equal(slip.einmalig, '2.468,96');
  assert.deepEqual([...X.psO2TotalsDigitSlip(slip)], ['einmalig']);
  const m = X.psO2Parse(BELEG.replace(/69,98(?![\d])/g, '69,93'));
  if (m.monatlich === '69,93') assert.deepEqual([...X.psO2TotalsDigitSlip(m)], ['monatlich']);
  const far = X.psO2Parse(BELEG.replace('2.468,98', '3.999,00'));
  assert.deepEqual([...X.psO2TotalsDigitSlip(far)], [], 'größere Abweichung (z. B. fehlende Position) → bisherige Warnung, kein Leeren');
});

// Angebot B (Rabatte, Internet), Angebotskennzeichen, Dienst-Anfrage (Timeout, Abbruch, verspaetete Antwort)
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadOcr, BELEG, BELEG_B, CLOUD_A, CLOUD_B, plain } from './helpers.mjs';

const X = loadOcr();

test('Angebot B: Internet + Handy + Tarif mit Plus-Rabatt ergeben 2.438,98 / 69,98', () => {
  const r = X.psO2Parse(BELEG_B);
  assert.equal(r.einmalig, '2.438,98');
  assert.equal(r.monatlich, '69,98');
  assert.equal(r.internet.length, 1);
  assert.equal(r.tarife.length, 1, '"Aktuell"-Zeile (O2 Mobile S 2020) gehoert nicht zum Angebot');
  assert.equal(r.geraete.length, 1);
  const c = X.psO2Check(r);
  assert.ok(c.e.ok && c.m.ok, JSON.stringify(c));
});

test('Angebot B: Rabatt auf Anschlusspreis (-40 €) steckt schon in 9,99 € und wird nicht nochmal abgezogen', () => {
  const r = X.psO2Parse(BELEG_B);
  assert.deepEqual(plain(r.internet[0].am), ['9,99', '54,99']);
  const c = X.psO2Check(r);
  assert.ok(c.e.calc.includes(243898), 'Einmalig: 2.389,00 + 39,99 + 9,99 = 2.438,98: ' + JSON.stringify(c.e.calc));
  assert.ok(c.m.calc.includes(6998), 'Monatlich: 54,99 + 29,99 - 15,00 = 69,98: ' + JSON.stringify(c.m.calc));
});

test('"Ersparnis 400,00 €" ist keine zusaetzliche Kostenposition', () => {
  const r = X.psO2Parse(BELEG_B);
  assert.notEqual(r.einmalig, '400,00');
  assert.notEqual(r.monatlich, '400,00');
  [].concat(r.tarife, r.geraete, r.internet).forEach(i => assert.ok(!(i.am || []).includes('400,00')));
});

test('Verdict fuer Angebot B und A: vollstaendig, Summen stimmen', () => {
  for (const t of [BELEG, BELEG_B]) {
    const v = X.psO2Verdict(X.psO2Parse(t), { txt: t });
    assert.equal(v.kind, 'ok', v.msg);
    assert.match(v.msg, /Summen stimmen/);
  }
});

test('Zeitstempel/Kennzeichen: Schreibweisen der Texterkennung und Vergleich', () => {
  assert.equal(X.psO2OfferTs('23112026 17:15. Dieser Vorschlag'), '23.11.2026 17:15');
  assert.equal(X.psO2OfferTs('23.11.2026 17:15'), '23.11.2026 17:15');
  assert.equal(X.psO2OfferTs('kein Datum'), '');
  assert.equal(X.psO2OfferCmp({ id: '4711', ts: '' }, { id: '4711', ts: '' }), 'same');
  assert.equal(X.psO2OfferCmp({ id: '4711', ts: '' }, { id: '4712', ts: '' }), 'other');
  assert.equal(X.psO2OfferCmp({ id: '', ts: '23.11.2026 17:15' }, { id: '', ts: '23.11.2026 18:02' }), 'other');
  assert.equal(X.psO2OfferCmp({ id: '4711', ts: '23.11.2026 17:15' }, { id: '4799', ts: '23.11.2026 17:15' }), 'same', 'ID verlesen, Zeit gleich -> dasselbe Angebot');
  assert.equal(X.psO2OfferCmp({ id: '', ts: '' }, { id: '4711', ts: '' }), 'unknown');
});

test('Preise werden nur ergaenzt, nie ueberschrieben', () => {
  assert.deepEqual(plain(X.psO2FillAm(['39,99', null], ['1,00', '34,99'])), ['39,99', '34,99']);
  assert.equal(X.psO2FillAm(['39,99', '34,99'], ['1,00', '2,00'])[1], '34,99');
  assert.equal(X.psO2FillAm(null, ['1,00', null])[0], '1,00');
});

test('Dienst-Antwort: readable, Kennzeichen, gleiche Tarife getrennt, Rabatt als Rabatt', () => {
  const a = X.psO2CloudShape(CLOUD_A.data);
  assert.equal(a.tarife.length, 2);
  assert.equal(a.offerTs, '23.11.2026 17:15');
  assert.equal(a.beratungsId, '4711');
  const b = X.psO2CloudShape(CLOUD_B.data);
  assert.equal(b.tarife[0].rb.m, -1500);
  assert.ok(b.internet[0].rb.e === 0, 'kein zweiter Rabattabzug beim Internet-Anschlusspreis');
  assert.ok(X.psO2Check(b).e.ok && X.psO2Check(b).m.ok);
  assert.ok(X.psO2Check(a).e.ok && X.psO2Check(a).m.ok);
});

const mkFetch = (spec, st) => (url, init) => new Promise((resolve, reject) => {
  st.calls = (st.calls || 0) + 1;
  init.signal.addEventListener('abort', () => { st.aborted = true; reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })); });
  if (spec.never) return;
  setTimeout(() => { if (st.aborted) return; st.delivered = true; resolve({ ok: (spec.status || 200) < 300, status: spec.status || 200, json: async () => spec.body }); }, spec.delay || 0);
});
function setup(spec, cloudMs = 600) {
  const Y = loadOcr(), st = {};
  Y.peek('PS_O2_T.cloud = ' + cloudMs);
  Y.peek('psO2CloudImage = async () => "AAAA"');
  Y.setFetch(mkFetch(spec, st));
  return { Y, st };
}

test('Dienst haengt: Zeitlimit, Anfrage wird abgebrochen (kein 60-s-Warten)', async () => {
  const { Y, st } = setup({ never: true }, 400);
  const t0 = Date.now();
  await assert.rejects(Y.psO2CloudRead({}, null, {}), e => e.psKind === 'timeout');
  assert.ok(Date.now() - t0 < 1500);
  assert.equal(st.aborted, true);
});

test('Abbruch durch den Benutzer bricht die Anfrage sofort ab', async () => {
  const { Y, st } = setup({ never: true }, 5000);
  const job = Y.psO2NewJob();
  const p = Y.psO2CloudRead({}, null, { job });
  await new Promise(r => setTimeout(r, 100));
  const t0 = Date.now(); job.cancel('user');
  await assert.rejects(p, e => e.psCancel === true);
  assert.ok(Date.now() - t0 < 300);
  assert.equal(st.aborted, true);
});

test('Verspaetete Antwort nach Timeout aendert nichts mehr', async () => {
  const { Y, st } = setup({ delay: 700, body: CLOUD_A }, 300);
  await assert.rejects(Y.psO2CloudRead({}, null, {}), e => e.psKind === 'timeout');
  await new Promise(r => setTimeout(r, 900));
  assert.notEqual(st.delivered, true, 'abgebrochene Anfrage wird gar nicht erst beantwortet');
});

test('Erfolg: Antwort wird in Eintraege umgewandelt', async () => {
  const { Y } = setup({ delay: 50, body: CLOUD_B }, 2000);
  const r = await Y.psO2CloudRead({}, null, {});
  assert.equal(r.internet.length + r.tarife.length + r.geraete.length, 3);
  assert.equal(r.einmalig, '2.438,98');
});

test('Dienstfehler (HTTP 400/502) und fehlende Anmeldung sind klar unterscheidbar', async () => {
  for (const status of [400, 502]) {
    const { Y } = setup({ status, body: { ok: false } }, 2000);
    await assert.rejects(Y.psO2CloudRead({}, null, {}), e => e.psKind === 'service');
  }
  const Y = loadOcr(); Y.peek('window.__betaAuth = { currentUser: null }');
  await assert.rejects(Y.psO2CloudRead({}, null, {}), e => e.psKind === 'auth');
});

test('Verirrter Punkt hinter der Tarifgroesse wird entfernt (Mobile L. (2026))', () => {
  assert.equal(X.psO2CleanName('O2 Mobile L. (2026)', 'tarife'), 'O2 Mobile L (2026)');
  assert.equal(X.psO2CleanName('O2 Mobile M. Plus (2026)', 'tarife').includes('.'), true, 'nur direkt vor der Klammer');
});

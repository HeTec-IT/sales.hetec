// Archiv-Ausgang (frontend/services/archive-queue.js) – reine Logik mit synthetischen Daten, ohne Browser/Netz.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
await import(pathToFileURL(path.join(ROOT, 'frontend/services/archive-queue.js')).href);
const Q = globalThis.PSArchivQueue;
const S = Q.STATUS;

const pdf = (n = 1200) => new Blob(['%PDF-1.4\n' + 'x'.repeat(n) + '\n%%EOF'], { type: 'application/pdf' });
function clock(start = Date.UTC(2026, 10, 27, 13, 0, 0)) { const c = { t: start }; c.now = () => c.t; c.adv = ms => { c.t += ms; }; return c; }
function rec(over = {}) {
  return {
    uid: 'uidA', email: 'a.test@hetec-gmbh.de', employeeName: 'Anna Test', shopId: 'aalen', type: 'angebot',
    fileName: Q.uniqueFileName('PENCIL_Mueller_Aalen_Angebot_2026-11-27.pdf', '1300abc'),
    subject: 'PENCIL|angebot|2026-11-27|Anna', agent: 'Anna', pdfBlob: pdf(), ...over
  };
}
// Archiv-Attrappe: "SharePoint" = Set der übergebenen Dateinamen (wahlweise verzögert)
function fakeArchive({ delayVerifies = 0, sendFails = 0, verifyAvailable = true } = {}) {
  const stored = new Set(); const sent = []; let verifies = 0, fails = sendFails;
  return {
    stored, sent,
    send: async r => { if (fails > 0) { fails--; return { ok: false, code: 'network' }; } sent.push(r.fileName); stored.add(Q.idOf(r.fileName)); return { ok: true }; },
    verify: async names => { verifies++; if (!verifyAvailable) return { available: false, found: new Set() }; if (verifies <= delayVerifies) return { available: true, found: new Set() }; return { available: true, found: new Set(names.map(Q.idOf).filter(n => stored.has(n))) }; }
  };
}

test('Dateiname: eindeutiges Kennzeichen hinter der Kennung, Flow-Positionen unverändert, idempotent', () => {
  const f = Q.uniqueFileName('PENCIL_Mueller_Aalen_Angebot_2026-11-27.pdf', '1415k7q');
  assert.equal(f, 'PENCIL_Mueller--1415k7q_Aalen_Angebot_2026-11-27.pdf');
  const parts = f.replace(/\.pdf$/, '').split('_');
  assert.deepEqual([parts[0], parts[2], parts[3], parts[4]], ['PENCIL', 'Aalen', 'Angebot', '2026-11-27'], 'Shop=[2], Typ=[3], Datum=[4] wie bisher');
  assert.equal(Q.uniqueFileName(f, 'zzzzzzz'), f, 'kein zweites Kennzeichen');
  assert.equal(Q.fileToken(f), '1415k7q');
  assert.equal(Q.fileToken('PENCIL_Mueller_Aalen_Angebot_2026-11-27.pdf'), '', 'alter Name ohne Kennzeichen');
  assert.equal(Q.baseFileName(f), 'PENCIL_Mueller_Aalen_Angebot_2026-11-27.pdf');
  assert.equal(Q.stripToken('017612345--1415k7q'), '017612345');
  assert.equal(Q.uniqueFileName('kein-pencil.pdf', 'abc1'), 'kein-pencil.pdf');
});

test('Kennzeichen/IDs: zwei Archivierungen gleicher Kunde, gleicher Tag, gleicher Shop → verschiedene Dateien', () => {
  const seen = new Set();
  for (let i = 0; i < 2000; i++) seen.add(Q.uniqueFileName('PENCIL_keinName_Aalen_Angebot_2026-11-27.pdf', Q.makeToken(Date.UTC(2026, 10, 27, 13, 0))));
  assert.ok(seen.size > 1900, 'Kollisionen innerhalb derselben Minute sehr selten: ' + seen.size);
  const ids = new Set(Array.from({ length: 5000 }, () => Q.makeArchiveId()));
  assert.equal(ids.size, 5000);
});

test('Lokales Datum: Monats- und Jahreswechsel (kein UTC-Versatz)', () => {
  assert.equal(Q.localDate(new Date(2026, 11, 31, 23, 59).getTime()), '2026-12-31');
  assert.equal(Q.localDate(new Date(2027, 0, 1, 0, 1).getTime()), '2027-01-01');
  assert.equal(Q.localDate(new Date(2026, 10, 30, 23, 30).getTime()), '2026-11-30');
  assert.equal(Q.localDate(new Date(2026, 11, 1, 0, 30).getTime()), '2026-12-01');
  assert.match(Q.makeToken(new Date(2027, 0, 1, 0, 5).getTime()), /^0005[0-9a-z]{3}$/);
});

test('Validierung vor dem Versand', () => {
  assert.deepEqual(Q.validate({ archiveId: 'x', ...rec() }), []);
  assert.ok(Q.validate({ archiveId: 'x', ...rec({ uid: '' }) }).includes('uid'));
  assert.ok(Q.validate({ archiveId: 'x', ...rec({ pdfBlob: null }) }).includes('pdf'));
  assert.ok(Q.validate({ archiveId: 'x', ...rec({ pdfBlob: new Blob(['x']) }) }).includes('pdfTooSmall'));
  assert.ok(Q.validate({ archiveId: 'x', ...rec({ subject: 'PENCIL|angebot|2026-11-27' }) }).includes('subject'));
  assert.ok(Q.validate({ archiveId: 'x', ...rec({ type: 'abschluss' }) }).includes('typeMismatch'));
  const abs = rec({ type: 'abschluss', subject: 'PENCIL|abschluss|2026-11-27|Anna', fileName: Q.uniqueFileName('PENCIL_keineNr_Aalen_Abschluss_2026-11-27.pdf', 'abcd123') });
  assert.ok(Q.validate({ archiveId: 'x', ...abs }).includes('abschlussOhneNummer'), 'keineNr mit Kennzeichen bleibt gesperrt');
  const abs2 = { ...abs, fileName: Q.uniqueFileName('PENCIL_017612345678_Aalen_Abschluss_2026-11-27.pdf', 'abcd123') };
  assert.deepEqual(Q.validate({ archiveId: 'x', ...abs2 }), []);
});

test('PDF-Prüfung (%PDF-Kopf)', async () => {
  assert.equal(await Q.isPdfBlob(pdf()), true);
  assert.equal(await Q.isPdfBlob(new Blob(['<html>'])), false);
  assert.equal(await Q.isPdfBlob(null), false);
});

test('1/2: Normale Archivierung → übergeben → erst nach Fund in SharePoint "erfolgreich"', async () => {
  const c = clock(); const q = Q.createQueue({ store: Q.memoryStore(), now: c.now, useLocks: false }); const fa = fakeArchive({ delayVerifies: 1 });
  const idx = [];
  const r = await q.create(rec());
  assert.equal(r.status, S.SENDING);
  const deps = { uid: 'uidA', online: () => true, send: fa.send, verify: fa.verify, recordIndex: async x => { idx.push([x.fileName, x.uid]); return true; } };
  const h = await q.sendNow(r.archiveId, deps);
  assert.equal(h.status, S.HANDED, 'übergeben ≠ erfolgreich');
  assert.deepEqual(idx, [[r.fileName, 'uidA']]);
  assert.equal((await q.verifyNow(r.archiveId, deps)).status, S.HANDED, 'noch nicht abgelegt');
  c.adv(61000);
  const events = [];
  await q.process({ ...deps, onEvent: e => events.push(e.type) });
  const v = await q.get(r.archiveId);
  assert.equal(v.status, S.VERIFIED);
  assert.equal(v.pdfBlob, null, 'PDF nach Bestätigung entfernt (Datenschutz)');
  assert.deepEqual(events, ['verified']);
  assert.equal(v.uid, 'uidA'); assert.equal(v.createdByUserId, 'uidA');
});

test('8: Benutzerwechsel während ausstehender Archivierung → Eigentümer bleibt A, Index mit uid A, keine Meldung an B', async () => {
  const c = clock(); const q = Q.createQueue({ store: Q.memoryStore(), now: c.now, useLocks: false }); const fa = fakeArchive();
  const r = await q.create(rec());
  await q.sendNow(r.archiveId, { uid: 'uidA', online: () => false, send: fa.send });
  assert.equal((await q.get(r.archiveId)).status, S.PENDING);
  // B meldet sich an; Hintergrundlauf unter B
  const idx = []; const events = [];
  c.adv(31000);
  await q.process({ uid: 'uidB', online: () => true, send: fa.send, verify: fa.verify, recordIndex: async x => { idx.push(x.uid); return true; }, onEvent: e => events.push(e) });
  const after = await q.get(r.archiveId);
  assert.equal(after.status, S.HANDED, 'nicht verloren: unter B übergeben');
  assert.equal(after.uid, 'uidA'); assert.equal(after.employeeName, 'Anna Test'); assert.equal(after.shopId, 'aalen');
  assert.deepEqual(idx, [], 'kein Index-Eintrag unter der Anmeldung von B');
  assert.deepEqual(events, [], 'B bekommt keine Meldungen zu A');
  // A meldet sich wieder an → Index mit uid A wird nachgeholt
  c.adv(61000);
  await q.process({ uid: 'uidA', online: () => true, send: fa.send, verify: fa.verify, recordIndex: async x => { idx.push(x.uid); return true; } });
  assert.deepEqual(idx, ['uidA'], 'Index mit uid des Eigentümers');
  assert.equal((await q.get(r.archiveId)).indexed, true);
  assert.deepEqual((await q.listForUser('uidB')).length, 0, 'B sieht A nicht');
  assert.deepEqual((await q.listForUser('uidA')).map(x => x.archiveId), [r.archiveId]);
  // Eigentümer ist unveränderlich
  await q.update(r.archiveId, { uid: 'uidB', shopId: 'crailsheim', fileName: 'x' });
  const g = await q.get(r.archiveId);
  assert.deepEqual([g.uid, g.shopId, g.fileName], ['uidA', 'aalen', r.fileName]);
});

test('9: Doppelklick → genau ein Eintrag, genau ein Versand', async () => {
  const q = Q.createQueue({ store: Q.memoryStore(), useLocks: false }); const fa = fakeArchive();
  const [a, b] = await Promise.all([q.create(rec()), q.create(rec())]);
  assert.equal((await q.all()).length, 1, 'gleichzeitiger Doppeltipp → genau ein Eintrag');
  assert.equal(b.duplicate, true);
  const r2 = await q.create(rec());
  assert.equal(r2.duplicate, true);
  const deps = { uid: 'uidA', online: () => true, send: fa.send };
  await q.sendNow(a.archiveId, deps); await q.sendNow(r2.archiveId, deps);
  assert.equal(fa.sent.length, 1, 'genau ein Versand');
});

test('10: mehrere Beratungen gleichzeitig → getrennte Einträge, alle bestätigt', async () => {
  const c = clock(); const q = Q.createQueue({ store: Q.memoryStore(), now: c.now, useLocks: false }); const fa = fakeArchive();
  const recs = await Promise.all(['Mueller', 'Meier', 'Schulz', 'keinName'].map((n, i) => q.create(rec({ fileName: Q.uniqueFileName(`PENCIL_${n}_Aalen_Angebot_2026-11-27.pdf`, 'tk' + i + 'xyz') }))));
  const deps = { uid: 'uidA', online: () => true, send: fa.send, verify: fa.verify };
  await Promise.all(recs.map(r => q.sendNow(r.archiveId, deps)));
  c.adv(61000); await q.process(deps);
  const all = await q.all();
  assert.equal(all.length, 4);
  assert.ok(all.every(x => x.status === S.VERIFIED));
  assert.equal(new Set(fa.sent).size, 4);
});

test('11: Netzunterbrechung → ausstehend, automatische Wiederholung mit Backoff, dann übergeben', async () => {
  const c = clock(); const q = Q.createQueue({ store: Q.memoryStore(), now: c.now, useLocks: false }); const fa = fakeArchive({ sendFails: 2 });
  const r = await q.create(rec());
  const deps = { uid: 'uidA', online: () => true, send: fa.send, verify: fa.verify };
  assert.equal((await q.sendNow(r.archiveId, deps)).status, S.PENDING);
  await q.process(deps); // Backoff 30 s noch nicht vorbei
  assert.equal((await q.get(r.archiveId)).pendingRetries, 1);
  c.adv(31000); await q.process(deps);
  assert.equal((await q.get(r.archiveId)).status, S.PENDING);
  c.adv(61000); await q.process(deps);
  assert.equal((await q.get(r.archiveId)).status, S.HANDED);
});

test('12/13: fehlerhafte Antwort / verzögerte Ablage → nach Frist erneut senden (gleicher Name), dann "fehlgeschlagen" – nie gelöscht', async () => {
  const c = clock(); const q = Q.createQueue({ store: Q.memoryStore(), now: c.now, useLocks: false });
  const sent = [];
  const deps = { uid: 'uidA', online: () => true, send: async r => { sent.push(r.fileName); return { ok: true }; }, verify: async () => ({ available: true, found: new Set() }) };
  const r = await q.create(rec());
  await q.sendNow(r.archiveId, deps);
  for (let i = 0; i < 80; i++) { c.adv(61000); await q.process(deps); }
  const f = await q.get(r.archiveId);
  assert.equal(f.status, S.FAILED);
  assert.equal(sent.length, 3, 'Erstversand + 2 Wiederholungen');
  assert.equal(new Set(sent).size, 1, 'immer derselbe Dateiname → keine Dubletten');
  assert.ok(f.pdfBlob, 'PDF bleibt für manuelle Wiederholung erhalten');
  for (let i = 0; i < 10; i++) { c.adv(86400000); await q.process(deps); }
  assert.ok(await q.get(r.archiveId), 'fehlgeschlagene Archivierung wird nie automatisch gelöscht');
});

test('20: Wiederherstellung einer fehlgeschlagenen Archivierung (nur Eigentümer/Admin)', async () => {
  const c = clock(); const q = Q.createQueue({ store: Q.memoryStore(), now: c.now, useLocks: false }); const fa = fakeArchive();
  const r = await q.create(rec());
  await q.update(r.archiveId, { status: S.FAILED, sends: 3 });
  await assert.rejects(q.retry(r.archiveId, { uid: 'uidB' }), /forbidden/);
  await q.retry(r.archiveId, { uid: 'uidA' });
  await q.process({ uid: 'uidA', online: () => true, send: fa.send, verify: fa.verify });
  assert.equal((await q.get(r.archiveId)).status, S.HANDED);
  c.adv(61000); await q.process({ uid: 'uidA', online: () => true, send: fa.send, verify: fa.verify });
  assert.equal((await q.get(r.archiveId)).status, S.VERIFIED);
  // Admin darf fremden Eintrag erneut senden/verwerfen
  const r2 = await q.create(rec({ fileName: Q.uniqueFileName('PENCIL_X_Aalen_Angebot_2026-11-27.pdf', 'adm1abc') }));
  await q.update(r2.archiveId, { status: S.FAILED });
  await q.retry(r2.archiveId, { uid: 'admin', isAdmin: true });
  await assert.rejects(q.discard(r2.archiveId, { uid: 'uidB' }), /forbidden/);
  assert.equal(await q.discard(r2.archiveId, { uid: 'admin', isAdmin: true }), true);
  assert.ok(Q.readLog().some(l => l.step === 'discard' && l.code === 'admin'), 'Verwerfen wird protokolliert');
});

test('14: Validierungsfehler (z. B. PDF-Erstellung fehlgeschlagen) → kein Versand, sichtbar fehlgeschlagen', async () => {
  const q = Q.createQueue({ store: Q.memoryStore(), useLocks: false }); const fa = fakeArchive();
  const r = await q.create(rec({ pdfBlob: new Blob(['kaputt']) }));
  const out = await q.sendNow(r.archiveId, { uid: 'uidA', online: () => true, send: fa.send });
  assert.equal(out.status, S.FAILED);
  assert.match(out.lastError, /pdfTooSmall/);
  assert.equal(fa.sent.length, 0);
});

test('15: Absturz während "läuft" → nach 3 Min. automatisch erneut', async () => {
  const c = clock(); const q = Q.createQueue({ store: Q.memoryStore(), now: c.now, useLocks: false }); const fa = fakeArchive();
  const r = await q.create(rec());
  await q.process({ uid: 'uidA', online: () => true, send: fa.send });
  assert.equal(fa.sent.length, 0, 'frischer Eintrag (gerade im Versand) wird nicht doppelt gesendet');
  c.adv(3 * 60000 + 1000);
  await q.process({ uid: 'uidA', online: () => true, send: fa.send });
  assert.equal((await q.get(r.archiveId)).status, S.HANDED);
});

test('Prüfdienst nicht verfügbar → bleibt "wird überprüft" (kein Schein-Erfolg, kein Neuversand), PDF max. 7 Tage', async () => {
  const c = clock(); const q = Q.createQueue({ store: Q.memoryStore(), now: c.now, useLocks: false }); const fa = fakeArchive({ verifyAvailable: false });
  const r = await q.create(rec());
  const deps = { uid: 'uidA', online: () => true, send: fa.send, verify: fa.verify };
  await q.sendNow(r.archiveId, deps);
  for (let i = 0; i < 30; i++) { c.adv(61000); await q.process(deps); }
  let x = await q.get(r.archiveId);
  assert.equal(x.status, S.HANDED); assert.equal(fa.sent.length, 1); assert.ok(x.pdfBlob);
  c.adv(8 * 86400000); await q.process(deps);
  x = await q.get(r.archiveId);
  assert.equal(x.status, S.HANDED); assert.equal(x.pdfBlob, null); assert.equal(x.pdfRemoved, true);
});

test('Bestätigte Einträge: Metadaten 31 Tage, danach entfernt', async () => {
  const c = clock(); const q = Q.createQueue({ store: Q.memoryStore(), now: c.now, useLocks: false }); const fa = fakeArchive();
  const r = await q.create(rec());
  const deps = { uid: 'uidA', online: () => true, send: fa.send, verify: fa.verify };
  await q.sendNow(r.archiveId, deps); c.adv(61000); await q.process(deps);
  c.adv(30 * 86400000); await q.process(deps);
  assert.ok(await q.get(r.archiveId));
  c.adv(2 * 86400000); await q.process(deps);
  assert.equal(await q.get(r.archiveId), undefined);
});

test('Index nachholen: Firestore beim Archivieren nicht erreichbar → später mit uid des Eigentümers', async () => {
  const c = clock(); const q = Q.createQueue({ store: Q.memoryStore(), now: c.now, useLocks: false }); const fa = fakeArchive({ delayVerifies: 99 });
  let up = false; const idx = [];
  const deps = { uid: 'uidA', online: () => true, send: fa.send, verify: fa.verify, recordIndex: async x => { if (!up) return false; idx.push(x.uid); return true; } };
  const r = await q.create(rec());
  await q.sendNow(r.archiveId, deps);
  assert.equal((await q.get(r.archiveId)).indexed, undefined);
  up = true; c.adv(61000); await q.process(deps);
  assert.equal((await q.get(r.archiveId)).indexed, true);
  assert.deepEqual(idx, ['uidA']);
  // B nimmt keinen Index für A vor (Rechte/Zuordnung)
  const r2 = await q.create(rec({ fileName: Q.uniqueFileName('PENCIL_Z_Aalen_Angebot_2026-11-27.pdf', 'idx2abc') }));
  await q.update(r2.archiveId, { status: S.HANDED, handedAt: c.now() });
  const idxB = [];
  await q.process({ ...deps, uid: 'uidB', recordIndex: async x => { idxB.push(x.uid); return true; } });
  assert.deepEqual(idxB, []);
});

test('Protokoll ohne Kundendaten', async () => {
  const q = Q.createQueue({ store: Q.memoryStore(), useLocks: false });
  await q.create(rec());
  const json = JSON.stringify(Q.readLog());
  assert.ok(!/Mueller|Anna Test|a\.test@/.test(json), 'kein Kundenname, kein Mitarbeitername, keine E-Mail');
  assert.ok(Q.readLog().every(l => 'archiveId' in l && 'uid' in l && 'step' in l && 'status' in l && 'attempt' in l));
});

test('17: Normalisierung alter und neuer Index-Einträge', () => {
  const alt = Q.normalizeIndexEntry({ fileName: 'PENCIL_Mueller_Aalen_Angebot_2026-10-02.pdf', typ: 'angebot', shopId: 'Aalen', uid: 'u1', ts: '1759400000000' });
  assert.equal(alt.ts, 1759400000000); assert.equal(alt.shopId, 'aalen'); assert.equal(alt.legacyName, true);
  const neu = Q.normalizeIndexEntry({ fileName: 'PENCIL_Mueller--1300abc_Aalen_Angebot_2026-11-27.pdf', type: 'Abschluss', userUid: 'u2', ts: { toMillis: () => 5 } });
  assert.deepEqual([neu.typ, neu.uid, neu.ts, neu.token, neu.legacyName], ['abschluss', 'u2', 5, '1300abc', false]);
  const ohneTs = Q.normalizeIndexEntry({ fileName: 'PENCIL_A_Aalen_Angebot_2026-11-01.pdf', datum: '2026-11-01' });
  assert.ok(ohneTs.ts > 0);
});

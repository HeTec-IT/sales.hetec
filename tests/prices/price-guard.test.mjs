// Schutz der automatischen Preisaktualisierung: Sprungprüfung mit Bestätigung, ungültige Daten überschreiben nichts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'price-'));
process.env.PS_PRICE_STATUS_DIR = path.join(tmp, 'status');
const { geschuetztSchreiben, spruenge } = await import('../../scripts/lib/price-guard.mjs');
const file = path.join(tmp, 'netflix-preise.json');
const daten = p => ({ quelle: 'x', geprueft: '01.01.2027', tarife: [{ id: 'werbung', preis: p[0] }, { id: 'standard', preis: p[1] }, { id: 'premium', preis: p[2] }] });

test('normale Änderung wird sofort übernommen, Status protokolliert', async () => {
  fs.writeFileSync(file, JSON.stringify(daten([6.99, 15.99, 21.99])));
  const r = await geschuetztSchreiben(file, daten([7.99, 15.99, 21.99]), { name: 'netflix-preise.json' });
  assert.equal(r.geschrieben, true);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).tarife[0].preis, 7.99);
  const st = JSON.parse(fs.readFileSync(path.join(tmp, 'status', 'netflix-preise.json'), 'utf8'));
  assert.ok(st.letzterErfolg && st.ergebnis === 'aktualisiert');
});

test('Preissprung (> 40 %) erst nach Bestätigung im zweiten Lauf; bis dahin bleibt der alte Wert', async () => {
  const r1 = await geschuetztSchreiben(file, daten([7.99, 1.59, 21.99]), { name: 'netflix-preise.json' });
  assert.equal(r1.geschrieben, false);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).tarife[1].preis, 15.99, 'alter Wert bleibt');
  const r2 = await geschuetztSchreiben(file, daten([7.99, 1.59, 21.99]), { name: 'netflix-preise.json' });
  assert.equal(r2.geschrieben, true);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).tarife[1].preis, 1.59);
});

test('Prüffunktion schlägt fehl → nichts wird überschrieben', async () => {
  const vorher = fs.readFileSync(file, 'utf8');
  const r = await geschuetztSchreiben(file, daten([1, 2, 3]), { name: 'netflix-preise.json', pruefe: () => { throw new Error('unplausibel'); } });
  assert.equal(r.geschrieben, false);
  assert.equal(fs.readFileSync(file, 'utf8'), vorher);
});

test('Sprungerkennung: Preisfelder ja, Zähler (Monate, GB) nein', () => {
  assert.equal(spruenge({ preise: { s: 10, monate: 6 } }, { preise: { s: 10, monate: 24 } }).length, 0);
  assert.equal(spruenge({ preise: { s: 10 } }, { preise: { s: 20 } }).length, 1);
});

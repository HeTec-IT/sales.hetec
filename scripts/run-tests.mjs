// Führt alle automatisierten Tests aus und schreibt eine Zusammenfassung (tests/.out/test-summary.json).
//   npm test                 alles (benötigt PHP + MariaDB für Backend/E2E, Playwright-Browser für Browser-Tests)
//   npm test -- --quick      ohne Browser-Tests mit echter OCR (schneller)
// Fehlgeschlagene Tests werden nie übersprungen; fehlt eine Voraussetzung, wird die Suite als „nicht ausgeführt“ gemeldet.
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const quick = process.argv.includes('--quick');
const has = (cmd, args = ['--version']) => { try { execFileSync(cmd, args, { stdio: 'ignore' }); return true; } catch { return false; } };
const php = has('php', ['-r', 'exit(extension_loaded("pdo_mysql") && extension_loaded("sodium") ? 0 : 1);']);
let pw = false;
try { await import('playwright'); pw = true; } catch {}

const suites = [
  { name: 'OCR-Logik (Parser, Engine, Mehrseiten, Smart Scan)', files: ['tests/ocr/*.test.mjs', 'scripts/test-smart-scan.mjs'] },
  { name: 'Preisdaten + Preis-Schutz', files: ['tests/prices/*.test.mjs'] },
  { name: 'Backend-API, Auth (Entra-Mock), Rechte, Statistik', files: ['tests/backend/*.test.mjs'], need: php && 'PHP+MariaDB', serial: true },
  { name: 'Firestore-Migration (synthetisch)', files: ['tests/migration/*.test.mjs'], need: php && 'PHP+MariaDB', serial: true },
  { name: 'Release-Artefakt', files: ['tests/release/*.test.mjs'], need: php && 'PHP' },
  { name: 'Browser: Smart-Scan-Dialog (12 Abläufe)', files: ['tests/e2e/smart-scan-dialog.test.mjs'], need: pw && 'Playwright' },
  { name: 'Browser: echte lokale OCR – Tesseract', files: ['tests/e2e/ocr-real.test.mjs'], need: pw && !quick && 'Playwright', env: { PS_OCR_ENGINES: 'tesseract' } },
  { name: 'Browser: echte lokale OCR – PaddleOCR/ONNX', files: ['tests/e2e/ocr-real.test.mjs'], need: pw && !quick && 'Playwright', env: { PS_OCR_ENGINES: 'neural' } },
  { name: 'Browser: Firebase-Betrieb (GitHub-Pages-Beta, Firebase-Testersatz)', files: ['tests/e2e/firebase-mode.test.mjs'], need: pw && 'Playwright', serial: true },
  { name: 'Browser: Verwaltung (admin/)', files: ['tests/e2e/admin.test.mjs'], need: pw && php && 'Playwright+PHP', serial: true },
  { name: 'Browser: Release Ende-zu-Ende (Login, Offline, Sync, Update, CSP)', files: ['tests/e2e/app-release.test.mjs'], need: pw && php && 'Playwright+PHP', serial: true, prepare: 'release' },
];

const glob = p => {
  if (!p.includes('*')) return [p];
  const dir = path.dirname(p), re = new RegExp('^' + path.basename(p).replace('.', '\\.').replace('*', '.*') + '$');
  return fs.readdirSync(path.join(ROOT, dir)).filter(f => re.test(f)).map(f => path.join(dir, f));
};
const results = [];
// Hängende Suite (z. B. offener Browser) darf den Gesamtlauf nicht blockieren → nach Frist abbrechen und als Fehler werten
const SUITE_TIMEOUT_MS = Number(process.env.PS_SUITE_TIMEOUT_MS || 25 * 60 * 1000);
for (const s of suites) {
  if (s.need === false || s.need === '' || s.need === 0) {
    results.push({ suite: s.name, status: 'nicht ausgeführt', reason: 'Voraussetzung fehlt', pass: 0, fail: 0, skipped: 0 });
    console.log(`⏭  ${s.name}: nicht ausgeführt (Voraussetzung fehlt)`);
    continue;
  }
  if (s.prepare === 'release') execFileSync(process.execPath, [path.join(ROOT, 'scripts/build-release.mjs')], { stdio: 'inherit' });
  const files = s.files.flatMap(glob);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, ['--test', ...(s.serial ? ['--test-concurrency=1'] : []), ...files], { cwd: ROOT, env: { ...process.env, ...(s.env || {}) }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: SUITE_TIMEOUT_MS, killSignal: 'SIGKILL' });
  const out = (r.stdout || '') + (r.stderr || '');
  const num = k => Number((out.match(new RegExp('^# ' + k + ' (\\d+)', 'm')) || [])[1] || 0);
  const res = { suite: s.name, pass: num('pass'), fail: num('fail'), skipped: num('skipped') + num('todo'), cancelled: num('cancelled'), seconds: Math.round((Date.now() - t0) / 1000) };
  if (r.error && r.error.code === 'ETIMEDOUT') { res.timedOut = true; res.fail = res.fail || 1; }
  res.status = res.fail || res.cancelled || r.status ? 'fehlgeschlagen' : 'bestanden';
  if (res.status !== 'bestanden') res.failures = out.split('\n').filter(l => /^not ok|^\s+error:/.test(l)).slice(0, 30);
  results.push(res);
  console.log(`${res.status === 'bestanden' ? '✅' : '❌'} ${s.name}: ${res.pass} bestanden, ${res.fail} fehlgeschlagen, ${res.skipped} übersprungen (${res.seconds} s)`);
  if (res.timedOut) console.log('   Abgebrochen: Zeitlimit ' + Math.round(SUITE_TIMEOUT_MS / 60000) + ' min überschritten');
  if (res.failures) console.log(res.failures.join('\n'));
}
const total = results.reduce((a, r) => ({ pass: a.pass + r.pass, fail: a.fail + r.fail, skipped: a.skipped + r.skipped }), { pass: 0, fail: 0, skipped: 0 });
const notRun = results.filter(r => r.status === 'nicht ausgeführt').length;
fs.mkdirSync(path.join(ROOT, 'tests/.out'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'tests/.out/test-summary.json'), JSON.stringify({ at: new Date().toISOString(), node: process.version, total, notRunSuites: notRun, results }, null, 2));
console.log(`\nGesamt: ${total.pass} bestanden, ${total.fail} fehlgeschlagen, ${total.skipped} übersprungen, ${notRun} Suite(s) nicht ausgeführt`);
process.exit(total.fail || results.some(r => r.status === 'fehlgeschlagen') ? 1 : 0);

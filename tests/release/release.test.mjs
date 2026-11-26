// Release-Artefakt: Struktur, Trennung öffentlich/geschützt, keine Altlasten, Test-Login technisch ausgeschlossen.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-rel-'));
const R = path.join(OUT, `pencil-selling-${pkg.version}`);
const walk = (d, o = []) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); fs.statSync(p).isDirectory() ? walk(p, o) : o.push(path.relative(R, p).split(path.sep).join('/')); } return o; };
let files = [];
before(() => { execFileSync(process.execPath, [path.join(ROOT, 'scripts/build-release.mjs'), '--out=' + OUT], { stdio: 'pipe' }); files = walk(R); });

test('Struktur: Webroot public/, Backend/Config/Storage außerhalb', () => {
  for (const f of ['public/index.html', 'public/sw.js', 'public/sw-manifest.js', 'public/.htaccess', 'public/api/index.php', 'public/api/.htaccess', 'public/manifest.webmanifest',
    'app/bootstrap.php', 'app/autoload.php', 'app/src/App.php', 'app/bin/migrate.php', 'app/config/config.php', 'config/config.example.php', 'storage/.htaccess', 'app-path.php', 'SHA256SUMS', 'RELEASE.json', 'deployment-guide.md']) {
    assert.ok(files.includes(f), f);
  }
  assert.ok(files.some(f => /^database\/schema-.*\.sql$/.test(f)));
  assert.ok(!files.some(f => f.startsWith('public/') && /\.php$/.test(f) && f !== 'public/api/index.php'), 'im Webroot nur der API-Einstieg als PHP');
});

test('Test-Login und Entwicklungswerkzeuge sind nicht enthalten', () => {
  assert.ok(!files.some(f => /(^|\/)dev\//.test(f)), 'kein dev/');
  assert.ok(!files.some(f => /DevAuthController|seed\.php|reset-db\.php|router\.php/.test(f)));
  assert.ok(!files.some(f => /\.py$/.test(f)), 'kein Python');
  assert.ok(!files.some(f => /(^|\/)(tests?|node_modules)\//.test(f) && !f.includes('third_party')));
  assert.ok(!files.some(f => /tools\/firestore-export|legacy\//.test(f)));
});

test('Kein Firebase-/Google-Code und keine CDNs im Zielsystem', () => {
  assert.ok(!files.includes('public/frontend/services/adapter-firebase.js'));
  assert.ok(!files.includes('public/frontend/services/download-page-firebase.js'));
  const html = fs.readFileSync(path.join(R, 'public/index.html'), 'utf8');
  assert.doesNotMatch(html, /adapter-firebase|gstatic|googleapis|cdn\.jsdelivr|cdnjs|cdn\.tailwindcss|unpkg/);
  assert.match(fs.readFileSync(path.join(R, 'public/frontend/config/app-config.js'), 'utf8'), /backend: 'hetec'/);
});

test('Alle lokalen Skripte/Styles in index.html haben einen Inhalts-Hash und stehen im Service-Worker-Manifest', () => {
  const html = fs.readFileSync(path.join(R, 'public/index.html'), 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="((?:frontend|vendor)\/[^"]+)"/g)].map(m => m[1]);
  assert.ok(refs.length > 20);
  assert.ok(refs.every(r => /\?v=[0-9a-f]{10}$/.test(r)), refs.filter(r => !/\?v=/.test(r)).join(', '));
  const man = fs.readFileSync(path.join(R, 'public/sw-manifest.js'), 'utf8');
  for (const r of refs) assert.ok(man.includes(JSON.stringify(r)), r);
});

test('Konfigurationsvorlage enthält nur Platzhalter, keine echte config.php', () => {
  const ex = fs.readFileSync(path.join(R, 'config/config.example.php'), 'utf8');
  assert.match(ex, /PLATZHALTER/);
  assert.ok(!files.includes('config/config.php'));
});

test('PHP-Dateien des Releases sind syntaktisch korrekt', () => {
  for (const f of files.filter(f => f.endsWith('.php') && !f.includes('third_party'))) execFileSync('php', ['-l', path.join(R, f)], { stdio: 'pipe' });
});

test('Prüfsummen stimmen', () => {
  const sums = fs.readFileSync(path.join(R, 'SHA256SUMS'), 'utf8').trim().split('\n');
  assert.equal(sums.length, files.length - 1);
});

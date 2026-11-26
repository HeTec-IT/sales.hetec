#!/usr/bin/env node
// Testversion für GitHub Pages in einem Unterordner (Firebase-Betrieb wie die Live-App, gleiche Anmeldung/Daten).
// Isoliert von der Live-App derselben Domain: eigene Cache-Namen, eigene PWA-Identität, sichtbarer Hinweis.
//   node scripts/build-preview.mjs <zielordner> [name]      z. B.  node scripts/build-preview.mjs ../main/test-57 test-57
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'preview'));
const NAME = process.argv[3] || path.basename(OUT);
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const TAG = NAME.replace(/[^a-z0-9]/gi, '').toLowerCase();   // z. B. test57

if (fs.existsSync(path.join(ROOT, 'frontend/config/app-config.js')) &&
    !/backend:\s*'firebase'/.test(fs.readFileSync(path.join(ROOT, 'frontend/config/app-config.js'), 'utf8'))) {
  throw new Error('Testversion nur im Firebase-Betrieb (Repo-Konfiguration)');
}
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
function copy(src, dst, filter = () => true) {
  if (!filter(src)) return;
  const st = fs.statSync(src);
  if (st.isDirectory()) { for (const f of fs.readdirSync(src)) copy(path.join(src, f), path.join(dst, f), filter); return; }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}
for (const d of ['frontend', 'vendor', path.join('ocr', 'generated'), 'bilder']) {
  if (fs.existsSync(path.join(ROOT, d))) copy(path.join(ROOT, d), path.join(OUT, d), s => !s.endsWith('.gitkeep') && !s.endsWith('tailwind.src.css'));
}
for (const f of fs.readdirSync(ROOT).filter(f => /-preise\.json$|^pixel-geraete\.json$|^tv-preise\.json$|^icon-\d+\.png$/.test(f))) copy(path.join(ROOT, f), path.join(OUT, f));

const must = (s, a, b, what) => { if (!s.includes(a)) throw new Error('Muster nicht gefunden (' + what + '): ' + a); return s.split(a).join(b); };

// Service Worker: eigene Cache-Namen → löscht nie die Caches der Live-App
let sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
sw = must(sw, "var PREFIX = 'ps-app-';", `var PREFIX = 'ps-${TAG}-app-';`, 'sw PREFIX');
sw = must(sw, "var LEGACY_PREFIX = 'pencil-o2-';", `var LEGACY_PREFIX = 'ps-${TAG}-legacy-';`, 'sw LEGACY');
sw = must(sw, "'ps-ocr-'", `'ps-${TAG}-ocr-'`, 'sw OCR');
fs.writeFileSync(path.join(OUT, 'sw.js'), sw);

let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
html = must(html, "var __PS_CACHE_PREFIX = 'pencil-o2-';", `var __PS_CACHE_PREFIX = 'ps-${TAG}-legacy-';`, 'Cache-Prefix');
html = must(html, "k.indexOf('ps-app-') === 0", `k.indexOf('ps-${TAG}-app-') === 0`, 'Hard-Reload');
const banner = `<div id="ps-preview-badge" style="position:fixed;left:8px;bottom:8px;z-index:2147483000;background:#f59e0b;color:#111;font:700 11px system-ui,sans-serif;padding:4px 8px;border-radius:6px;opacity:.9;pointer-events:none">TESTVERSION ${pkg.version} (${NAME})</div>`;
{ const i = html.lastIndexOf('</body>'); if (i < 0) throw new Error('</body> fehlt'); html = html.slice(0, i) + banner + '\n' + html.slice(i); }
fs.writeFileSync(path.join(OUT, 'index.html'), html);

const man = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.webmanifest'), 'utf8'));
Object.assign(man, { id: '/sales.hetec/' + NAME, name: 'Pencil Selling – TEST ' + pkg.version, short_name: 'Pencil TEST', start_url: '.', scope: '.' });
fs.writeFileSync(path.join(OUT, 'manifest.webmanifest'), JSON.stringify(man, null, 2) + '\n');
fs.writeFileSync(path.join(OUT, 'README.md'), `# Testversion ${pkg.version}\n\nAutomatisch erzeugt aus Branch feature/hetec-independent-architecture (scripts/build-preview.mjs).\nFirebase-Betrieb wie die Live-App. Ordner nach dem Test löschen.\n`);
console.log('Testversion ' + pkg.version + ' → ' + OUT);

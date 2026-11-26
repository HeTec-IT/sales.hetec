// Erzeugt das fertige Release-Artefakt für klassisches Webhosting (Hetzner, SFTP/FileZilla).
//   npm run release            → release/pencil-selling-<version>/  (+ .tar.gz, SHA256SUMS)
//
// Struktur (siehe docs/HETZNER-DEPLOYMENT.md):
//   public/        Document-Root der Domain ps.hetec.de (App, vendor, OCR, api/index.php, .htaccess)
//   app/           Backend-Code AUSSERHALB des Webroots (src, Bibliotheken, Migrationen, bin)
//   config/        config.example.php → als config.php befüllen (nie im Webroot!)
//   storage/       Laufzeitdaten (Downloads 24 h, Logs) – nicht öffentlich
//   database/      Migrationen als eine SQL-Datei (für phpMyAdmin, falls kein SSH)
//   app-path.php   sagt public/api/index.php, wo app/ liegt
//
// Garantien (werden am Ende geprüft, sonst Abbruch):
//   - kein Firebase-/Google-Code, kein Test-Login (backend/dev), keine Python-Dateien, keine Geheimnisse
//   - jede lokale Datei in index.html wird mit Inhalts-Hash adressiert (?v=…), Service Worker kennt alle Dateien
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = pkg.version;
const args = Object.fromEntries(process.argv.slice(2).map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
const OUT_BASE = path.resolve(ROOT, String(args.out || 'release'));
const OUT = path.join(OUT_BASE, `pencil-selling-${VERSION}`);
const PUB = path.join(OUT, 'public');
const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');
const rel = p => path.relative(OUT, p).split(path.sep).join('/');

function copy(src, dst, filter = () => true) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    for (const f of fs.readdirSync(src)) {
      const s = path.join(src, f);
      if (!filter(s)) continue;
      copy(s, path.join(dst, f), filter);
    }
    return;
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}
function walk(dir, out = []) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(PUB, { recursive: true });

// ── 1. Öffentliche Dateien ─────────────────────────────────────────────────
const EXCLUDE_FRONTEND = new Set(['frontend/services/adapter-firebase.js', 'frontend/services/download-page-firebase.js', 'frontend/styles/tailwind.src.css']);
copy(path.join(ROOT, 'frontend'), path.join(PUB, 'frontend'), s => !EXCLUDE_FRONTEND.has(path.relative(ROOT, s).split(path.sep).join('/')));
copy(path.join(ROOT, 'vendor'), path.join(PUB, 'vendor'));
copy(path.join(ROOT, 'ocr', 'generated'), path.join(PUB, 'ocr', 'generated'));
copy(path.join(ROOT, 'admin'), path.join(PUB, 'admin'));
for (const f of ['icon-192.png', 'icon-512.png', 'sw.js']) copy(path.join(ROOT, f), path.join(PUB, f));
for (const f of fs.readdirSync(ROOT).filter(f => /-preise\.json$|^pixel-geraete\.json$|^tv-preise\.json$/.test(f))) copy(path.join(ROOT, f), path.join(PUB, f));
copy(path.join(ROOT, 'backend', 'public', 'api'), path.join(PUB, 'api'));
copy(path.join(ROOT, 'deployment', 'htaccess', 'public.htaccess'), path.join(PUB, '.htaccess'));

// Laufzeitkonfiguration Zielsystem
fs.writeFileSync(path.join(PUB, 'frontend/config/app-config.js'),
  "/* Pencil Selling – Laufzeitkonfiguration (Release " + VERSION + ", erzeugt von scripts/build-release.mjs) */\n" +
  "window.PS_CONFIG = Object.freeze({ backend: 'hetec', apiBase: 'api/v1', allowExternalTranslation: false, allowExternalQr: false, iosServiceWorker: true });\n");

// Manifest für ps.hetec.de
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.webmanifest'), 'utf8'));
Object.assign(manifest, { id: '/', name: 'Pencil Selling', short_name: 'Pencil Selling', start_url: './', scope: './' });
fs.writeFileSync(path.join(PUB, 'manifest.webmanifest'), JSON.stringify(manifest, null, 2) + '\n');

// ── 2. index.html: Firebase-Skripte raus, Inhalts-Hashes rein ──────────────
let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const nl = html.includes('\r\n') ? '\r\n' : '\n';
for (const tag of ['<script src="frontend/services/adapter-firebase.js"></script>', '<script src="frontend/services/download-page-firebase.js"></script>']) {
  const lines = html.split(nl);
  const i = lines.findIndex(l => l.trim() === tag);
  if (i < 0 || lines.findIndex((l, j) => j > i && l.trim() === tag) >= 0) throw new Error('Skript-Tag nicht eindeutig: ' + tag);
  lines.splice(i, 1);
  html = lines.join(nl);
}
const hashed = new Map();
html = html.replace(/(<(?:script|link)\b[^>]*?\b(?:src|href)=")([^"?#:]+\.(?:js|css|webmanifest))(")/g, (m, a, url, b) => {
  const file = path.join(PUB, url);
  if (!fs.existsSync(file)) throw new Error('index.html verweist auf fehlende Datei: ' + url);
  const h = sha(fs.readFileSync(file)).slice(0, 10);
  hashed.set(url, h);
  return a + url + '?v=' + h + b;
});
html = html.replace(/window\.APP_VERSION = '[^']*';/, `window.APP_VERSION = '${VERSION}';`);
fs.writeFileSync(path.join(PUB, 'index.html'), html);

// ── 3. Service-Worker-Manifest (vollständige Dateiliste der Version) ──────
const precache = [];
for (const f of walk(PUB)) {
  const r = path.relative(PUB, f).split(path.sep).join('/');
  if (/^(api\/|\.htaccess$|sw\.js$|sw-manifest\.js$|admin\/)/.test(r)) continue;
  if (/^ocr\/generated\//.test(r)) continue;                 // eigener, versionierter OCR-Cache (groß, bei Bedarf)
  if (/(LICENSE|\.txt$|manifest\.json$)/.test(r) && r.startsWith('vendor/')) continue;
  const h = sha(fs.readFileSync(f)).slice(0, 10);
  precache.push({ url: hashed.has(r) ? r + '?v=' + hashed.get(r) : r, hash: h });
}
precache.push({ url: 'index.html', hash: sha(fs.readFileSync(path.join(PUB, 'index.html'))).slice(0, 10) });
const ocrFiles = walk(path.join(PUB, 'ocr', 'generated')).map(f => sha(fs.readFileSync(f))).sort().join('');
const swManifest = { version: VERSION + '-' + sha(JSON.stringify(precache)).slice(0, 8), ocrVersion: sha(ocrFiles).slice(0, 12), entry: 'index.html', files: precache };
fs.writeFileSync(path.join(PUB, 'sw-manifest.js'), '/* erzeugt von scripts/build-release.mjs */\nself.__PS_PRECACHE = ' + JSON.stringify(swManifest) + ';\n');
// sw.js mit Versionsstempel → Browser erkennen jede neue Version zuverlässig (byteweiser Vergleich)
fs.writeFileSync(path.join(PUB, 'sw.js'), `/* Release ${swManifest.version} */\n` + fs.readFileSync(path.join(PUB, 'sw.js'), 'utf8'));
fs.writeFileSync(path.join(PUB, 'version.json'), JSON.stringify({ version: VERSION, build: swManifest.version, builtAt: new Date().toISOString() }, null, 2) + '\n');

// ── 4. Backend außerhalb des Webroots ──────────────────────────────────────
const APP = path.join(OUT, 'app');
for (const d of ['src', 'third_party', 'migrations', 'bin']) copy(path.join(ROOT, 'backend', d), path.join(APP, d), s => !/[\\/](tests|docs?|examples?)[\\/]?$/.test(s));
for (const f of ['autoload.php', 'bootstrap.php']) copy(path.join(ROOT, 'backend', f), path.join(APP, f));
fs.writeFileSync(path.join(APP, '.htaccess'), 'Require all denied\n');
fs.mkdirSync(path.join(OUT, 'config'), { recursive: true });
copy(path.join(ROOT, 'backend', 'config', 'config.example.php'), path.join(OUT, 'config', 'config.example.php'));
fs.writeFileSync(path.join(OUT, 'config', '.htaccess'), 'Require all denied\n');
fs.mkdirSync(path.join(OUT, 'storage', 'downloads'), { recursive: true });
fs.writeFileSync(path.join(OUT, 'storage', '.htaccess'), 'Require all denied\n');
fs.writeFileSync(path.join(OUT, 'storage', 'README.txt'), 'Laufzeitdaten (Kunden-Downloads 24 h, verschlüsselt). Nicht öffentlich, nicht sichern müssen.\n');
fs.writeFileSync(path.join(OUT, 'app-path.php'), "<?php\n// Pfad zum Backend (app/) relativ zu dieser Datei. Bei abweichender Struktur hier anpassen.\nreturn __DIR__ . '/app';\n");
// config.php wird in app/config/ erwartet (Config::load) → Verweis auf ../config
fs.mkdirSync(path.join(APP, 'config'), { recursive: true });
fs.writeFileSync(path.join(APP, 'config', 'config.php'), "<?php\n// Lädt die eigentliche Konfiguration aus dem Verzeichnis config/ neben app/ (außerhalb des Webroots).\nreturn require dirname(__DIR__, 2) . '/config/config.php';\n");

// ── 5. Datenbank (alle Migrationen in einer Datei, für phpMyAdmin) ─────────
fs.mkdirSync(path.join(OUT, 'database'), { recursive: true });
const migs = fs.readdirSync(path.join(ROOT, 'backend', 'migrations')).filter(f => f.endsWith('.sql')).sort();
let allSql = '-- Pencil Selling ' + VERSION + ' – alle Migrationen. Bevorzugt: php app/bin/migrate.php (führt jede genau einmal aus).\n';
for (const m of migs) {
  const body = fs.readFileSync(path.join(ROOT, 'backend', 'migrations', m), 'utf8');
  allSql += `\n-- ===== ${m} =====\n` + body + `\nCREATE TABLE IF NOT EXISTS schema_migrations (version VARCHAR(190) NOT NULL PRIMARY KEY, checksum CHAR(64) NOT NULL, applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;\nINSERT IGNORE INTO schema_migrations (version, checksum) VALUES ('${m.replace(/\.sql$/, '')}', '${sha(body)}');\n`;
}
fs.writeFileSync(path.join(OUT, 'database', 'schema-' + VERSION + '.sql'), allSql);
copy(path.join(ROOT, 'docs', 'HETZNER-DEPLOYMENT.md'), path.join(OUT, 'deployment-guide.md'));

// ── 6. Prüfungen ───────────────────────────────────────────────────────────
const problems = [];
for (const f of walk(OUT)) {
  const r = rel(f);
  if (/\.py$/.test(r)) problems.push('Python-Datei: ' + r);
  if (/(^|\/)(dev|tests?)\//.test(r) && !/third_party/.test(r)) problems.push('Entwicklungs-/Testdatei: ' + r);
  if (/config\/config\.php$/.test(r) && !r.startsWith('app/')) problems.push('echte Konfiguration im Release: ' + r);
  if (/\.(js|mjs|html|php|json|css)$/.test(r) && !/^public\/(vendor|ocr)\//.test(r) && !/third_party/.test(r)) {
    const s = fs.readFileSync(f, 'utf8');
    // Abhängigkeiten (nicht bloße Erwähnungen in Kommentaren/Spaltennamen): SDK, Endpunkte, API-Schlüssel
    if (/gstatic\.com|googleapis\.com|firebaseio\.com|firebaseapp\.com|cloudfunctions\.net|AIzaSy|window\.firebase|firebase\.(initializeApp|firestore|auth)\b|mymemory\.translated|api\.qrserver\.com|cdn\.jsdelivr|cdnjs\.cloudflare|unpkg\.com|cdn\.tailwindcss/i.test(s)) problems.push('Firebase/Google/CDN-Abhängigkeit: ' + r);
    if (/DevAuthController|\/v1\/dev\/login/.test(s) && !/src\/App\.php$/.test(r)) problems.push('Test-Login-Bezug: ' + r);
    if (/-----BEGIN (RSA |EC )?PRIVATE KEY-----/.test(s)) problems.push('privater Schlüssel: ' + r);
  }
}
if (!fs.existsSync(path.join(PUB, 'api', 'index.php'))) problems.push('api/index.php fehlt');
if (problems.length) { console.error('Release-Prüfung fehlgeschlagen:\n - ' + problems.join('\n - ')); process.exit(1); }

// ── 7. Prüfsummen, Metadaten, Archiv ───────────────────────────────────────
const files = walk(OUT).filter(f => !f.endsWith('SHA256SUMS'));
fs.writeFileSync(path.join(OUT, 'SHA256SUMS'), files.map(f => sha(fs.readFileSync(f)) + '  ' + rel(f)).join('\n') + '\n');
let commit = '';
try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT }).toString().trim(); } catch {}
const bytes = files.reduce((n, f) => n + fs.statSync(f).size, 0);
fs.writeFileSync(path.join(OUT, 'RELEASE.json'), JSON.stringify({ version: VERSION, build: swManifest.version, commit, builtAt: new Date().toISOString(), files: files.length, bytes }, null, 2) + '\n');
try {
  execFileSync('tar', ['-czf', path.join(OUT_BASE, `pencil-selling-${VERSION}.tar.gz`), '-C', OUT_BASE, `pencil-selling-${VERSION}`]);
} catch (e) { console.warn('tar nicht verfügbar – Archiv übersprungen'); }
console.log(`Release ${VERSION} (${swManifest.version}): ${files.length} Dateien, ${(bytes / 1048576).toFixed(1)} MB → ${path.relative(ROOT, OUT)}`);

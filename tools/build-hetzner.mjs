// Baut das Upload-Paket fuer das Hetzner-Hosting: dist-hetzner/ (Ordner fuer FileZilla/SFTP)
// und hetzner-upload.zip. Aufruf:  node tools/build-hetzner.mjs
// Optional: PS_TENANT_ID und PS_CLIENT_ID (Umgebungsvariablen) werden in ps-config.js eingetragen.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'dist-hetzner');

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

function copy(rel, opts = {}) {
  const src = path.join(ROOT, rel);
  if (!fs.existsSync(src)) throw new Error('Fehlt: ' + rel);
  const dst = path.join(OUT, rel);
  fs.cpSync(src, dst, {
    recursive: true,
    filter: p => {
      const r = path.relative(ROOT, p).split(path.sep).join('/');
      if (opts.skip && opts.skip.some(re => re.test(r))) return false;
      return true;
    }
  });
}

// Webseite
['index.html', 'sw.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'ps-config.js', 'ps-backend.js', '.htaccess', 'vendor'].forEach(f => copy(f));
// Preis-JSONs der Bots (liegen im Hauptordner)
fs.readdirSync(ROOT).filter(f => /\.json$/.test(f) && fs.statSync(path.join(ROOT, f)).isFile()).forEach(f => copy(f));
// Schnittstelle (ohne Zugangsdaten und ohne Zwischenspeicher-Inhalt)
copy('api', { skip: [/^api\/config\.php$/, /^api\/cache\/(?!\.htaccess$).+/, /^api\/.*\.log$/] });

// Eintragen der (nicht geheimen) Entra-IDs
const cfgFile = path.join(OUT, 'ps-config.js');
let cfg = fs.readFileSync(cfgFile, 'utf8');
if (process.env.PS_TENANT_ID) cfg = cfg.replace('TENANT-ID-EINTRAGEN', process.env.PS_TENANT_ID.trim());
if (process.env.PS_CLIENT_ID) cfg = cfg.replace('CLIENT-ID-EINTRAGEN', process.env.PS_CLIENT_ID.trim());
fs.writeFileSync(cfgFile, cfg);
const open = /EINTRAGEN/.test(cfg);

let rev = 'unbekannt';
try { rev = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT }).toString().trim(); } catch (e) { /* ohne git */ }
fs.writeFileSync(path.join(OUT, 'api', 'VERSION.txt'), 'Stand ' + new Date().toISOString() + ' / Commit ' + rev + '\n');

fs.writeFileSync(path.join(OUT, 'UPLOAD-LIESMICH.txt'), [
  'Pencil Selling - Upload-Paket fuer Hetzner (ps.hetec.de)',
  '',
  '1. Den GESAMTEN Inhalt dieses Ordners per SFTP (FileZilla) in den Hauptordner der Subdomain hochladen.',
  '   Versteckte Dateien anzeigen (FileZilla: Server > Versteckte Dateien anzeigen), sonst fehlt .htaccess.',
  '2. Einmalig auf dem Server: api/config.beispiel.php kopieren nach api/config.php und ausfuellen (Datenbank, Entra, Gruppen).',
  '   Diese Datei steht NICHT im Paket und wird bei Updates nicht ueberschrieben.',
  '3. ps-config.js: tenantId und clientId muessen eingetragen sein' + (open ? ' (IM PAKET NOCH NICHT - bitte vor dem Hochladen eintragen).' : ' (im Paket bereits eingetragen).'),
  '4. Pruefen: https://ps.hetec.de/api/health.php  ->  "ok": true',
  '',
  'Ausfuehrlich: docs/HETZNER-EINRICHTUNG.md im Repository.',
  'Stand: ' + rev,
  ''
].join('\r\n'));

const zip = path.join(ROOT, 'hetzner-upload.zip');
fs.rmSync(zip, { force: true });
execFileSync('zip', ['-r', '-q', '-X', zip, '.'], { cwd: OUT });

const count = (function walk(d) { return fs.readdirSync(d, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? walk(path.join(d, e.name)) : 1), 0); })(OUT);
console.log('Paket fertig: dist-hetzner/ (' + count + ' Dateien) + hetzner-upload.zip (' + Math.round(fs.statSync(zip).size / 1024) + ' KB)' + (open ? '\nHinweis: ps-config.js enthaelt noch Platzhalter (tenantId/clientId).' : ''));

// Automatisierbares SFTP-Deployment (OpenSSH-sftp, unter Windows 10/11 vorinstalliert). Kein Python, keine Zusatzpakete.
// Lädt ein fertiges Release VERSIONIERT hoch – die laufende Version wird dabei nicht angefasst:
//   <basis>/releases/<build>/{public,app,database,...}
// Umschalten (atomar) danach in der Hetzner-Konsole: Document-Root der Domain auf releases/<build>/public setzen.
// Rücknahme: Document-Root zurück auf die vorherige Version. Siehe docs/HETZNER-DEPLOYMENT.md.
//
//   node scripts/deploy-sftp.mjs --dry-run                       nur Befehlsliste anzeigen
//   PS_SFTP_HOST=… PS_SFTP_USER=… node scripts/deploy-sftp.mjs   hochladen (Anmeldung per SSH-Schlüssel / Agent)
// Optionen: --release=release/pencil-selling-x  --base=/ps  --port=22
// KEINE Zugangsdaten in dieser Datei oder im Repository speichern.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const rel = path.resolve(ROOT, String(args.release || `release/pencil-selling-${pkg.version}`));
if (!fs.existsSync(path.join(rel, 'RELEASE.json'))) { console.error('Release nicht gefunden – zuerst: npm run release'); process.exit(1); }
const meta = JSON.parse(fs.readFileSync(path.join(rel, 'RELEASE.json'), 'utf8'));
const base = String(args.base || process.env.PS_SFTP_BASE || '/ps').replace(/\/$/, '');
const target = `${base}/releases/${meta.build}`;

// Prüfsummen vor dem Hochladen kontrollieren (beschädigtes Artefakt nie ausliefern)
const sums = fs.readFileSync(path.join(rel, 'SHA256SUMS'), 'utf8').trim().split('\n');
const crypto = await import('node:crypto');
for (const line of sums) {
  const [h, f] = line.split(/\s{2}/);
  const actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(rel, f))).digest('hex');
  if (actual !== h) { console.error('Prüfsumme falsch: ' + f); process.exit(1); }
}

const lines = [`-mkdir ${base}`, `-mkdir ${base}/releases`, `-mkdir ${base}/shared`, `-mkdir ${base}/shared/config`, `-mkdir ${base}/shared/storage`, `-mkdir ${base}/shared/storage/downloads`, `mkdir ${target}`];
const dirs = new Set(), files = [];
(function walk(d) {
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f), r = path.relative(rel, p).split(path.sep).join('/');
    if (fs.statSync(p).isDirectory()) { dirs.add(r); walk(p); } else files.push(r);
  }
})(rel);
for (const d of [...dirs].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))) lines.push(`mkdir ${target}/${d}`);
// Reihenfolge: zuerst Backend und Bibliotheken, ganz zuletzt Einstiegspunkte (index.html, sw.js, api/index.php)
const last = f => /^(public\/index\.html|public\/sw\.js|public\/sw-manifest\.js|public\/version\.json|public\/api\/index\.php)$/.test(f) ? 1 : 0;
files.sort((a, b) => last(a) - last(b) || a.localeCompare(b));
for (const f of files) lines.push(`put "${path.join(rel, f)}" "${target}/${f}"`);
lines.push(`chmod 600 ${target}/app-path.php`);

const batch = lines.join('\n') + '\n';
if (args['dry-run']) {
  console.log(batch.split('\n').slice(0, 25).join('\n') + `\n… (${lines.length} Befehle insgesamt)`);
  console.log(`\nZiel: ${target}\nDanach: Document-Root von ps.hetec.de auf ${target}/public umstellen (Hetzner konsoleH).`);
  process.exit(0);
}
const host = process.env.PS_SFTP_HOST, user = process.env.PS_SFTP_USER, port = String(args.port || process.env.PS_SFTP_PORT || 22);
if (!host || !user) { console.error('PS_SFTP_HOST und PS_SFTP_USER setzen (Anmeldung per SSH-Schlüssel, kein Passwort im Skript)'); process.exit(1); }
const bf = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ps-sftp-')), 'batch.txt');
fs.writeFileSync(bf, batch);
const r = spawnSync('sftp', ['-P', port, '-b', bf, `${user}@${host}`], { stdio: 'inherit' });
fs.rmSync(path.dirname(bf), { recursive: true, force: true });
if (r.status !== 0) { console.error('SFTP fehlgeschlagen – die laufende Version ist unverändert.'); process.exit(r.status || 1); }
console.log(`\nHochgeladen nach ${target}.\nJetzt: 1) Datenbankmigrationen ausführen (docs/HETZNER-DEPLOYMENT.md), 2) Document-Root auf ${target}/public umstellen, 3) Rauchtest.`);

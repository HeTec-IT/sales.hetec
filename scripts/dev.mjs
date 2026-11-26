// Lokale Entwicklungsumgebung starten (Windows, macOS, Linux) – ohne Azure, Firebase oder Google.
//   npm run dev                → http://127.0.0.1:8080  (HeTec-Modus, Test-Anmeldung mit synthetischen Benutzern)
// Voraussetzungen: PHP ≥ 8.2 (pdo_mysql, sodium, curl, mbstring), MariaDB/MySQL mit Datenbank pencil_dev
// (Zugang über PS_DB_DSN / PS_DB_USER / PS_DB_PASSWORD, Standard pencil_dev/pencil_dev auf 127.0.0.1:3306).
// Optionen: --port=8080  --reset (Datenbank leeren und neu befüllen)  --mock-entra (echter OIDC-Ablauf gegen Mock-Provider)
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
const port = String(args.port || process.env.PS_DEV_PORT || 8080);
const PHP = process.env.PHP || 'php';
const env = { ...process.env, PS_CONFIG_FILE: path.join(ROOT, 'backend/dev/config.dev.php'), PS_DEV_PORT: port, PS_FRONTEND_BACKEND: 'hetec' };

let mock = null;
if (args['mock-entra']) {
  const { startMockEntra } = await import('../tests/mock-entra/server.mjs');
  mock = await startMockEntra({ port: 8790, tenantId: '11111111-2222-4333-8444-555555555555', clientId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', clientSecret: 'dev-mock-secret' });
  env.PS_MOCK_AUTHORITY = mock.authority;
  console.log('Mock-Entra:', mock.authority, '(meldet als synthetischer Benutzer test.max.verkauf@hetec-gmbh.de an)');
  const { createHash } = await import('node:crypto');
  const h = createHash('sha256').update('dev-oid:test.max.verkauf@hetec-gmbh.de').digest('hex');
  await mock.setMode('ok', { oid: `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`, email: 'test.max.verkauf@hetec-gmbh.de', name: 'Max Verkauf', given: 'Max', family: 'Verkauf' });
}

const php = f => execFileSync(PHP, [path.join(ROOT, 'backend', f)], { env, stdio: 'inherit' });
try {
  if (args.reset) php('dev/reset-db.php');
  php('bin/migrate.php');
  php('dev/seed.php');
} catch (e) {
  console.error('\nDatenbank nicht erreichbar oder PHP fehlt. Siehe docs/DEVELOPMENT.md (Abschnitt „Windows-Einrichtung“).');
  process.exit(1);
}
console.log(`\nPencil Selling (HeTec-Modus): http://127.0.0.1:${port}\nTest-Anmeldung: auf der Anmeldeseite einen synthetischen Benutzer wählen.\n`);
const srv = spawn(PHP, ['-S', `127.0.0.1:${port}`, '-t', ROOT, path.join(ROOT, 'backend/dev/router.php')], { env, stdio: 'inherit' });
const stop = () => { srv.kill(); if (mock) mock.close(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

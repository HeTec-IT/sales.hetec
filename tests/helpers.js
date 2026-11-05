'use strict';
// Testumgebung: eigene MariaDB/MySQL (oder per Umgebungsvariablen eine vorhandene), PHP-Entwicklungsserver
// mit der ECHTEN api/-Schnittstelle und selbst signierte Entra-Test-Tokens (RS256, JWKS als Datei).
const { spawn, spawnSync } = require('child_process');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = process.env.PS_TEST_ROOT || path.join(__dirname, '..'); // PS_TEST_ROOT: z. B. dist-hetzner/ (fertiges Upload-Paket pruefen)
const TENANT = '11111111-2222-3333-4444-555555555555';
const CLIENT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const G = { admin: 'g-admin', regional: 'g-regional', aalen: 'g-aalen', hall: 'g-hall', springer: 'g-springer' };

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });
}

function waitPort(port, ms, what) {
  const end = Date.now() + ms;
  return new Promise((resolve, reject) => {
    (function tryOnce() {
      const s = net.connect(port, '127.0.0.1');
      s.on('connect', () => { s.destroy(); resolve(); });
      s.on('error', () => { s.destroy(); if (Date.now() > end) reject(new Error((what || 'Dienst') + ' startet nicht')); else setTimeout(tryOnce, 150); });
    })();
  });
}

function which(names) {
  for (const n of names) {
    const r = spawnSync('which', [n], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
    for (const d of ['/usr/sbin', '/usr/local/sbin', '/usr/libexec']) if (fs.existsSync(path.join(d, n))) return path.join(d, n);
  }
  return null;
}

// Datenbank: PS_TEST_DB_HOST/PORT/USER/PASS gesetzt -> diese verwenden, sonst temporaeres mariadbd starten
async function startDb() {
  if (process.env.PS_TEST_DB_HOST) {
    return { host: process.env.PS_TEST_DB_HOST, port: Number(process.env.PS_TEST_DB_PORT || 3306), user: process.env.PS_TEST_DB_USER || 'root', pass: process.env.PS_TEST_DB_PASS || '', stop() {} };
  }
  const server = which(['mariadbd', 'mysqld']);
  const install = which(['mariadb-install-db', 'mysql_install_db']);
  if (!server || !install) throw new Error('Weder mariadbd noch PS_TEST_DB_HOST vorhanden.');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psdb-'));
  const data = path.join(dir, 'data');
  const inst = spawnSync(install, [...(process.getuid && process.getuid() === 0 ? ['--user=root'] : []), '--datadir=' + data, '--auth-root-authentication-method=normal', '--skip-test-db'], { encoding: 'utf8' });
  if (inst.status !== 0) throw new Error('DB-Installation fehlgeschlagen: ' + inst.stderr + inst.stdout);
  const port = await freePort();
  const child = spawn(server, [...(process.getuid && process.getuid() === 0 ? ['--user=root'] : []), '--datadir=' + data, '--socket=' + path.join(dir, 'db.sock'), '--port=' + port, '--bind-address=127.0.0.1',
    '--pid-file=' + path.join(dir, 'db.pid'), '--skip-grant-tables', '--innodb-flush-log-at-trx-commit=0', '--innodb-buffer-pool-size=64M', '--max-allowed-packet=64M'], { stdio: 'ignore' });
  await waitPort(port, 40000, 'Datenbank');
  return {
    host: '127.0.0.1', port, user: 'root', pass: '',
    stop() { child.kill('SIGTERM'); setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) { /* weg */ } fs.rmSync(dir, { recursive: true, force: true }); }, 1500).unref(); }
  };
}

function createDatabase(db, name) {
  const cli = which(['mariadb', 'mysql']);
  const r = spawnSync(cli, ['-h', db.host, '-P', String(db.port), '-u', db.user, ...(db.pass ? ['-p' + db.pass] : []), '--protocol=tcp', '-e', 'CREATE DATABASE `' + name + '` CHARACTER SET utf8mb4']);
  if (r.status !== 0) throw new Error('CREATE DATABASE fehlgeschlagen: ' + r.stderr);
}

const b64u = buf => Buffer.from(buf).toString('base64url');

function makeKeys(dir) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' });
  const jwksFile = path.join(dir, 'jwks.json');
  fs.writeFileSync(jwksFile, JSON.stringify({ keys: [Object.assign({ kid: 'k1', use: 'sig', alg: 'RS256' }, jwk)] }));
  function token(claims, over) {
    over = over || {};
    const now = Math.floor(Date.now() / 1000);
    const head = { alg: over.alg || 'RS256', typ: 'JWT', kid: over.kid || 'k1' };
    const body = Object.assign({ tid: TENANT, name: 'Max Muster', preferred_username: 'm.muster@hetec-gmbh.de', oid: 'oid-max', groups: [],
      iss: 'https://login.microsoftonline.com/' + TENANT + '/v2.0', aud: CLIENT, iat: now, exp: now + 3600 }, claims || {});
    if (over.iss) body.iss = over.iss;
    if (over.aud) body.aud = over.aud;
    if (over.exp) body.exp = over.exp;
    const input = b64u(JSON.stringify(head)) + '.' + b64u(JSON.stringify(body));
    const signer = over.wrongKey ? crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey : privateKey;
    return input + '.' + b64u(crypto.sign('RSA-SHA256', Buffer.from(input), signer));
  }
  return { token, jwksFile };
}

function configFile(dir, db, dbName, jwksFile, extra) {
  const cfg = Object.assign({
    tenant_id: TENANT, client_id: CLIENT, allowed_domain: 'hetec-gmbh.de', admin_emails: [],
    groups: { admin: [G.admin], regional: [G.regional], springer: [G.springer], shops: { [G.aalen]: 'aalen', [G.hall]: 'schwaebisch-hall' } },
    db: { host: db.host, port: db.port, name: dbName, user: db.user, pass: db.pass },
    jwks_url: jwksFile, cache_dir: path.join(dir, 'cache')
  }, extra || {});
  const file = path.join(dir, 'config.php');
  fs.writeFileSync(file, '<?php return json_decode(' + JSON.stringify(JSON.stringify(cfg)).replace(/\$/g, '\\$') + ', true);');
  return file;
}

// Startet alles; liefert call(token, body) -> {status, json} und stop()
async function startStack(opts) {
  opts = opts || {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pstest-'));
  const db = await startDb();
  const dbName = 't' + Date.now() + Math.floor(Math.random() * 1000);
  createDatabase(db, dbName);
  const keys = makeKeys(dir);
  const cfgFile = configFile(dir, db, dbName, keys.jwksFile, opts.config);
  const port = await freePort();
  const php = spawn('php', ['-S', '127.0.0.1:' + port, '-t', ROOT], {
    env: Object.assign({}, process.env, { PS_CONFIG_FILE: cfgFile, PHP_CLI_SERVER_WORKERS: '8' }), stdio: 'ignore'
  });
  await waitPort(port, 10000, 'PHP-Server');
  const base = 'http://127.0.0.1:' + port;
  async function raw(url, init) { return fetch(base + url, init); }
  async function call(token, body) {
    const res = await fetch(base + '/api/db.php', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { 'x-ps-token': token } : {}), body: typeof body === 'string' ? body : JSON.stringify(body) });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch (e) { json = { ok: false, code: 'nojson', message: text.slice(0, 300) }; }
    return { status: res.status, json, text };
  }
  return {
    call, raw, base, keys, G, TENANT, CLIENT, dir, dbName,
    user: (oid, mail, groups, name, extra) => keys.token(Object.assign({ oid, preferred_username: mail, groups, name: name || 'Max Muster' }, extra || {})),
    stop() { php.kill('SIGKILL'); db.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
  };
}

module.exports = { startStack, startDb, createDatabase, makeKeys, configFile, freePort, waitPort, G, TENANT, CLIENT, ROOT };

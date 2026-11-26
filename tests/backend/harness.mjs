// Test-Umgebung für das HeTec-Backend: frische Testdatenbank, Mock-Entra, PHP-Webserver, Cookie-Client.
// Voraussetzungen: PHP ≥ 8.2 (pdo_mysql, sodium, curl), MariaDB/MySQL mit Benutzer/DB aus PS_TEST_DB_* (Standard: pencil_dev / pencil_test).
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { startMockEntra } from '../mock-entra/server.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const TENANT = '11111111-2222-4333-8444-555555555555';
export const CLIENT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const SECRET = 'dev-mock-secret';
const PHP = process.env.PHP || 'php';

const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

export function phpAvailable() {
  try { execFileSync(PHP, ['-r', 'exit(extension_loaded("pdo_mysql") && extension_loaded("sodium") ? 0 : 1);']); return true; } catch { return false; }
}

export async function startEnv({ seed = true, archiveFlowUrl = '', releaseDir = '', bootstrap = ['test.bootstrap.chef@hetec-gmbh.de'], powerAutomate = { flows: {}, shared_key: '' } } = {}) {
  const port = await freePort();
  const mock = await startMockEntra({ tenantId: TENANT, clientId: CLIENT_ID, clientSecret: SECRET });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-test-'));
  const app = `http://127.0.0.1:${port}`;
  const cfgFile = path.join(tmp, 'config.php');
  const keys = { d: Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1)).toString('base64'), i: Buffer.from(Array.from({ length: 32 }, (_, i) => 200 - i)).toString('base64') };
  const dsn = process.env.PS_TEST_DB_DSN || 'mysql:host=127.0.0.1;port=3306;dbname=pencil_test;charset=utf8mb4';
  const cfgJson = JSON.stringify({
    env: 'development', app_url: app, allowed_origins: [app],
    db: { dsn, user: process.env.PS_TEST_DB_USER || 'pencil_dev', password: process.env.PS_TEST_DB_PASSWORD || 'pencil_dev' },
    entra: { tenant_id: TENANT, client_id: CLIENT_ID, client_secret: SECRET, redirect_uri: app + '/api/v1/auth/callback', post_logout_redirect_uri: app + '/', allowed_domains: ['hetec-gmbh.de'], reject_guests: true, authority_override: mock.authority },
    data_key: keys.d, index_key: keys.i,
    session: { cookie_name: 'ps_sid_test', idle_minutes: 480, absolute_hours: 12, offline_grace_hours: 12 },
    bootstrap_super_admins: bootstrap,
    storage_dir: path.join(tmp, 'storage'),
    archive_flow: { url: archiveFlowUrl, shared_secret: archiveFlowUrl ? 'flow-secret-test' : '' },
    power_automate: powerAutomate,
    allow_web_migrations: false,
  });
  fs.writeFileSync(cfgFile, `<?php return json_decode(base64_decode('${Buffer.from(cfgJson).toString('base64')}'), true, 32, JSON_THROW_ON_ERROR);`);
  const env = { ...process.env, PS_CONFIG_FILE: cfgFile };
  const run = f => execFileSync(PHP, [path.join(ROOT, 'backend', f)], { env, stdio: 'pipe' }).toString();
  run('dev/reset-db.php');
  run('bin/migrate.php');
  if (seed) run('dev/seed.php');
  // Release-Modus: Server auf release/…/public mit dem Backend aus release/…/app (ohne backend/dev → kein Test-Login)
  const srvEnv = releaseDir ? { ...env, PS_APP_ROOT: path.join(releaseDir, 'app') } : { ...env, PS_FRONTEND_BACKEND: 'hetec' };
  const srvArgs = releaseDir ? ['-S', `127.0.0.1:${port}`, '-t', path.join(releaseDir, 'public'), path.join(ROOT, 'tests/release/router.php')] : ['-S', `127.0.0.1:${port}`, '-t', ROOT, path.join(ROOT, 'backend/dev/router.php')];
  const srv = spawn(PHP, srvArgs, { env: srvEnv, stdio: ['ignore', 'ignore', 'pipe'] });
  let log = '';
  srv.stderr.on('data', d => { log += d; });
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(app + '/api/v1/health'); if (r.ok) break; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  return {
    app, mock, cfgFile, tmp, env, log: () => log, php: run,
    sql(q) { return JSON.parse(execFileSync(PHP, ['-r', '$f = require getenv("PS_APP_ROOT") . "/bootstrap.php"; echo json_encode($f()->db->all(base64_decode($argv[1])));', Buffer.from(q).toString('base64')], { env: { ...env, PS_APP_ROOT: path.join(ROOT, 'backend') } }).toString()); },
    exec(q) { return Number(execFileSync(PHP, ['-r', '$f = require getenv("PS_APP_ROOT") . "/bootstrap.php"; echo $f()->db->exec(base64_decode($argv[1]));', Buffer.from(q).toString('base64')], { env: { ...env, PS_APP_ROOT: path.join(ROOT, 'backend') } }).toString()); },
    async stop() { srv.kill(); await mock.close(); fs.rmSync(tmp, { recursive: true, force: true }); },
  };
}

// Minimaler Browser-Ersatz: Cookies, CSRF-Header, manuelle Redirects
export class Client {
  constructor(base) { this.base = base; this.cookies = new Map(); this.csrf = ''; }
  cookieHeader() { return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '); }
  store(res) {
    const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const c of sc) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      const k = kv.slice(0, i), v = kv.slice(i + 1);
      if (/Expires=Thu, 01 Jan 1970|Expires=[^;]*19[0-9]{2}/.test(c) || v === '') this.cookies.delete(k); else this.cookies.set(k, v);
    }
  }
  async req(method, url, { body, headers = {}, raw = false, origin } = {}) {
    const full = url.startsWith('http') ? url : this.base + url;
    const h = { ...headers };
    if (full.startsWith(this.base) && this.cookies.size) h.Cookie = this.cookieHeader();
    if (body !== undefined && !(body instanceof Uint8Array)) { h['Content-Type'] = 'application/json'; body = JSON.stringify(body); }
    if (method !== 'GET' && this.csrf && !('X-PS-CSRF' in h)) h['X-PS-CSRF'] = this.csrf;
    if (origin !== undefined) h.Origin = origin; else if (method !== 'GET') h.Origin = this.base;
    const res = await fetch(full, { method, headers: h, body, redirect: 'manual' });
    if (full.startsWith(this.base)) this.store(res);
    if (raw) return res;
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text, headers: res.headers };
  }
  get(u, o) { return this.req('GET', u, o); }
  post(u, b, o = {}) { return this.req('POST', u, { ...o, body: b }); }
  put(u, b, o = {}) { return this.req('PUT', u, { ...o, body: b }); }
  patch(u, b, o = {}) { return this.req('PATCH', u, { ...o, body: b }); }
  del(u, o) { return this.req('DELETE', u, o); }

  /** Vollständiger OIDC-Ablauf über den Mock-Provider. Gibt die finale App-URL zurück. */
  async loginEntra(env, identity, mode = 'ok') {
    await env.mock.setMode(mode, identity);
    const r1 = await this.req('GET', '/api/v1/auth/login?returnTo=/', { raw: true });
    if (r1.status !== 302) throw new Error('login: ' + r1.status + ' ' + await r1.text());
    const r2 = await fetch(r1.headers.get('location'), { redirect: 'manual' });
    if (r2.status !== 302) throw new Error('authorize: ' + r2.status + ' ' + await r2.text());
    const r3 = await this.req('GET', r2.headers.get('location'), { raw: true });
    const loc = r3.headers.get('location') || '';
    const s = await this.get('/api/v1/session');
    this.csrf = s.json && s.json.csrfToken || '';
    return { location: loc, session: s.json };
  }

  async loginDev(email) {
    const r = await this.post('/api/v1/dev/login', { email });
    const s = await this.get('/api/v1/session');
    this.csrf = s.json && s.json.csrfToken || '';
    return { r, session: s.json };
  }
}

export function devOid(email) {
  // identisch zu backend/dev/seed.php
  return import('node:crypto').then(({ createHash }) => {
    const h = createHash('sha256').update('dev-oid:' + email).digest('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
  });
}

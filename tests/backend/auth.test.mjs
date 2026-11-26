// Microsoft-Entra-Anmeldung (über Mock-Provider): gültige und ungültige Tokens, Freigabe, Sitzung, Logout.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv, Client, phpAvailable, devOid } from './harness.mjs';

const skip = !phpAvailable() && 'PHP mit pdo_mysql/sodium nicht verfügbar';
let env;
before(async () => { if (!skip) env = await startEnv(); });
after(async () => { if (env) await env.stop(); });

const ident = async (email, name = 'Test Person') => ({ oid: await devOid(email), email, name, given: name.split(' ')[0], family: name.split(' ')[1] || '' });

test('gültige Anmeldung eines freigegebenen Mitarbeiters → Sitzung mit Rechten und Shops', { skip }, async () => {
  const c = new Client(env.app);
  const { location, session } = await c.loginEntra(env, await ident('test.max.verkauf@hetec-gmbh.de', 'Max Verkauf'));
  assert.match(location, /\?login=ok$/);
  assert.equal(session.authenticated, true);
  assert.equal(session.user.role, 'mitarbeiter');
  assert.deepEqual(session.user.allowedShopIds, ['aalen']);
  assert.equal(session.user.isAdmin, false);
  assert.ok(session.csrfToken.length >= 32);
  assert.ok(!JSON.stringify(session).includes('dev-mock-secret'));
});

test('neues Microsoft-Konto erhält KEINEN Zugriff, sondern Status "pending"', { skip }, async () => {
  const c = new Client(env.app);
  const { location, session } = await c.loginEntra(env, await ident('neu.unbekannt@hetec-gmbh.de', 'Neu Unbekannt'));
  assert.match(location, /login=pending/);
  assert.equal(session.authenticated, false);
  assert.equal(session.status, 'pending');
  const r = await c.get('/api/v1/offers');
  assert.equal(r.status, 401);
});

test('gesperrtes Konto wird abgewiesen', { skip }, async () => {
  const c = new Client(env.app);
  const { location, session } = await c.loginEntra(env, await ident('test.gesperrt.konto@hetec-gmbh.de', 'Gesperrt Konto'));
  assert.match(location, /login=denied/);
  assert.equal(session.authenticated, false);
});

for (const [mode, reason] of [
  ['wrong_tenant', 'wrong_tenant'],
  ['personal_account', 'wrong_tenant'],
  ['guest', 'guest_not_allowed'],
  ['foreign_domain', 'domain_not_allowed'],
]) {
  test(`abgelehnt: ${mode}`, { skip }, async () => {
    const c = new Client(env.app);
    const { location, session } = await c.loginEntra(env, await ident('test.max.verkauf@hetec-gmbh.de', 'Max Verkauf'), mode);
    assert.match(location, new RegExp('login=denied&reason=' + reason));
    assert.equal(session.authenticated, false);
  });
}

for (const mode of ['wrong_audience', 'wrong_issuer', 'expired', 'bad_signature', 'wrong_nonce', 'no_nonce', 'alg_hs256', 'alg_none']) {
  test(`ungültiges Token abgelehnt: ${mode}`, { skip }, async () => {
    const c = new Client(env.app);
    const { location, session } = await c.loginEntra(env, await ident('test.max.verkauf@hetec-gmbh.de', 'Max Verkauf'), mode);
    assert.match(location, /login=error/);
    assert.equal(session.authenticated, false);
  });
}

test('Callback ohne passenden state wird abgelehnt (CSRF auf den Login)', { skip }, async () => {
  const c = new Client(env.app);
  await c.req('GET', '/api/v1/auth/login', { raw: true });
  const r = await c.req('GET', '/api/v1/auth/callback?code=abc&state=falsch', { raw: true });
  assert.equal(r.status, 302);
  assert.match(r.headers.get('location'), /login=error/);
});

test('Bootstrap-Admin aus der Konfiguration: nur solange kein Hauptadmin existiert', { skip }, async () => {
  // Es gibt bereits einen (verknüpften) Hauptadmin → Bootstrap-Eintrag wirkt nicht, Konto wartet auf Freigabe
  const c1 = new Client(env.app);
  const r1 = await c1.loginEntra(env, await ident('test.bootstrap.chef@hetec-gmbh.de', 'Bootstrap Chef'));
  assert.equal(r1.session.authenticated, false);
  assert.equal(r1.session.status, 'pending');
  // Ersteinrichtung simulieren: kein freigegebener Hauptadmin vorhanden
  env.exec("DELETE FROM users WHERE email = 'test.bootstrap.chef@hetec-gmbh.de'");
  const supers = env.sql("SELECT id FROM users WHERE role_id = 'super_admin' AND status = 'approved'").map(x => x.id);
  env.exec("UPDATE users SET status = 'blocked' WHERE id IN (" + supers.join(',') + ')');
  try {
    const c2 = new Client(env.app);
    const r2 = await c2.loginEntra(env, await ident('test.bootstrap.chef@hetec-gmbh.de', 'Bootstrap Chef'));
    assert.equal(r2.session.authenticated, true);
    assert.equal(r2.session.user.role, 'super_admin');
  } finally {
    env.exec("UPDATE users SET status = 'approved' WHERE id IN (" + supers.join(',') + ')');
  }
});

test('Wartendes Konto kann sich serverseitig abmelden (CSRF-Token auch ohne Freigabe)', { skip }, async () => {
  const c = new Client(env.app);
  const { session } = await c.loginEntra(env, await ident('test.neu.wartend2@hetec-gmbh.de', 'Neu Wartend'));
  assert.equal(session.status, 'pending');
  assert.ok(session.csrfToken);
  c.csrf = session.csrfToken;
  const r = await c.post('/api/v1/auth/logout', {});
  assert.equal(r.status, 200);
  assert.equal((await c.get('/api/v1/session')).json.status, 'anonymous');
});

test('Name kann nur einmalig ergänzt werden, nicht nachträglich geändert', { skip }, async () => {
  const c = new Client(env.app);
  await c.loginDev('test.max.verkauf@hetec-gmbh.de');
  const r = await c.patch('/api/v1/me/profile', { vorname: 'Fremder', nachname: 'Name' });
  assert.equal(r.status, 409);
  assert.equal(r.json.error, 'profile_complete');
});

test('Logout beendet die Sitzung serverseitig und liefert die Microsoft-Abmelde-URL', { skip }, async () => {
  const c = new Client(env.app);
  await c.loginEntra(env, await ident('test.max.verkauf@hetec-gmbh.de', 'Max Verkauf'));
  const saved = c.cookieHeader();
  const r = await c.post('/api/v1/auth/logout', {});
  assert.equal(r.status, 200);
  assert.ok(r.json.logoutUrl);
  // alte Cookie-ID darf nicht mehr gelten
  const r2 = await fetch(env.app + '/api/v1/session', { headers: { Cookie: saved } });
  assert.equal((await r2.json()).authenticated, false);
});

test('Sperre durch Admin beendet laufende Sitzungen sofort', { skip }, async () => {
  const user = new Client(env.app);
  await user.loginEntra(env, await ident('test.mia.verkauf@hetec-gmbh.de', 'Mia Verkauf'));
  assert.equal((await user.get('/api/v1/offers')).status, 200);
  const admin = new Client(env.app);
  await admin.loginDev('test.haupt.admin@hetec-gmbh.de');
  const list = await admin.get('/api/v1/admin/users');
  const mia = list.json.users.find(u => u.email === 'test.mia.verkauf@hetec-gmbh.de');
  const r = await admin.patch('/api/v1/admin/users/' + mia.id, { status: 'blocked' });
  assert.equal(r.status, 200);
  assert.equal((await user.get('/api/v1/offers')).status, 401);
  await admin.patch('/api/v1/admin/users/' + mia.id, { status: 'approved' });
});

test('Dev-Login akzeptiert nur synthetische Testkonten', { skip }, async () => {
  const c = new Client(env.app);
  const r = await c.post('/api/v1/dev/login', { email: 'm.mustermann@hetec-gmbh.de' });
  assert.equal(r.status, 422);
});

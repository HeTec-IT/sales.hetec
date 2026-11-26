// Mock-Identitätsanbieter im Stil von Microsoft Entra ID (v2.0) – NUR für lokale Tests.
// Liefert Discovery, JWKS, /authorize (leitet sofort mit Code zurück) und /token (RS256-ID-Token).
// Über /__mode kann ein Test fehlerhafte Tokens erzwingen (falscher Tenant, abgelaufen, Gast, …).
import http from 'node:http';
import crypto from 'node:crypto';

export function startMockEntra({ port = 0, tenantId, clientId, clientSecret } = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const { privateKey: otherKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'mock-key-1', use: 'sig', kty: 'RSA', alg: 'RS256' };
  const codes = new Map();
  const state = { mode: 'ok', identity: null, base: '' };
  const b64u = b => Buffer.from(b).toString('base64url');

  function sign(header, payload, key = privateKey) {
    const h = b64u(JSON.stringify(header)), p = b64u(JSON.stringify(payload));
    if (header.alg === 'none') return `${h}.${p}.`;
    if (header.alg === 'HS256') return `${h}.${p}.${crypto.createHmac('sha256', clientSecret).update(`${h}.${p}`).digest('base64url')}`;
    return `${h}.${p}.${crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`), key).toString('base64url')}`;
  }

  function idToken(code) {
    const c = codes.get(code);
    const id = c.identity;
    const now = Math.floor(Date.now() / 1000);
    const iss = state.base;
    let claims = {
      ver: '2.0', iss, aud: clientId, sub: 'sub-' + id.oid, oid: id.oid, tid: tenantId,
      name: id.name, preferred_username: id.email, given_name: id.given || '', family_name: id.family || '',
      nonce: c.nonce, iat: now, nbf: now, exp: now + 3600,
    };
    let header = { alg: 'RS256', kid: 'mock-key-1', typ: 'JWT' };
    let key = privateKey;
    switch (state.mode) {
      case 'wrong_tenant': claims.tid = '99999999-9999-4999-8999-999999999999'; break;
      case 'personal_account': claims.tid = '9188040d-6c67-4c5b-b112-36a304b66dad'; break;
      case 'wrong_audience': claims.aud = '00000000-1111-4222-8333-444444444444'; break;
      case 'wrong_issuer': claims.iss = 'https://evil.example/v2.0'; break;
      case 'expired': claims.exp = now - 3600; claims.iat = now - 7200; claims.nbf = now - 7200; break;
      case 'bad_signature': key = otherKey; break;
      case 'guest': claims.idp = 'https://sts.windows.net/99999999-9999-4999-8999-999999999999/'; break;
      case 'wrong_nonce': claims.nonce = 'falsch'; break;
      case 'no_nonce': delete claims.nonce; break;
      case 'alg_hs256': header = { alg: 'HS256', typ: 'JWT' }; break;
      case 'alg_none': header = { alg: 'none', typ: 'JWT' }; break;
      case 'foreign_domain': claims.preferred_username = 'jemand@gmail.com'; break;
    }
    return sign(header, claims, key);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, state.base);
    const send = (status, body, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
    if (url.pathname === '/v2.0/.well-known/openid-configuration') {
      return send(200, {
        issuer: state.base, authorization_endpoint: state.root + '/oauth2/v2.0/authorize', token_endpoint: state.root + '/oauth2/v2.0/token',
        jwks_uri: state.root + '/discovery/v2.0/keys', end_session_endpoint: state.root + '/oauth2/v2.0/logout',
        response_types_supported: ['code'], subject_types_supported: ['pairwise'], id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'], scopes_supported: ['openid', 'profile', 'email'],
      });
    }
    if (url.pathname === '/discovery/v2.0/keys') return send(200, { keys: [jwk] });
    if (url.pathname === '/oauth2/v2.0/authorize') {
      const p = url.searchParams;
      if (p.get('client_id') !== clientId || p.get('response_type') !== 'code' || p.get('code_challenge_method') !== 'S256' || !p.get('code_challenge')) {
        return send(400, { error: 'invalid_request', detail: 'PKCE S256 + client_id erforderlich' });
      }
      const code = crypto.randomBytes(16).toString('hex');
      codes.set(code, { nonce: p.get('nonce'), challenge: p.get('code_challenge'), redirect: p.get('redirect_uri'), identity: state.identity });
      const back = new URL(p.get('redirect_uri'));
      back.searchParams.set('code', code);
      back.searchParams.set('state', p.get('state'));
      res.writeHead(302, { Location: back.toString() });
      return res.end();
    }
    if (url.pathname === '/oauth2/v2.0/token' && req.method === 'POST') {
      let body = '';
      for await (const ch of req) body += ch;
      const p = new URLSearchParams(body);
      const auth = req.headers.authorization || '';
      let cid = p.get('client_id'), sec = p.get('client_secret');
      if (auth.startsWith('Basic ')) [cid, sec] = Buffer.from(auth.slice(6), 'base64').toString().split(':').map(decodeURIComponent);
      const c = codes.get(p.get('code'));
      if (!c) return send(400, { error: 'invalid_grant' });
      if (cid !== clientId || sec !== clientSecret) return send(401, { error: 'invalid_client' });
      const verifierHash = crypto.createHash('sha256').update(p.get('code_verifier') || '').digest('base64url');
      if (verifierHash !== c.challenge) return send(400, { error: 'invalid_grant', detail: 'PKCE verifier' });
      if (p.get('redirect_uri') !== c.redirect) return send(400, { error: 'invalid_grant', detail: 'redirect_uri' });
      const tok = idToken(p.get('code'));
      codes.delete(p.get('code'));
      return send(200, { token_type: 'Bearer', access_token: 'mock-access-' + crypto.randomBytes(8).toString('hex'), expires_in: 3600, id_token: tok });
    }
    if (url.pathname === '/__mode' && req.method === 'POST') {
      let body = '';
      for await (const ch of req) body += ch;
      const j = JSON.parse(body || '{}');
      state.mode = j.mode || 'ok';
      if (j.identity) state.identity = j.identity;
      return send(200, { ok: true });
    }
    send(404, { error: 'not_found' });
  });
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => {
    const { port: p } = server.address();
    state.root = `http://127.0.0.1:${p}/${tenantId}`;
    state.base = state.root + '/v2.0';
    // Pfade relativ zum Tenant-Präfix bedienen
    const orig = server.listeners('request')[0];
    server.removeAllListeners('request');
    server.on('request', (req, res) => {
      const prefix = '/' + tenantId;
      if (req.url.startsWith(prefix)) req.url = req.url.slice(prefix.length) || '/';
      orig(req, res);
    });
    resolve({
      authority: state.base, port: p, close: () => new Promise(r => server.close(r)),
      setMode: async (mode, identity) => { state.mode = mode; if (identity) state.identity = identity; },
    });
  }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const m = await startMockEntra({ port: Number(process.env.PORT || 8790), tenantId: '11111111-2222-4333-8444-555555555555', clientId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', clientSecret: 'dev-mock-secret' });
  await m.setMode('ok', { oid: 'abcdef01-2345-4678-89ab-cdef01234567', email: 'test.max.verkauf@hetec-gmbh.de', name: 'Max Verkauf', given: 'Max', family: 'Verkauf' });
  console.log('Mock-Entra läuft:', m.authority);
}

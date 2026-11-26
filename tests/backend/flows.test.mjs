// Power-Automate-Weiterleitung: signierte Flow-URLs und Schlüssel nur auf dem Server; Payload unverändert.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startEnv, Client, phpAvailable } from './harness.mjs';

const skip = !phpAvailable() && 'PHP mit pdo_mysql/sodium nicht verfügbar';
let env, flowSrv, received = [];
before(async () => {
  if (skip) return;
  flowSrv = http.createServer((req, res) => {
    let b = '';
    req.on('data', c => { b += c; });
    req.on('end', () => { received.push({ url: req.url, ct: req.headers['content-type'], body: b }); res.writeHead(202); res.end(); });
  });
  await new Promise(r => flowSrv.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + flowSrv.address().port;
  env = await startEnv({ powerAutomate: { flows: { archive: base + '/archive?sig=SERVERSEITIG', followup: base + '/followup' }, shared_key: 'server-schluessel' } });
});
after(async () => { if (env) await env.stop(); if (flowSrv) flowSrv.close(); });

test('Flow-Weiterleitung: nur angemeldet, CSRF, Schlüssel setzt der Server, Payload sonst unverändert', { skip }, async () => {
  const anon = new Client(env.app);
  anon.csrf = (await anon.get('/api/v1/session')).json.csrfToken;
  assert.ok(anon.csrf);
  assert.equal((await anon.post('/api/v1/flows/archive', { key: '' })).status, 401, 'ohne Anmeldung kein Flow-Aufruf');
  const max = new Client(env.app);
  await max.loginDev('test.max.verkauf@hetec-gmbh.de');
  assert.equal((await max.post('/api/v1/flows/archive', {}, { headers: { 'X-PS-CSRF': '' } })).status, 403);
  const payload = { typ: 'angebot', agent: 'Max Verkauf', shop: 'aalen', key: '', pdfBase64: 'JVBERi0xLjQK' };
  const r = await max.post('/api/v1/flows/archive', payload);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.status, 202);
  const got = received.at(-1);
  assert.equal(got.url, '/archive?sig=SERVERSEITIG');
  assert.equal(got.ct, 'text/plain');
  assert.deepEqual(JSON.parse(got.body), { ...payload, key: 'server-schluessel' });
  const f = await max.post('/api/v1/flows/followup', { shop: 'Aalen', kunde: 'Synthetik' });
  assert.equal(f.status, 200);
  assert.deepEqual(JSON.parse(received.at(-1).body), { shop: 'Aalen', kunde: 'Synthetik' }, 'ohne key-Feld kein Schlüssel');
  assert.equal((await max.post('/api/v1/flows/followup_aalen', {})).status, 503, 'nicht konfiguriert → klare Meldung');
  assert.equal((await max.post('/api/v1/flows/..%2Fx', {})).status, 404);
});

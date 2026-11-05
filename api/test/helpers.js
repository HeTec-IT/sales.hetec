'use strict';
const { spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { generateKeyPair, SignJWT } = require('jose');

const PORT = 10102;
const CONN = 'DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;TableEndpoint=http://127.0.0.1:' + PORT + '/devstoreaccount1;';

function waitPort(port, ms) {
  const end = Date.now() + ms;
  return new Promise((resolve, reject) => {
    (function tryOnce() {
      const s = net.connect(port, '127.0.0.1');
      s.on('connect', () => { s.destroy(); resolve(); });
      s.on('error', () => { s.destroy(); if (Date.now() > end) reject(new Error('azurite startet nicht')); else setTimeout(tryOnce, 200); });
    })();
  });
}

async function startAzurite() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azurite-'));
  const bin = path.join(__dirname, '..', 'node_modules', '.bin', 'azurite-table');
  const child = spawn(bin, ['--silent', '--location', dir, '--tableHost', '127.0.0.1', '--tablePort', String(PORT), '--skipApiVersionCheck'], { stdio: 'ignore' });
  await waitPort(PORT, 20000);
  return { stop() { child.kill('SIGKILL'); fs.rmSync(dir, { recursive: true, force: true }); } };
}

const TENANT = '11111111-2222-3333-4444-555555555555';
const CLIENT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const G = { admin: 'g-admin', regional: 'g-regional', aalen: 'g-aalen', hall: 'g-hall', springer: 'g-springer' };

function testConfig(table) {
  return {
    tenantId: TENANT, clientId: CLIENT, allowedDomain: 'hetec-gmbh.de', adminEmails: [],
    groups: { admin: [G.admin], regional: [G.regional], springer: [G.springer], shops: { [G.aalen]: 'aalen', [G.hall]: 'schwaebisch-hall' } },
    storageConnection: CONN, table: table || 'testdocs'
  };
}

async function makeKeys() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  async function token(claims, over) {
    over = over || {};
    const now = Math.floor(Date.now() / 1000);
    let jwt = new SignJWT(Object.assign({ tid: TENANT, name: 'Max Muster', preferred_username: 'm.muster@hetec-gmbh.de', oid: 'oid-max', groups: [] }, claims))
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(over.iss || ('https://login.microsoftonline.com/' + TENANT + '/v2.0'))
      .setAudience(over.aud || CLIENT)
      .setIssuedAt(now)
      .setExpirationTime(over.exp || (now + 3600));
    return jwt.sign(privateKey);
  }
  return { publicKey, token, resolver: async () => publicKey };
}

module.exports = { startAzurite, testConfig, makeKeys, CONN, G, TENANT, CLIENT };

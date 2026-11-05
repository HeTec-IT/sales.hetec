'use strict';
const { loadConfig } = require('./config');
const { createVerifier, contextFromClaims } = require('./auth');
const { Store } = require('./store');
const { Engine } = require('./engine');
const { ApiError, E } = require('./errors');

// Baut die Anwendung aus Konfiguration + Abhaengigkeiten (testbar ohne Azure).
function createApp(opts) {
  opts = opts || {};
  const cfg = opts.cfg || loadConfig();
  const verify = opts.verify !== undefined ? opts.verify : createVerifier(cfg);
  let engine = opts.engine || null;
  function getEngine() {
    if (!engine) engine = new Engine(opts.store || Store.fromConfig(cfg));
    return engine;
  }

  // token (Header x-ps-token) -> Kontext; ohne Token: null
  async function context(token) {
    if (!token) return null;
    if (!verify) throw new ApiError(503, 'unavailable', 'Server nicht konfiguriert (Tenant/Client fehlen).');
    const claims = await verify(token);
    return contextFromClaims(claims, cfg);
  }

  async function handle(token, body) {
    try {
      const ctx = await context(token);
      const res = await getEngine().handle(body, ctx);
      return { status: 200, json: Object.assign({ ok: true }, res) };
    } catch (err) {
      if (err instanceof ApiError) return { status: err.status, json: { ok: false, code: err.code, message: err.message } };
      return { status: 500, json: { ok: false, code: 'internal', message: 'Interner Fehler.' }, error: err };
    }
  }

  // Ohne Geheimnisse: nur ja/nein, damit die Einrichtung pruefbar ist.
  async function health() {
    const out = {
      ok: true,
      tenant: !!cfg.tenantId,
      client: !!cfg.clientId,
      groups: {
        admin: cfg.groups.admin.length,
        regional: cfg.groups.regional.length,
        springer: cfg.groups.springer.length,
        shops: Object.keys(cfg.groups.shops).length
      },
      storage: false
    };
    try {
      await getEngine().store.init();
      out.storage = true;
    } catch (e) {
      out.storage = false;
    }
    out.ok = out.tenant && out.client && out.storage && (out.groups.admin + out.groups.shops > 0 || cfg.adminEmails.length > 0);
    return out;
  }

  return { handle, health, cfg };
}

module.exports = { createApp };

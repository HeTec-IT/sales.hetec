'use strict';
const { createRemoteJWKSet, jwtVerify } = require('jose');
const { E } = require('./errors');

// Prueft das Microsoft-Entra-ID-Token (RS256, Aussteller = eigener Tenant,
// Zielgruppe = Client-ID der App). keyResolver nur fuer Tests.
function createVerifier(cfg, keyResolver) {
  if (!cfg.tenantId || !cfg.clientId) return null;
  const keys = keyResolver || createRemoteJWKSet(
    new URL('https://login.microsoftonline.com/' + cfg.tenantId + '/discovery/v2.0/keys'),
    { cooldownDuration: 30000, cacheMaxAge: 6 * 3600 * 1000 }
  );
  return async function verify(token) {
    try {
      const res = await jwtVerify(token, keys, {
        issuer: 'https://login.microsoftonline.com/' + cfg.tenantId + '/v2.0',
        audience: cfg.clientId,
        algorithms: ['RS256'],
        clockTolerance: 30
      });
      const p = res.payload;
      if (String(p.tid || '').toLowerCase() !== cfg.tenantId) throw new Error('tenant');
      if (!p.oid && !p.sub) throw new Error('subject');
      return p;
    } catch (e) {
      throw E.unauth('Login-Token ungueltig oder abgelaufen.');
    }
  };
}

function uniq(a) {
  return a.filter((x, i) => a.indexOf(x) === i);
}

// Rollen und Standorte kommen NUR aus den Entra-Gruppen im Token.
function contextFromClaims(claims, cfg) {
  const email = String(claims.preferred_username || claims.email || claims.upn || '').trim().toLowerCase();
  const groups = (Array.isArray(claims.groups) ? claims.groups : []).map(g => String(g).toLowerCase());
  const overage = !!(claims._claim_names && claims._claim_names.groups);
  const inAny = ids => ids.some(g => groups.indexOf(g) !== -1);
  const isAdmin = inAny(cfg.groups.admin) || cfg.adminEmails.indexOf(email) !== -1;
  const isRegional = inAny(cfg.groups.regional);
  const springer = inAny(cfg.groups.springer);
  const shops = uniq(Object.keys(cfg.groups.shops).filter(g => groups.indexOf(g) !== -1).map(g => cfg.groups.shops[g]));
  const domainOk = !!cfg.allowedDomain && email.slice(-(cfg.allowedDomain.length + 1)) === '@' + cfg.allowedDomain;
  // Zugang nur mit Rolle (Admin/Regional/Springer) oder mindestens einer Shop-Gruppe
  const member = isAdmin || isRegional || springer || shops.length > 0;
  const active = domainOk && member;
  let reason = '';
  if (!domainOk) reason = 'domain';
  else if (!member) reason = overage ? 'groups-overage' : 'no-group';
  return {
    uid: String(claims.oid || claims.sub),
    email,
    name: String(claims.name || '').trim(),
    given: String(claims.given_name || '').trim(),
    family: String(claims.family_name || '').trim(),
    isAdmin,
    isRegional,
    isStaff: isAdmin || isRegional,
    allShops: isAdmin || isRegional || springer,
    shops,
    home: shops[0] || '',
    active,
    reason,
    ownUids: [String(claims.oid || claims.sub)]
  };
}

function canShop(ctx, shopId) {
  const s = String(shopId || '').trim().toLowerCase();
  if (!ctx || !ctx.active || !s) return false;
  return ctx.allShops || ctx.shops.indexOf(s) !== -1;
}

module.exports = { createVerifier, contextFromClaims, canShop };

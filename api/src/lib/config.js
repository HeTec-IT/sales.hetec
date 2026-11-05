'use strict';

function list(v) {
  return (Array.isArray(v) ? v : []).map(x => String(x).trim()).filter(Boolean);
}

// Einstellungen kommen ausschliesslich aus Umgebungsvariablen (in Azure unter
// "Umgebungsvariablen" der Static Web App) - keine Geheimnisse im Code.
function loadConfig(env) {
  env = env || process.env;
  let g = {};
  try {
    g = JSON.parse(env.PS_GROUPS || '{}') || {};
  } catch (e) {
    g = {};
  }
  const shops = {};
  if (g.shops && typeof g.shops === 'object') {
    Object.keys(g.shops).forEach(gid => {
      const id = String(g.shops[gid] || '').trim().toLowerCase();
      if (gid && id) shops[String(gid).trim().toLowerCase()] = id;
    });
  }
  return {
    tenantId: String(env.PS_TENANT_ID || '').trim().toLowerCase(),
    clientId: String(env.PS_CLIENT_ID || '').trim().toLowerCase(),
    allowedDomain: String(env.PS_ALLOWED_DOMAIN || 'hetec-gmbh.de').trim().toLowerCase(),
    adminEmails: String(env.PS_ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
    groups: {
      admin: list(g.admin).map(s => s.toLowerCase()),
      regional: list(g.regional).map(s => s.toLowerCase()),
      springer: list(g.springer).map(s => s.toLowerCase()),
      shops
    },
    storageConnection: String(env.PS_STORAGE_CONNECTION || '').trim(),
    table: String(env.PS_TABLE || 'psdocs').trim()
  };
}

module.exports = { loadConfig };

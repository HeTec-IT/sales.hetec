'use strict';
const { E } = require('./errors');
const { canShop } = require('./auth');

// Zugriffsregeln je Sammlung. Ersetzt die bisherigen Firestore-Regeln - aber
// strenger: JEDE Anfrage braucht ein gueltiges Entra-Login (Ausnahme: das
// Kunden-Download-Dokument per QR-Code), Shops und Rollen kommen aus den Gruppen.

const FILE_ID = /^[a-f0-9]{32}-\d{1,3}$/;

const isInc = (v, n) => !!v && typeof v === 'object' && v.__ps === 'inc' && (n == null || v.n === n);
const isPlain = v => !!v && typeof v === 'object' && !Array.isArray(v);

function need(ctx) {
  if (!ctx) throw E.unauth();
  if (!ctx.active) throw E.denied('Kein Zugang: Konto ist keiner Pencil-Selling-Gruppe zugeordnet.');
  return ctx;
}

// ---- Einzel-Dokument lesen -------------------------------------------------
function checkRead(ctx, coll, id, doc) {
  if (coll === 'portierung_files') {
    if (!FILE_ID.test(String(id))) throw E.denied();
    return; // oeffentlich (unratbare 128-Bit-ID, 24 h gueltig) - fuer den QR-Download
  }
  need(ctx);
  const d = doc ? doc.data : null;
  switch (coll) {
    case 'users':
      if (String(id) === ctx.uid || ctx.isAdmin) return;
      throw E.denied();
    case 'analytics':
      if (!d || ctx.isStaff || ctx.ownUids.indexOf(String(d.userUid || '')) !== -1) return;
      throw E.denied();
    case 'saved_offers':
    case 'pdf_index':
      if (!d || canShop(ctx, d.shopId)) return;
      throw E.denied();
    case 'skip_limits':
    case 'news':
    case 'aktionsmappe':
      return;
    case 'tool_usage':
      if (ctx.isStaff) return;
      throw E.denied();
    default:
      throw E.denied();
  }
}

// ---- Einzel-Dokument schreiben: gibt (ggf. korrigierte) Daten zurueck -------
// op: 'set' | 'update' | 'delete'; existing = {data} oder null
function checkWrite(ctx, coll, id, op, data, existing) {
  id = String(id);
  const old = existing ? existing.data : null;
  if (op !== 'delete' && !isPlain(data)) throw E.bad('Daten fehlen.');

  if (coll === 'portierung_files') {
    need(ctx);
    if (!FILE_ID.test(id)) throw E.denied();
    if (op === 'update') throw E.denied();
    return data;
  }
  need(ctx);

  switch (coll) {
    case 'users': {
      if (ctx.isAdmin) return data;
      if (id === ctx.uid && op === 'update' && Object.keys(data).every(k => ['name', 'vorname', 'nachname'].indexOf(k) !== -1)) return data;
      throw E.denied();
    }
    case 'analytics': {
      if (op === 'delete' || op === 'update') {
        if (ctx.isAdmin) return data;
        throw E.denied();
      }
      if (old && !ctx.isAdmin && ctx.ownUids.indexOf(String(old.userUid || '')) === -1) throw E.denied();
      const out = Object.assign({}, data);
      if (!ctx.isAdmin) {
        if (out.userUid && ctx.ownUids.indexOf(String(out.userUid)) === -1) throw E.denied('Zeile gehoert einem anderen Benutzer.');
        if (!out.userUid) out.userUid = ctx.uid;
      }
      if (out.shopId && !canShop(ctx, out.shopId) && !ctx.isAdmin) throw E.denied('Fremder Standort.');
      return out;
    }
    case 'saved_offers': {
      if (op === 'delete') {
        if (!old || ctx.isAdmin || canShop(ctx, old.shopId)) return data;
        throw E.denied();
      }
      const shop = (data && data.shopId) || (old && old.shopId);
      if (!ctx.isAdmin && (!canShop(ctx, shop) || (old && !canShop(ctx, old.shopId)))) throw E.denied('Fremder Standort.');
      return data;
    }
    case 'pdf_index': {
      if (op === 'delete') {
        if (!old || ctx.isAdmin || ctx.ownUids.indexOf(String(old.uid || '')) !== -1) return data;
        throw E.denied();
      }
      const shop = (data && data.shopId) || (old && old.shopId);
      if (!ctx.isAdmin && (!canShop(ctx, shop) || (old && !canShop(ctx, old.shopId)))) throw E.denied('Fremder Standort.');
      const out = Object.assign({}, data);
      if (!ctx.isAdmin && op === 'set') out.uid = ctx.uid;
      return out;
    }
    case 'skip_limits': {
      if (ctx.isStaff) return data;
      if (op === 'delete' || id.indexOf('skip_') !== 0) throw E.denied();
      // Mitarbeiter duerfen nur den eigenen Zaehler um 1 erhoehen.
      if (isInc(data.count, 1)) return data;
      throw E.denied();
    }
    case 'tool_usage': {
      if (ctx.isStaff) return data;
      if (op !== 'delete' && isInc(data.count, 1)) return data;
      throw E.denied();
    }
    case 'news':
      if (ctx.isStaff) return data;
      throw E.denied();
    case 'aktionsmappe':
      if (ctx.isAdmin) return data;
      throw E.denied();
    default:
      throw E.denied();
  }
}

// ---- Abfragen --------------------------------------------------------------
// Gibt eine Liste von Where-Varianten zurueck (Ergebnisse werden vereinigt).
function scopeQuery(ctx, coll, wheres) {
  need(ctx);
  const eq = f => wheres.filter(w => w[0] === f && w[1] === '==');
  const without = f => wheres.filter(w => !(w[0] === f && w[1] === '=='));
  switch (coll) {
    case 'users':
      if (ctx.isAdmin) return [wheres];
      throw E.denied();
    case 'analytics': {
      if (ctx.isStaff) return [wheres];
      const asked = eq('userUid');
      if (asked.some(w => ctx.ownUids.indexOf(String(w[2])) === -1)) throw E.denied();
      // Mitarbeiter sehen nur eigene Zeilen (inkl. aus Firebase uebernommener alter Kennungen)
      return ctx.ownUids.map(u => without('userUid').concat([['userUid', '==', u]]));
    }
    case 'saved_offers':
    case 'pdf_index': {
      const asked = eq('shopId');
      if (asked.length) {
        if (asked.some(w => !canShop(ctx, w[2]))) throw E.denied('Fremder Standort.');
        return [wheres];
      }
      if (ctx.allShops) return [wheres];
      if (!ctx.shops.length) throw E.denied();
      return ctx.shops.map(s => wheres.concat([['shopId', '==', s]]));
    }
    case 'skip_limits':
    case 'tool_usage':
    case 'news':
      if (ctx.isStaff) return [wheres];
      throw E.denied();
    case 'aktionsmappe':
      if (ctx.isAdmin) return [wheres];
      throw E.denied();
    default:
      throw E.denied();
  }
}

module.exports = { checkRead, checkWrite, scopeQuery, FILE_ID };

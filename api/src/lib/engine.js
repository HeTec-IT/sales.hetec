'use strict';
const crypto = require('crypto');
const { E } = require('./errors');
const rules = require('./rules');

const COLLECTIONS = ['users', 'analytics', 'saved_offers', 'pdf_index', 'skip_limits', 'tool_usage', 'news', 'aktionsmappe', 'portierung_files'];
const OPS = ['==', '!=', '<', '<=', '>', '>=', 'in', 'array-contains', 'array-contains-any'];
const MAX_BATCH = 500;
const MAX_RESULT = 100000;
const CACHE_TTL = 15000;
const PROFILE_TTL = 60000;
const FILE_TTL = 24 * 3600 * 1000;
const DELETE = Symbol('delete');

const isPlain = v => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v, what) => {
  if (typeof v !== 'string' || !v || v.length > 300) throw E.bad((what || 'Wert') + ' fehlt oder ist ungueltig.');
  return v;
};

// ---------------------------------------------------------------- Werte ----
function assertSafe(v, depth) {
  if ((depth || 0) > 20) throw E.bad('Daten zu tief verschachtelt.');
  if (Array.isArray(v)) { v.forEach(x => assertSafe(x, (depth || 0) + 1)); return; }
  if (isPlain(v)) {
    Object.keys(v).forEach(k => {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') throw E.bad('Ungueltiger Feldname.');
      assertSafe(v[k], (depth || 0) + 1);
    });
    return;
  }
  if (typeof v === 'function' || typeof v === 'symbol' || typeof v === 'bigint') throw E.bad('Ungueltiger Wert.');
}

// Platzhalter der App: increment / serverTimestamp / delete
function resolve(cur, v) {
  if (isPlain(v)) {
    if (v.__ps === 'inc') {
      if (typeof v.n !== 'number' || !isFinite(v.n)) throw E.bad('Ungueltiger Zaehlerwert.');
      return (typeof cur === 'number' ? cur : 0) + v.n;
    }
    if (v.__ps === 'ts') return Date.now();
    if (v.__ps === 'del') return DELETE;
    const out = {};
    Object.keys(v).forEach(k => {
      const r = resolve(isPlain(cur) ? cur[k] : undefined, v[k]);
      if (r !== DELETE) out[k] = r;
    });
    return out;
  }
  return v;
}

function deepMerge(base, data) {
  const out = Object.assign({}, base);
  Object.keys(data).forEach(k => {
    const v = data[k];
    if (isPlain(v) && !v.__ps && isPlain(out[k])) out[k] = deepMerge(out[k], v);
    else {
      const r = resolve(out[k], v);
      if (r === DELETE) delete out[k]; else out[k] = r;
    }
  });
  return out;
}

function applyUpdate(base, data) {
  const out = JSON.parse(JSON.stringify(base || {}));
  Object.keys(data).forEach(path => {
    const parts = path.split('.');
    let node = out;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!isPlain(node[parts[i]])) node[parts[i]] = {};
      node = node[parts[i]];
    }
    const last = parts[parts.length - 1];
    const r = resolve(node[last], data[path]);
    if (r === DELETE) delete node[last]; else node[last] = r;
  });
  return out;
}

function applyWrite(old, data, op, merge) {
  if (op === 'update') return applyUpdate(old, data);
  if (merge && old) return deepMerge(old, data);
  const r = resolve(undefined, data);
  return r;
}

// -------------------------------------------------------------- Abfragen ----
const getPath = (o, path) => path.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);

function valueOf(doc, field) {
  return field === '__name__' ? doc.id : getPath(doc.data, field);
}

function matches(doc, w) {
  const v = valueOf(doc, w[0]);
  const x = w[2];
  switch (w[1]) {
    case '==': return v !== undefined && v === x;
    case '!=': return v !== undefined && v !== x;
    case '<': return v !== undefined && typeof v === typeof x && v < x;
    case '<=': return v !== undefined && typeof v === typeof x && v <= x;
    case '>': return v !== undefined && typeof v === typeof x && v > x;
    case '>=': return v !== undefined && typeof v === typeof x && v >= x;
    case 'in': return Array.isArray(x) && x.indexOf(v) !== -1;
    case 'array-contains': return Array.isArray(v) && v.indexOf(x) !== -1;
    case 'array-contains-any': return Array.isArray(v) && Array.isArray(x) && x.some(y => v.indexOf(y) !== -1);
    default: return false;
  }
}

function cmpVal(a, b) {
  if (a === b) return 0;
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : 1;
  return String(a) < String(b) ? -1 : 1;
}

function normWheres(w) {
  if (w == null) return [];
  if (!Array.isArray(w) || w.length > 10) throw E.bad('where ungueltig.');
  return w.map(x => {
    if (!Array.isArray(x) || x.length !== 3) throw E.bad('where ungueltig.');
    const f = String(x[0]);
    if (!/^(__name__|[A-Za-z0-9_][A-Za-z0-9_.\-]{0,99})$/.test(f)) throw E.bad('Feldname ungueltig.');
    if (OPS.indexOf(x[1]) === -1) throw E.bad('Operator ungueltig.');
    assertSafe(x[2]);
    return [f, x[1], x[2]];
  });
}

function normOrder(o) {
  if (o == null) return [];
  if (!Array.isArray(o) || o.length > 3) throw E.bad('orderBy ungueltig.');
  return o.map(x => {
    const f = String(Array.isArray(x) ? x[0] : x);
    const d = Array.isArray(x) && x[1] === 'desc' ? 'desc' : 'asc';
    if (!/^(__name__|[A-Za-z0-9_][A-Za-z0-9_.\-]{0,99})$/.test(f)) throw E.bad('Feldname ungueltig.');
    return [f, d];
  });
}

class Engine {
  constructor(store) {
    this.store = store;
    this.cache = new Map();
    this.profiles = new Map();
  }

  dropCache(coll) {
    this.cache.forEach((v, k) => { if (v.coll === coll) this.cache.delete(k); });
  }

  // ----------------------------------------------------------- Profil ----
  deriveProfile(ctx, stored) {
    stored = stored || {};
    let vorname = ctx.given, nachname = ctx.family;
    if (!vorname && !nachname && ctx.name) {
      if (ctx.name.indexOf(',') !== -1) {
        nachname = ctx.name.split(',')[0].trim();
        vorname = ctx.name.split(',').slice(1).join(',').trim();
      } else {
        const p = ctx.name.split(/\s+/);
        vorname = p.length > 1 ? p[0] : '';
        nachname = p.length > 1 ? p.slice(1).join(' ') : p[0];
      }
    }
    const has = v => typeof v === 'string' && v.trim();
    const name = has(stored.name) ? stored.name : (ctx.name || ((vorname + ' ' + nachname).trim()) || ctx.email);
    return Object.assign({}, stored, {
      email: ctx.email,
      name,
      vorname: has(stored.vorname) || has(stored.nachname) ? (stored.vorname || '') : (vorname || ''),
      nachname: has(stored.nachname) ? stored.nachname : (has(stored.vorname) ? '' : (nachname || '')),
      role: ctx.isAdmin ? 'admin' : 'verkaeufer',
      regional: ctx.isRegional,
      allShops: ctx.allShops,
      active: ctx.active,
      status: ctx.active ? 'approved' : (ctx.reason || 'no-group'),
      shopId: ctx.isAdmin ? '' : ctx.home,
      shop: ctx.isAdmin ? 'Verwaltung / Alle Shops' : ctx.home,
      allowedShopIds: ctx.shops,
      isTestUser: stored.isTestUser === true,
      createdAt: stored.createdAt || Date.now()
    });
  }

  async ensureProfile(ctx) {
    const hit = this.profiles.get(ctx.uid);
    if (hit && Date.now() - hit.t < PROFILE_TTL) return hit.p;
    const cur = await this.store.get('users', ctx.uid);
    let base = cur ? cur.data : null;
    if (!base && ctx.active) {
      // Erstanmeldung: Profil eines frueheren Firebase-Kontos mit gleicher E-Mail uebernehmen
      try {
        const legacy = (await this.store.list('users', [['email', ctx.email]])).find(d => d.id !== ctx.uid);
        if (legacy) {
          const l = legacy.data;
          base = { legacyUids: [legacy.id].concat(Array.isArray(l.legacyUids) ? l.legacyUids : []) };
          ['name', 'vorname', 'nachname', 'anrede', 'isTestUser'].forEach(k => { if (l[k] !== undefined) base[k] = l[k]; });
        }
      } catch (e) { /* Uebernahme ist optional */ }
    }
    const profile = this.deriveProfile(ctx, base);
    if (ctx.active) {
      const hourAgo = Date.now() - 3600000;
      const stale = !cur || JSON.stringify(Object.assign({}, cur.data, { lastLoginAt: 0 })) !== JSON.stringify(Object.assign({}, profile, { lastLoginAt: 0 })) || !(cur.data.lastLoginAt > hourAgo);
      if (stale) {
        profile.lastLoginAt = Date.now();
        await this.store.put('users', ctx.uid, profile);
        this.dropCache('users');
      } else {
        profile.lastLoginAt = cur.data.lastLoginAt;
      }
    }
    this.profiles.set(ctx.uid, { t: Date.now(), p: profile });
    return profile;
  }

  async prepare(ctx, coll) {
    if (ctx && ctx.active && (coll === 'analytics' || coll === 'pdf_index') && !ctx._legacy) {
      const p = await this.ensureProfile(ctx);
      const ids = [ctx.uid].concat(Array.isArray(p.legacyUids) ? p.legacyUids.map(String) : []);
      ctx.ownUids = ids.filter((x, i) => ids.indexOf(x) === i);
      ctx._legacy = true;
    }
  }

  // ------------------------------------------------------------- Lesen ----
  async opGet(body, ctx) {
    const coll = this.coll(body.c);
    const id = str(body.id, 'id');
    if (coll === 'users' && ctx && id === ctx.uid) {
      return { doc: { id, data: await this.ensureProfile(ctx) } };
    }
    if (coll === 'portierung_files') {
      rules.checkRead(null, coll, id, null);
      const d = await this.store.get(coll, id);
      if (!d || (d.modified && Date.now() - d.modified > FILE_TTL)) return { doc: null };
      return { doc: { id, data: d.data } };
    }
    await this.prepare(ctx, coll);
    if (!ctx) throw E.unauth();
    const doc = await this.store.get(coll, id);
    rules.checkRead(ctx, coll, id, doc);
    return { doc: doc ? { id, data: doc.data } : null };
  }

  async runVariant(coll, wheres) {
    // Text/Ja-Nein-Gleichheit direkt im Speicher filtern, Rest hier
    const push = [], rest = [];
    wheres.forEach(w => {
      if (w[1] === '==' && w[0] !== '__name__' && /^[A-Za-z][A-Za-z0-9_]{0,59}$/.test(w[0]) && (typeof w[2] === 'string' ? w[2].length <= 500 : typeof w[2] === 'boolean')) push.push([w[0], w[2]]);
      else rest.push(w);
    });
    const idEq = rest.find(w => w[0] === '__name__' && w[1] === '==');
    let docs;
    if (idEq) {
      const d = await this.store.get(coll, String(idEq[2]));
      docs = d ? [{ id: d.id, data: d.data }] : [];
    } else {
      docs = await this.store.list(coll, push);
    }
    return docs.filter(d => rest.every(w => matches(d, w)));
  }

  async opQuery(body, ctx) {
    const coll = this.coll(body.c);
    await this.prepare(ctx, coll);
    const wheres = normWheres(body.where);
    const order = normOrder(body.orderBy);
    const limit = body.limit == null ? MAX_RESULT : Math.max(1, Math.min(Number(body.limit) || 0, MAX_RESULT));
    const variants = rules.scopeQuery(ctx, coll, wheres);
    const key = JSON.stringify([coll, variants, order]);
    let rows;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.t < CACHE_TTL) {
      rows = hit.rows;
    } else {
      const seen = new Map();
      for (const v of variants) {
        const part = await this.runVariant(coll, v);
        part.forEach(d => seen.set(d.id, d));
        if (seen.size > MAX_RESULT) throw E.bad('Zu viele Treffer.');
      }
      rows = Array.from(seen.values());
      const ord = order.length ? order : [['__name__', 'asc']];
      if (order.length) rows = rows.filter(d => order.every(o => valueOf(d, o[0]) !== undefined));
      rows.sort((a, b) => {
        for (const o of ord) {
          const c = cmpVal(valueOf(a, o[0]), valueOf(b, o[0]));
          if (c) return o[1] === 'desc' ? -c : c;
        }
        return cmpVal(a.id, b.id);
      });
      this.cache.set(key, { t: Date.now(), rows, coll });
      if (this.cache.size > 50) this.cache.delete(this.cache.keys().next().value);
    }
    let start = 0;
    if (body.after) {
      const ord = order.length ? order : [['__name__', 'asc']];
      const vals = Array.isArray(body.after.values) ? body.after.values : [];
      const afterId = String(body.after.id || '');
      const pos = rows.findIndex(d => d.id === afterId);
      if (pos !== -1) start = pos + 1;
      else {
        start = rows.findIndex(d => {
          for (let i = 0; i < ord.length; i++) {
            const c = cmpVal(valueOf(d, ord[i][0]), vals[i]);
            if (c) return (ord[i][1] === 'desc' ? -c : c) > 0;
          }
          return cmpVal(d.id, afterId) > 0;
        });
        if (start === -1) start = rows.length;
      }
    }
    const page = rows.slice(start, start + limit);
    return { docs: page.map(d => ({ id: d.id, data: d.data })), more: start + limit < rows.length };
  }

  // ----------------------------------------------------------- Schreiben ----
  async writeOne(w, ctx) {
    const op = w.op;
    if (['set', 'update', 'delete', 'add'].indexOf(op) === -1) throw E.bad('Unbekannte Schreib-Operation.');
    const coll = this.coll(w.c);
    await this.prepare(ctx, coll);
    const wop = op === 'add' ? 'set' : op;
    const id = op === 'add' ? crypto.randomBytes(10).toString('hex') : str(w.id, 'id');
    if (wop !== 'delete') { if (!isPlain(w.data)) throw E.bad('Daten fehlen.'); assertSafe(w.data); }
    if (!ctx) throw E.unauth();
    if (wop === 'delete') {
      const cur = await this.store.get(coll, id);
      rules.checkWrite(ctx, coll, id, 'delete', null, cur);
      await this.store.remove(coll, id);
    } else {
      await this.store.mutate(coll, id, old => {
        if (wop === 'update' && !old) throw E.notFound('Dokument existiert nicht.');
        const data = rules.checkWrite(ctx, coll, id, wop, w.data, old ? { data: old } : null);
        return applyWrite(old, data, wop, !!w.merge);
      });
    }
    this.dropCache(coll);
    if (coll === 'users') this.profiles.delete(id);
    if (coll === 'portierung_files' && /-0$/.test(id) && wop === 'set') await this.cleanupFiles();
    return { id };
  }

  async cleanupFiles() {
    try {
      const all = await this.store.listMeta('portierung_files');
      const old = all.filter(d => d.modified && Date.now() - d.modified > FILE_TTL + 3600000);
      for (const d of old.slice(0, 200)) await this.store.remove('portierung_files', d.id);
    } catch (e) { /* Aufraeumen ist best effort */ }
  }

  async opBatch(body, ctx) {
    if (!Array.isArray(body.ops) || !body.ops.length || body.ops.length > MAX_BATCH) throw E.bad('Batch ungueltig.');
    let n = 0;
    for (const w of body.ops) {
      if (w.op === 'add') throw E.bad('add im Batch nicht erlaubt.');
      await this.writeOne(w, ctx);
      n++;
    }
    return { n };
  }

  coll(c) {
    if (COLLECTIONS.indexOf(c) === -1) throw E.denied('Unbekannte Sammlung.');
    return c;
  }

  async handle(body, ctx) {
    if (!isPlain(body)) throw E.bad('Anfrage ungueltig.');
    switch (body.op) {
      case 'get': return this.opGet(body, ctx);
      case 'query': return this.opQuery(body, ctx);
      case 'set': case 'update': case 'delete': case 'add': return this.writeOne(body, ctx);
      case 'batch': return this.opBatch(body, ctx);
      default: throw E.bad('Unbekannte Operation.');
    }
  }
}

module.exports = { Engine, COLLECTIONS };

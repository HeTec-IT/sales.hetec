'use strict';
const { TableClient } = require('@azure/data-tables');
const { E } = require('./errors');

// Dokumentenspeicher auf Azure Table Storage.
//   PartitionKey = Sammlung (z. B. "analytics"), RowKey = Dokument-ID.
//   Das Dokument liegt als JSON in mehreren Text-Spalten (j0, j1, ...), weil eine
//   Spalte maximal 32.000 Zeichen fasst. Einfache Felder (Text/Ja-Nein) werden
//   zusaetzlich als Spalte f_<feld> abgelegt, damit der Speicher nach ihnen
//   filtern kann (z. B. shopId == 'aalen') statt alles zu laden.
const CHUNK = 30000;
const MAX_DOC = 450000; // Zeichen; Tabellenzeile max. 1 MB (UTF-16)
const MAX_LIST = 100000;

function encKey(id) {
  // Verbotene Zeichen in Tabellenschluesseln: / \ # ? und Steuerzeichen
  return String(id).replace(/[\\/#?%\u0000-\u001f\u007f-\u009f]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
}

function validKey(s) {
  return typeof s === 'string' && s.length > 0 && s.length <= 300;
}

function splitJson(json) {
  const parts = [];
  let i = 0;
  while (i < json.length) {
    let end = Math.min(i + CHUNK, json.length);
    // keine Surrogat-Paare (z. B. Emoji) mitten durchtrennen
    if (end < json.length) {
      const c = json.charCodeAt(end - 1);
      if (c >= 0xd800 && c <= 0xdbff) end--;
    }
    parts.push(json.slice(i, end));
    i = end;
  }
  return parts.length ? parts : ['{}'];
}

// JSON rein als ASCII ablegen (Nicht-ASCII-Zeichen als \uXXXX): damit gibt es keine
// Probleme mit Umlauten/Emoji an Teilgrenzen oder in der Uebertragung.
function asciiJson(data) {
  return JSON.stringify(data).replace(/[\u007f-\uffff]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

function toEntity(coll, id, data) {
  const json = asciiJson(data);
  if (json.length > MAX_DOC) throw E.bad('Dokument zu gross (' + json.length + ' Zeichen).');
  const parts = splitJson(json);
  const e = { partitionKey: coll, rowKey: encKey(id), docid: String(id), jn: parts.length };
  // Filterfelder zuerst (kurz), danach die langen JSON-Spalten
  Object.keys(data).forEach(k => {
    const v = data[k];
    if (!/^[A-Za-z][A-Za-z0-9_]{0,59}$/.test(k)) return;
    if (typeof v === 'boolean' || (typeof v === 'string' && v.length <= 500)) e['f_' + k] = v;
  });
  parts.forEach((p, i) => { e['j' + i] = p; });
  return e;
}

function fromEntity(e) {
  const n = Number(e.jn) || 1;
  let json = '';
  for (let i = 0; i < n; i++) json += e['j' + i] || '';
  return { id: String(e.docid), data: JSON.parse(json || '{}') };
}

function odataStr(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

function isNotFound(err) {
  return err && (err.statusCode === 404 || err.code === 'ResourceNotFound' || err.code === 'EntityNotFound');
}

class Store {
  constructor(client) {
    this.client = client;
    this.ready = null;
  }

  static fromConfig(cfg) {
    if (!cfg.storageConnection) throw new Error('PS_STORAGE_CONNECTION fehlt');
    const client = TableClient.fromConnectionString(cfg.storageConnection, cfg.table, { allowInsecureConnection: /^UseDevelopmentStorage|127\.0\.0\.1|localhost/i.test(cfg.storageConnection) });
    return new Store(client);
  }

  async init() {
    if (!this.ready) {
      this.ready = this.client.createTable().catch(err => {
        if (err && (err.statusCode === 409 || err.code === 'TableAlreadyExists')) return;
        this.ready = null;
        throw err;
      });
    }
    return this.ready;
  }

  async get(coll, id) {
    if (!validKey(coll) || !validKey(String(id))) throw E.bad('Ungueltige Dokument-ID.');
    await this.init();
    try {
      const e = await this.client.getEntity(coll, encKey(id));
      const d = fromEntity(e);
      return { id: d.id, data: d.data, etag: e.etag, modified: e.timestamp ? Date.parse(e.timestamp) : 0 };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  // Ersetzt das Dokument. etag: nur schreiben, wenn unveraendert (sonst 412).
  // create=true: nur anlegen, wenn es noch nicht existiert (sonst 409).
  async put(coll, id, data, opts) {
    if (!validKey(coll) || !validKey(String(id))) throw E.bad('Ungueltige Dokument-ID.');
    opts = opts || {};
    await this.init();
    const e = toEntity(coll, id, data);
    if (opts.create) return this.client.createEntity(e);
    if (opts.etag) return this.client.updateEntity(e, 'Replace', { etag: opts.etag });
    return this.client.upsertEntity(e, 'Replace');
  }

  async remove(coll, id) {
    if (!validKey(coll) || !validKey(String(id))) throw E.bad('Ungueltige Dokument-ID.');
    await this.init();
    try {
      await this.client.deleteEntity(coll, encKey(id));
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }

  // Alle Dokumente einer Sammlung; equals = [[feld, wert], ...] wird im Speicher gefiltert.
  async list(coll, equals) {
    if (!validKey(coll)) throw E.bad('Ungueltige Sammlung.');
    await this.init();
    let filter = 'PartitionKey eq ' + odataStr(coll);
    (equals || []).forEach(p => {
      const v = p[1];
      filter += ' and f_' + p[0] + ' eq ' + (typeof v === 'boolean' ? (v ? 'true' : 'false') : odataStr(v));
    });
    const out = [];
    for await (const e of this.client.listEntities({ queryOptions: { filter } })) {
      out.push(fromEntity(e));
      if (out.length > MAX_LIST) throw E.bad('Zu viele Dokumente.');
    }
    return out;
  }

  // Nur Kennungen + Aenderungszeit (ohne die grossen Inhalte) - z. B. zum Aufraeumen.
  async listMeta(coll) {
    if (!validKey(coll)) throw E.bad('Ungueltige Sammlung.');
    await this.init();
    const out = [];
    const filter = 'PartitionKey eq ' + odataStr(coll);
    for await (const e of this.client.listEntities({ queryOptions: { filter, select: ['docid'] } })) {
      out.push({ id: String(e.docid), modified: e.timestamp ? Date.parse(e.timestamp) : 0 });
      if (out.length > MAX_LIST) break;
    }
    return out;
  }

  // Lesen-aendern-schreiben mit Konfliktpruefung (fuer increment & update).
  async mutate(coll, id, fn) {
    for (let attempt = 0; attempt < 25; attempt++) {
      // Bei gleichzeitigen Schreibzugriffen auf dasselbe Dokument mit zufaelliger Pause erneut versuchen
      if (attempt) await new Promise(r => setTimeout(r, Math.random() * Math.min(15 * attempt, 120)));
      const cur = await this.get(coll, id);
      const next = fn(cur ? cur.data : null);
      try {
        if (cur) await this.put(coll, id, next, { etag: cur.etag });
        else await this.put(coll, id, next, { create: true });
        return next;
      } catch (err) {
        const st = err && err.statusCode;
        if (st === 412 || st === 409) continue;
        throw err;
      }
    }
    throw E.conflict();
  }
}

module.exports = { Store, encKey, toEntity, fromEntity, CHUNK, MAX_DOC };

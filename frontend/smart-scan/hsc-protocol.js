/*
 * HeTec Smart Capture – Übertragungsprotokoll HSC (Version 1)
 * ============================================================
 * Gemeinsames Modul für Smart Capture (Encoder) und Pencil Selling (Decoder). Beide Repositories enthalten
 * diese Datei byte-identisch (Prüfung per Test: tests/protocol-sync). Spezifikation: docs/PROTOCOL.md.
 *
 * QR-Inhalt (je QR-Code eine Zeile, nur Zeichen A–Z a–z 0–9 : / _ -):
 *   HSC1:<id>:<teil>/<anzahl>:<crc32>:<daten>
 *     id      10 Zeichen [0-9a-z], zufällig je Angebot
 *     teil    1..anzahl, anzahl 1..8 (Mehrfach-QR bei großen Angeboten)
 *     crc32   8 Hex-Zeichen über den vollständigen Datenteil (alle Teile aneinandergehängt) – nur Fehlererkennung,
 *             KEINE Authentifizierung
 *     daten   Typ-Zeichen + Base64url: 'z' = JSON deflate-raw-komprimiert, 'j' = JSON unkomprimiert
 *
 * Nutzlast: kompaktes JSON mit strikter Allowlist (siehe validate()). Keine Kundendaten, keine OCR-Rohtexte.
 * Klassisches Skript (window.HSC) und CommonJS (require) – ohne Build, ohne Abhängigkeiten.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.HSC = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var PREFIX = 'HSC1';
  var SCHEMA = 1;
  var TTL_DEFAULT = 120; // Sekunden – Standard-Gültigkeit eines QR-Codes
  var CHUNK = 700;       // Zeichen Datenteil je QR-Code (≈ QR-Version 22, gut scanbar vom PC-Monitor, Fehlerkorrektur M)
  var LIMITS = Object.freeze({
    tarife: 6, geraete: 6, internet: 2, zusatz: 6,
    name: 80, art: 40, detail: 90, details: 12, pages: 20, warnings: 12, priceChanges: 4,
    partLen: 1200, parts: 8, bodyLen: 8000, jsonLen: 16384,
    cents: 10000000, ttlMax: 600, skew: 300
  });
  var ARTEN = ['Neuvertrag', 'Neukunde', 'Vertragsverlängerung', 'Tarifwechsel', 'Rufnummernmitnahme', 'Portierung', 'Zweitkarte', 'Partnerkarte'];
  var WARN = Object.freeze({
    SUM_E: 'Einmalige Summe passt nicht zu den Einzelpreisen',
    SUM_M: 'Monatliche Summe passt nicht zu den Einzelpreisen',
    MISS_E: 'Einmalige Gesamtkosten nicht erkannt',
    MISS_M: 'Monatliche Gesamtkosten nicht erkannt',
    PRICE: 'Nicht alle Einzelpreise erkannt',
    NOCHECK: 'Summen konnten nicht geprüft werden',
    PII: 'Mögliche personenbezogene Angaben wurden entfernt',
    OVERLAP: 'Überschneidung zwischen Seiten erkannt – bitte prüfen',
    PAGES: 'Möglicherweise fehlt eine Seite',
    ZUSATZ: 'Zusatzprodukt erkannt – bitte prüfen',
    UNSURE: 'Einzelne Angaben unsicher erkannt'
  });
  var ERR = Object.freeze({
    NOT_HSC: 'Das ist kein QR-Code von HeTec Smart Capture.',
    FORMAT: 'QR-Code unvollständig oder beschädigt – bitte erneut scannen.',
    VERSION: 'QR-Code stammt von einer anderen Smart-Capture-Version. Bitte am PC einen neuen QR-Code erzeugen.',
    CHECKSUM: 'Prüfsumme stimmt nicht – QR-Code bitte erneut scannen.',
    INCOMPLETE: 'Es fehlen noch Teile dieses Mehrfach-QR-Codes.',
    MIXED: 'Die gescannten Teile gehören zu verschiedenen Angeboten.',
    TOO_LARGE: 'Angebot ist zu umfangreich für die Übertragung.',
    DECODE: 'Angebotsdaten nicht lesbar – bitte am PC einen neuen QR-Code erzeugen.',
    INVALID: 'Angebotsdaten ungültig – Import abgelehnt.',
    PERSONAL_DATA: 'QR-Code enthält unzulässige personenbezogene Angaben – Import abgelehnt.',
    EXPIRED: 'Der QR-Code ist abgelaufen. Bitte am PC „QR-Code erneuern“ wählen.',
    FUTURE: 'Zeitstempel des QR-Codes liegt in der Zukunft – Uhrzeit von PC und Tablet prüfen.'
  });

  function fail(code, detail) { var e = new Error(ERR[code] || code); e.hscCode = code; if (detail) e.detail = detail; return e; }

  // ---------- Personenbezogene Daten erkennen (Allowlist-Ergänzung, gilt für jede übertragene Zeichenkette) ----------
  var PII_RULES = [
    ['iban', /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){3,7}(?:[ ]?[A-Z0-9]{1,3})?\b/],
    ['email', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
    ['keyword', /\b(?:Kunden[- ]?(?:nummer|nr)|Vertrags[- ]?(?:nummer|nr|konto)|Rufnummer|Telefon(?:nummer)?|Tel\.|Mobil(?:funk)?nummer|Handynummer|E-?Mail|IBAN|BIC|Kontoinhaber|Bankverbindung|SEPA|Ausweis|Personalausweis|Reisepass|Geburtsdatum|Geburtstag|geb\.|Anschrift|Adresse|Installationsadresse|Lieferadresse|Herr|Frau|Kundenname|Name:|MSISDN|ICCID|SIM[- ]?Nr|Steuer-?ID|Beratungs[- ]?ID|Auftrags[- ]?(?:nummer|nr)|Kunden[- ]?Kennwort)\b/i],
    ['phone', /(?:\+|00)\s?4\d[\s\d\/()-]{7,}\d|\b0\d{2,5}[\s\/-]?\d{3,}[\s-]?\d{2,}\b/],
    ['date', /\b(?:0?[1-9]|[12]\d|3[01])\.(?:0?[1-9]|1[0-2])\.(?:19\d{2}|20[01]\d)\b/],
    ['postal', /\b\d{5}\s+[A-ZÄÖÜ][a-zäöüß]{2,}/],
    ['street', /[A-Za-zÄÖÜäöüß]{3,}(?:straße|strasse|str\.|weg|gasse|platz|allee|ring|damm|ufer|steig|chaussee)\s*\d{1,4}\s?[a-z]?\b/i],
    ['number', /\d(?:[\s.-]?\d){8,}/]
  ];
  function personalData(s) {
    s = String(s == null ? '' : s);
    if (!s) return null;
    for (var i = 0; i < PII_RULES.length; i++) if (PII_RULES[i][1].test(s)) return PII_RULES[i][0];
    return null;
  }

  // ---------- Hilfen ----------
  var CRC_T = (function () { var t = new Array(256); for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(str) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < str.length; i++) c = CRC_T[(c ^ str.charCodeAt(i)) & 0xFF] ^ (c >>> 8);
    return ('00000000' + ((c ^ 0xFFFFFFFF) >>> 0).toString(16)).slice(-8);
  }
  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  var B64R = (function () { var r = {}; for (var i = 0; i < 64; i++) r[B64.charAt(i)] = i; return r; })();
  function b64urlEncode(bytes) {
    var out = '', i = 0;
    for (; i + 2 < bytes.length; i += 3) { var n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]; out += B64[n >> 18 & 63] + B64[n >> 12 & 63] + B64[n >> 6 & 63] + B64[n & 63]; }
    if (i < bytes.length) { var m = bytes[i] << 16 | (i + 1 < bytes.length ? bytes[i + 1] << 8 : 0); out += B64[m >> 18 & 63] + B64[m >> 12 & 63] + (i + 1 < bytes.length ? B64[m >> 6 & 63] : ''); }
    return out;
  }
  function b64urlDecode(s) {
    if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) throw fail('FORMAT');
    var out = new Uint8Array(Math.floor(s.length * 3 / 4)), o = 0, i = 0;
    for (; i + 3 < s.length; i += 4) { var n = B64R[s[i]] << 18 | B64R[s[i + 1]] << 12 | B64R[s[i + 2]] << 6 | B64R[s[i + 3]]; out[o++] = n >> 16 & 255; out[o++] = n >> 8 & 255; out[o++] = n & 255; }
    var rest = s.length - i;
    if (rest >= 2) { var m = B64R[s[i]] << 18 | B64R[s[i + 1]] << 12 | (rest > 2 ? B64R[s[i + 2]] << 6 : 0); out[o++] = m >> 16 & 255; if (rest > 2) out[o++] = m >> 8 & 255; }
    return out.subarray(0, o);
  }
  function utf8Encode(s) { return new TextEncoder().encode(s); }
  function utf8Decode(b) { return new TextDecoder('utf-8', { fatal: true }).decode(b); }
  function randomId() {
    var a = new Uint8Array(10), abc = '0123456789abcdefghijklmnopqrstuvwxyz', s = '';
    (globalThis.crypto || {}).getRandomValues ? globalThis.crypto.getRandomValues(a) : a.forEach(function (_, i) { a[i] = Math.floor(Math.random() * 256); });
    for (var i = 0; i < a.length; i++) s += abc[a[i] % 36];
    return s;
  }

  /* tiny-inflate 1.0.3 (MIT License, Copyright (c) 2015-present Devon Govett) – Dekompression ohne Browser-Abhängigkeit */
  var inflateRaw = (function () {
    var TINF_OK = 0, TINF_DATA_ERROR = -3;
    function Tree() { this.table = new Uint16Array(16); this.trans = new Uint16Array(288); }
    function Data(source, dest) { this.source = source; this.sourceIndex = 0; this.tag = 0; this.bitcount = 0; this.dest = dest; this.destLen = 0; this.ltree = new Tree(); this.dtree = new Tree(); }
    var sltree = new Tree(), sdtree = new Tree(), length_bits = new Uint8Array(30), length_base = new Uint16Array(30), dist_bits = new Uint8Array(30), dist_base = new Uint16Array(30);
    var clcidx = new Uint8Array([16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]);
    var code_tree = new Tree(), lengths = new Uint8Array(288 + 32);
    function tinf_build_bits_base(bits, base, delta, first) { var i, sum; for (i = 0; i < delta; ++i) bits[i] = 0; for (i = 0; i < 30 - delta; ++i) bits[i + delta] = i / delta | 0; for (sum = first, i = 0; i < 30; ++i) { base[i] = sum; sum += 1 << bits[i]; } }
    function tinf_build_fixed_trees(lt, dt) { var i; for (i = 0; i < 7; ++i) lt.table[i] = 0; lt.table[7] = 24; lt.table[8] = 152; lt.table[9] = 112; for (i = 0; i < 24; ++i) lt.trans[i] = 256 + i; for (i = 0; i < 144; ++i) lt.trans[24 + i] = i; for (i = 0; i < 8; ++i) lt.trans[24 + 144 + i] = 280 + i; for (i = 0; i < 112; ++i) lt.trans[24 + 144 + 8 + i] = 144 + i; for (i = 0; i < 5; ++i) dt.table[i] = 0; dt.table[5] = 32; for (i = 0; i < 32; ++i) dt.trans[i] = i; }
    var offs = new Uint16Array(16);
    function tinf_build_tree(t, lengths, off, num) { var i, sum; for (i = 0; i < 16; ++i) t.table[i] = 0; for (i = 0; i < num; ++i) t.table[lengths[off + i]]++; t.table[0] = 0; for (sum = 0, i = 0; i < 16; ++i) { offs[i] = sum; sum += t.table[i]; } for (i = 0; i < num; ++i) if (lengths[off + i]) t.trans[offs[lengths[off + i]]++] = i; }
    function tinf_getbit(d) { if (!d.bitcount--) { d.tag = d.source[d.sourceIndex++]; d.bitcount = 7; } var bit = d.tag & 1; d.tag >>>= 1; return bit; }
    function tinf_read_bits(d, num, base) { if (!num) return base; while (d.bitcount < 24) { d.tag |= d.source[d.sourceIndex++] << d.bitcount; d.bitcount += 8; } var val = d.tag & (0xffff >>> (16 - num)); d.tag >>>= num; d.bitcount -= num; return val + base; }
    function tinf_decode_symbol(d, t) { while (d.bitcount < 24) { d.tag |= d.source[d.sourceIndex++] << d.bitcount; d.bitcount += 8; } var sum = 0, cur = 0, len = 0, tag = d.tag; do { cur = 2 * cur + (tag & 1); tag >>>= 1; ++len; sum += t.table[len]; cur -= t.table[len]; } while (cur >= 0); d.tag = tag; d.bitcount -= len; return t.trans[sum + cur]; }
    function tinf_decode_trees(d, lt, dt) { var hlit, hdist, hclen, i, num, length; hlit = tinf_read_bits(d, 5, 257); hdist = tinf_read_bits(d, 5, 1); hclen = tinf_read_bits(d, 4, 4); for (i = 0; i < 19; ++i) lengths[i] = 0; for (i = 0; i < hclen; ++i) { var clen = tinf_read_bits(d, 3, 0); lengths[clcidx[i]] = clen; } tinf_build_tree(code_tree, lengths, 0, 19); for (num = 0; num < hlit + hdist;) { var sym = tinf_decode_symbol(d, code_tree); switch (sym) { case 16: var prev = lengths[num - 1]; for (length = tinf_read_bits(d, 2, 3); length; --length) lengths[num++] = prev; break; case 17: for (length = tinf_read_bits(d, 3, 3); length; --length) lengths[num++] = 0; break; case 18: for (length = tinf_read_bits(d, 7, 11); length; --length) lengths[num++] = 0; break; default: lengths[num++] = sym; break; } } tinf_build_tree(lt, lengths, 0, hlit); tinf_build_tree(dt, lengths, hlit, hdist); }
    function tinf_inflate_block_data(d, lt, dt) { while (1) { var sym = tinf_decode_symbol(d, lt); if (sym === 256) return TINF_OK; if (sym < 256) { d.dest[d.destLen++] = sym; } else { var length, dist, offs2, i; sym -= 257; length = tinf_read_bits(d, length_bits[sym], length_base[sym]); dist = tinf_decode_symbol(d, dt); offs2 = d.destLen - tinf_read_bits(d, dist_bits[dist], dist_base[dist]); for (i = offs2; i < offs2 + length; ++i) d.dest[d.destLen++] = d.dest[i]; } } }
    function tinf_inflate_uncompressed_block(d) { var length, invlength, i; while (d.bitcount > 8) { d.sourceIndex--; d.bitcount -= 8; } length = d.source[d.sourceIndex + 1]; length = 256 * length + d.source[d.sourceIndex]; invlength = d.source[d.sourceIndex + 3]; invlength = 256 * invlength + d.source[d.sourceIndex + 2]; if (length !== (~invlength & 0x0000ffff)) return TINF_DATA_ERROR; d.sourceIndex += 4; for (i = length; i; --i) d.dest[d.destLen++] = d.source[d.sourceIndex++]; d.bitcount = 0; return TINF_OK; }
    function tinf_uncompress(source, dest) { var d = new Data(source, dest), bfinal, btype, res; do { bfinal = tinf_getbit(d); btype = tinf_read_bits(d, 2, 0); switch (btype) { case 0: res = tinf_inflate_uncompressed_block(d); break; case 1: res = tinf_inflate_block_data(d, sltree, sdtree); break; case 2: tinf_decode_trees(d, d.ltree, d.dtree); res = tinf_inflate_block_data(d, d.ltree, d.dtree); break; default: res = TINF_DATA_ERROR; } if (res !== TINF_OK) throw new Error('Data error'); if (d.sourceIndex > d.source.length + 4) throw new Error('Data error'); } while (!bfinal); return d.destLen < d.dest.length ? d.dest.subarray(0, d.destLen) : d.dest; }
    tinf_build_fixed_trees(sltree, sdtree); tinf_build_bits_base(length_bits, length_base, 4, 3); tinf_build_bits_base(dist_bits, dist_base, 2, 1); length_bits[28] = 0; length_base[28] = 258;
    return function (bytes, max) {
      var out = tinf_uncompress(bytes, new Uint8Array(max + 1));
      if (out.length > max) throw fail('DECODE', 'zu groß');
      return out;
    };
  })();

  async function deflateRaw(bytes) {
    if (typeof CompressionStream === 'undefined') return null;
    try {
      var stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (e) { return null; }
  }

  // ---------- Validierung (gemeinsam für Encoder und Decoder) ----------
  var INT = function (v) { return typeof v === 'number' && isFinite(v) && Math.floor(v) === v; };
  function cleanText(v, max, field) {
    if (typeof v !== 'string') throw fail('INVALID', field + ': kein Text');
    // Steuerzeichen, Bidi-Steuerung und spitze Klammern sind nie zulässig
    if (/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩<>]/.test(v)) throw fail('INVALID', field + ': unzulässige Zeichen');
    var s = v.replace(/\s+/g, ' ').trim();
    if (s.length > max) throw fail('INVALID', field + ': zu lang');
    if (personalData(s)) throw fail('PERSONAL_DATA', field + ': ' + personalData(s));
    return s;
  }
  function cents(v, field, allowNull, min) {
    if (v === null && allowNull) return null;
    if (!INT(v) || v < (min == null ? 0 : min) || v > LIMITS.cents) throw fail('INVALID', field + ': Betrag');
    return v;
  }
  function onlyKeys(o, keys, field) {
    if (!o || typeof o !== 'object' || Array.isArray(o)) throw fail('INVALID', field + ': kein Objekt');
    Object.keys(o).forEach(function (k) { if (keys.indexOf(k) < 0) throw fail('INVALID', field + ': unbekanntes Feld ' + k); });
  }
  // Lesbares Angebot (Smart-Capture-intern / Pencil-Selling-Ergebnis) prüfen und normalisieren
  var ITEM_KEYS = ['name', 'art', 'details', 'e', 'm', 're', 'rm', 'ak', 'rbBad', 'unsure', 't'];
  function normItem(it, kind, i, nTarife) {
    var f = kind + '[' + i + ']';
    onlyKeys(it, ITEM_KEYS, f);
    var name = cleanText(it.name, LIMITS.name, f + '.name');
    if (name.length < 2) throw fail('INVALID', f + '.name: leer');
    var art = it.art == null || it.art === '' ? '' : cleanText(it.art, LIMITS.art, f + '.art');
    if (art && ARTEN.indexOf(art) < 0) throw fail('INVALID', f + '.art: unbekannt');
    var det = it.details == null ? [] : it.details;
    if (!Array.isArray(det) || det.length > LIMITS.details) throw fail('INVALID', f + '.details');
    det = det.map(function (d, k) { return cleanText(d, LIMITS.detail, f + '.details[' + k + ']'); }).filter(Boolean);
    var o = {
      name: name, art: art, details: det,
      e: cents(it.e == null ? null : it.e, f + '.e', true),
      m: cents(it.m == null ? null : it.m, f + '.m', true),
      re: cents(it.re == null ? 0 : it.re, f + '.re', false, -LIMITS.cents),
      rm: cents(it.rm == null ? 0 : it.rm, f + '.rm', false, -LIMITS.cents),
      ak: !!it.ak, rbBad: !!it.rbBad, unsure: !!it.unsure
    };
    if (o.re > 0 || o.rm > 0) throw fail('INVALID', f + ': Rabatt positiv');
    if (o.ak && kind !== 'tarife') throw fail('INVALID', f + ': Aktionskarte nur bei Tarifen');
    if (kind === 'geraete' && it.t != null) {
      if (!INT(it.t) || it.t < 0 || it.t > nTarife) throw fail('INVALID', f + '.t');
      o.t = it.t;
    } else if (it.t != null) throw fail('INVALID', f + '.t nur bei Geräten');
    return o;
  }
  var OFFER_KEYS = ['id', 'rev', 'created', 'expires', 'pages', 'quality', 'tarife', 'geraete', 'internet', 'zusatz', 'einmalig', 'monatlich', 'priceChanges'];
  function validate(o) {
    onlyKeys(o, OFFER_KEYS, 'angebot');
    if (typeof o.id !== 'string' || !/^[0-9a-z]{10}$/.test(o.id)) throw fail('INVALID', 'id');
    if (!INT(o.rev) || o.rev < 1 || o.rev > 999) throw fail('INVALID', 'rev');
    if (!INT(o.created) || !INT(o.expires) || o.expires <= o.created || o.expires - o.created > LIMITS.ttlMax) throw fail('INVALID', 'Gültigkeit');
    if (!INT(o.pages) || o.pages < 1 || o.pages > LIMITS.pages) throw fail('INVALID', 'pages');
    var q = o.quality || { score: 0, warnings: [] };
    onlyKeys(q, ['score', 'warnings'], 'quality');
    if (!INT(q.score) || q.score < 0 || q.score > 100) throw fail('INVALID', 'quality.score');
    var w = q.warnings || [];
    if (!Array.isArray(w) || w.length > LIMITS.warnings || w.some(function (x) { return !Object.prototype.hasOwnProperty.call(WARN, x); })) throw fail('INVALID', 'quality.warnings');
    var lists = {};
    ['tarife', 'internet', 'zusatz', 'geraete'].forEach(function (k) {
      var a = o[k] == null ? [] : o[k];
      if (!Array.isArray(a) || a.length > LIMITS[k]) throw fail('INVALID', k + ': Anzahl');
      lists[k] = a.map(function (it, i) { return normItem(it, k, i, (lists.tarife || []).length); });
    });
    var pc = o.priceChanges == null ? [] : o.priceChanges;
    if (!Array.isArray(pc) || pc.length > LIMITS.priceChanges) throw fail('INVALID', 'priceChanges');
    pc = pc.map(function (p, i) {
      onlyKeys(p, ['month', 'm'], 'priceChanges[' + i + ']');
      if (!INT(p.month) || p.month < 2 || p.month > 60) throw fail('INVALID', 'priceChanges.month');
      return { month: p.month, m: cents(p.m, 'priceChanges.m') };
    });
    var n = lists.tarife.length + lists.geraete.length + lists.internet.length + lists.zusatz.length;
    var einmalig = cents(o.einmalig == null ? null : o.einmalig, 'einmalig', true), monatlich = cents(o.monatlich == null ? null : o.monatlich, 'monatlich', true);
    if (!n && einmalig == null && monatlich == null) throw fail('INVALID', 'leeres Angebot');
    return {
      id: o.id, rev: o.rev, created: o.created, expires: o.expires, pages: o.pages,
      quality: { score: q.score, warnings: w.slice() },
      tarife: lists.tarife, geraete: lists.geraete, internet: lists.internet, zusatz: lists.zusatz,
      einmalig: einmalig, monatlich: monatlich, priceChanges: pc
    };
  }

  // ---------- Kompaktform (kurze Schlüssel, Positionen als Arrays) ----------
  // Position: [name, art, details[], e, m, re, rm, flags, t]  flags: 1 Aktionskarte, 2 Rabatt unlesbar, 4 unsicher
  function packItem(it) {
    var fl = (it.ak ? 1 : 0) | (it.rbBad ? 2 : 0) | (it.unsure ? 4 : 0);
    var a = [it.name, it.art || '', it.details || [], it.e, it.m, it.re || 0, it.rm || 0, fl];
    if (it.t != null) a.push(it.t);
    return a;
  }
  function unpackItem(a, f) {
    if (!Array.isArray(a) || a.length < 8 || a.length > 9 || !INT(a[7]) || a[7] < 0 || a[7] > 7) throw fail('INVALID', f);
    var o = { name: a[0], art: a[1], details: a[2], e: a[3], m: a[4], re: a[5], rm: a[6], ak: !!(a[7] & 1), rbBad: !!(a[7] & 2), unsure: !!(a[7] & 4) };
    if (a.length === 9) o.t = a[8];
    return o;
  }
  function pack(o) {
    var p = { s: SCHEMA, id: o.id, r: o.rev, c: o.created, x: o.expires, p: o.pages, q: [o.quality.score, o.quality.warnings] };
    if (o.tarife.length) p.t = o.tarife.map(packItem);
    if (o.geraete.length) p.g = o.geraete.map(packItem);
    if (o.internet.length) p.i = o.internet.map(packItem);
    if (o.zusatz.length) p.z = o.zusatz.map(packItem);
    if (o.einmalig != null) p.e = o.einmalig;
    if (o.monatlich != null) p.m = o.monatlich;
    if (o.priceChanges.length) p.pa = o.priceChanges.map(function (x) { return [x.month, x.m]; });
    return p;
  }
  function unpack(p) {
    onlyKeys(p, ['s', 'id', 'r', 'c', 'x', 'p', 'q', 't', 'g', 'i', 'z', 'e', 'm', 'pa'], 'nutzlast');
    if (p.s !== SCHEMA) throw fail('VERSION');
    if (!Array.isArray(p.q) || p.q.length !== 2) throw fail('INVALID', 'q');
    var list = function (k, name) { if (p[k] == null) return []; if (!Array.isArray(p[k])) throw fail('INVALID', name); return p[k].map(function (a, i) { return unpackItem(a, name + '[' + i + ']'); }); };
    var pa = p.pa == null ? [] : p.pa;
    if (!Array.isArray(pa)) throw fail('INVALID', 'pa');
    return {
      id: p.id, rev: p.r, created: p.c, expires: p.x, pages: p.p,
      quality: { score: p.q[0], warnings: p.q[1] },
      tarife: list('t', 'tarife'), geraete: list('g', 'geraete'), internet: list('i', 'internet'), zusatz: list('z', 'zusatz'),
      einmalig: p.e == null ? null : p.e, monatlich: p.m == null ? null : p.m,
      priceChanges: pa.map(function (x) { if (!Array.isArray(x) || x.length !== 2) throw fail('INVALID', 'pa'); return { month: x[0], m: x[1] }; })
    };
  }

  // ---------- Encoder ----------
  /**
   * offer: lesbares Angebot ohne id/created/expires (werden ergänzt, wenn nicht gesetzt).
   * opts: { now: Sekunden, ttl: Sekunden, chunk: Zeichen, id, rev }
   * Rückgabe: { id, rev, created, expires, parts: [QR-Text, …], bytes }
   */
  async function encode(offer, opts) {
    opts = opts || {};
    var now = INT(opts.now) ? opts.now : Math.floor(Date.now() / 1000);
    var ttl = INT(opts.ttl) ? opts.ttl : TTL_DEFAULT;
    var src = {};
    Object.keys(offer || {}).forEach(function (k) { src[k] = offer[k]; });
    src.id = opts.id || src.id || randomId();
    src.rev = opts.rev || src.rev || 1;
    src.created = now; src.expires = now + ttl;
    var o = validate(src);
    var json = JSON.stringify(pack(o));
    if (json.length > LIMITS.jsonLen) throw fail('TOO_LARGE');
    var raw = utf8Encode(json), z = await deflateRaw(raw);
    var body = z && z.length < raw.length ? 'z' + b64urlEncode(z) : 'j' + b64urlEncode(raw);
    if (body.length > LIMITS.bodyLen) throw fail('TOO_LARGE');
    var chunk = INT(opts.chunk) && opts.chunk >= 100 ? opts.chunk : CHUNK;
    var n = Math.ceil(body.length / chunk);
    if (n > LIMITS.parts) throw fail('TOO_LARGE');
    var crc = crc32(body), parts = [];
    for (var i = 0; i < n; i++) parts.push(PREFIX + ':' + o.id + ':' + (i + 1) + '/' + n + ':' + crc + ':' + body.slice(i * chunk, (i + 1) * chunk));
    return { id: o.id, rev: o.rev, created: o.created, expires: o.expires, parts: parts, bytes: body.length };
  }

  // ---------- Decoder ----------
  var PART_RE = /^HSC(\d+):([0-9a-z]{10}):([1-8])\/([1-8]):([0-9a-f]{8}):([A-Za-z0-9_-]+)$/;
  /** Einen QR-Text prüfen (Kopf). Rückgabe { id, part, total, crc, data } oder wirft. */
  function parsePart(text) {
    text = String(text == null ? '' : text).trim();
    if (!/^HSC/.test(text)) throw fail('NOT_HSC');
    if (text.length > LIMITS.partLen) throw fail('FORMAT', 'zu lang');
    var m = PART_RE.exec(text);
    if (!m) { if (/^HSC(\d+):/.test(text) && !/^HSC1:/.test(text)) throw fail('VERSION'); throw fail('FORMAT'); }
    if (m[1] !== '1') throw fail('VERSION');
    var part = +m[3], total = +m[4];
    if (part > total) throw fail('FORMAT');
    return { id: m[2], part: part, total: total, crc: m[5], data: m[6] };
  }
  /** Sammelt Teile eines Mehrfach-QR-Codes. add(text) → { done, have, total, id } ; wirft bei fremden/kaputten Teilen. */
  function Collector() { this.id = null; this.total = 0; this.crc = null; this.parts = {}; }
  Collector.prototype.add = function (text) {
    var p = parsePart(text);
    if (this.id && (p.id !== this.id || p.total !== this.total || p.crc !== this.crc)) throw fail('MIXED');
    this.id = p.id; this.total = p.total; this.crc = p.crc; this.parts[p.part] = p.data;
    return { done: this.have() === this.total, have: this.have(), total: this.total, id: this.id, part: p.part };
  };
  Collector.prototype.have = function () { return Object.keys(this.parts).length; };
  Collector.prototype.body = function () {
    if (!this.id || this.have() !== this.total) throw fail('INCOMPLETE');
    var s = ''; for (var i = 1; i <= this.total; i++) s += this.parts[i];
    return s;
  };
  Collector.prototype.reset = function () { Collector.call(this); };

  /**
   * Vollständig dekodieren und validieren. input: QR-Text, Array von QR-Texten oder Collector.
   * opts: { now: Sekunden } ; Rückgabe: { ok: true, offer } | { ok: false, code, message }
   * Ein Angebot wird nur vollständig oder gar nicht geliefert – nie teilweise.
   */
  function decode(input, opts) {
    opts = opts || {};
    try {
      var col = input instanceof Collector ? input : new Collector();
      if (!(input instanceof Collector)) (Array.isArray(input) ? input : [input]).forEach(function (t) { col.add(t); });
      var body = col.body();
      if (body.length > LIMITS.bodyLen) throw fail('TOO_LARGE');
      if (crc32(body) !== col.crc) throw fail('CHECKSUM');
      var kind = body.charAt(0), bytes = b64urlDecode(body.slice(1));
      if (kind === 'z') { try { bytes = inflateRaw(bytes, LIMITS.jsonLen); } catch (e) { throw e.hscCode ? e : fail('DECODE'); } }
      else if (kind !== 'j') throw fail('FORMAT');
      if (bytes.length > LIMITS.jsonLen) throw fail('TOO_LARGE');
      var json;
      try { json = JSON.parse(utf8Decode(bytes)); } catch (e) { throw fail('DECODE'); }
      if (!json || typeof json !== 'object' || Array.isArray(json)) throw fail('DECODE');
      if (json.s !== SCHEMA) throw fail('VERSION');
      var offer = validate(unpack(json));
      if (offer.id !== col.id) throw fail('INVALID', 'id passt nicht zum Kopf');
      var now = INT(opts.now) ? opts.now : Math.floor(Date.now() / 1000);
      if (offer.created > now + LIMITS.skew) throw fail('FUTURE');
      if (now > offer.expires) throw fail('EXPIRED');
      return { ok: true, offer: offer };
    } catch (e) {
      var code = e && e.hscCode ? e.hscCode : 'DECODE';
      return { ok: false, code: code, message: ERR[code] || ERR.DECODE, detail: e && e.detail };
    }
  }

  function centsToText(c) {
    if (c == null) return '';
    var neg = c < 0, v = Math.abs(c), eu = Math.floor(v / 100), ct = ('0' + (v % 100)).slice(-2);
    var s = String(eu).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    return (neg ? '-' : '') + s + ',' + ct;
  }

  return {
    PREFIX: PREFIX, SCHEMA: SCHEMA, TTL_DEFAULT: TTL_DEFAULT, CHUNK: CHUNK, LIMITS: LIMITS, ARTEN: ARTEN.slice(), WARN: WARN, ERR: ERR,
    encode: encode, decode: decode, parsePart: parsePart, Collector: Collector, validate: validate,
    personalData: personalData, crc32: crc32, centsToText: centsToText,
    _internal: { pack: pack, unpack: unpack, b64urlEncode: b64urlEncode, b64urlDecode: b64urlDecode, inflateRaw: inflateRaw }
  };
});

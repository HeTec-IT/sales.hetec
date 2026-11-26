/*
 * Smart Scan – parser.js
 * Angebotsparser: Text → Tarife, Geräte, Internet@Home, Preise, Rabatte, Summenprüfung, Zusammenführen mehrerer Fotos. Reine Logik (kein DOM).
 *
 * Klassisches Skript (globale Funktionen wie bisher in index.html), geladen vor der App.
 * Ausgelagert aus index.html (v56.0-beta.4) ohne inhaltliche Änderung; Cloud-OCR entfernt.
 */
// === v55.170/171 (Beta): o2-VORSCHLAG EINLESEN ==================================================
// Foto vom Bildschirm (digitaler o2-Vorschlag) -> Texterkennung lokal auf dem Geraet (Tesseract, Deutsch)
// -> Tarif(e), Geraet(e), Einmalige und Monatliche Kosten -> Kontrolle -> EINE Angebotskarte (digital) + Preise.
const PS_O2_AMT = /((?:\d{1,3}(?:\.\d{3})+|\d+),\d{2})(?!\d)\s*€?/g;
// Preiserhoehung "*Ab dem 25. Monat: 84,98 €" (auch "ab dem 12. Monat"): wird bewusst ignoriert – kein Hinweis, nie eine Summe (v55.194)
const PS_O2_AB_MONAT = /\*?\s*Ab\s*dem\s*\d{1,2}\.?\s*[^\d]{0,12}\d{1,3}(?:\.\d{3})*[.,]\d{2}\s*€?/i;
const PS_O2_ARTEN = /(Vertragsverl[äa]ngerung|Neuvertrag|Neukunde|Tarifwechsel|Rufnummernmitnahme|Portierung|Zweitkarte|Partnerkarte)/i;
const PS_O2_BRANDS = /(APPLE|IPHONE|IPAD|SAMSUNG|GALAXY|GOOGLE|PIXEL|XIAOMI|REDMI|MOTOROLA|NOKIA|OPPO|HONOR|HUAWEI|WATCH|AIRPODS|FAIRPHONE|ONEPLUS|SONY|XPERIA|NOTHING|EMPORIA|DORO)/i;
const PS_O2_HEAD = [
  ['internet', /(INTERNET\s*@?\s*HOME|^DSL$|KABEL|FESTNETZ|GLASFASER|HOMESPOT)/i],
  ['tarife', /^(TARI[FE]|MOBILFUNK)$/i],
  ['geraete', /^(HANDY|SMARTPHONE|TABLET|GER[ÄA]T|HARDWARE|ZUBEH[ÖO]R|SMARTWATCH)$/i]
];
const PS_O2_VOCAB = ['International', 'Voice', 'Standard', 'Roaming', 'Datenvolumen', 'Inklusiv', 'Unbegrenztes', 'National', 'Flatrate', 'Mobilfunknetze', 'Installationsservice', 'unlimited', 'MyHandy', 'Monate', 'Router', 'Versand', 'Kombivorteil', 'Analog', 'Unlimited', 'Mobile', 'Telefonie'];
function psO2Dist(a, b) {
  const n = a.length, m = b.length, d = Array.from({ length: n + 1 }, (_, i) => [i]);
  for (let j = 1; j <= m; j++) d[0][j] = j;
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[n][m];
}
// v55.224: Tarifname trotz Lesefehlern erkennen ("uOrMebile L (2026)" -> "O2 Mobile L (2026)"): Familienwort (unscharf) + Groesse + Jahr.
// Ohne diese Erkennung fiel ein ganzer Tarif weg, wenn nur sein Name verlesen war (der Parser fand keine Namenszeile).
const PS_O2_FAMILIES = ['Mobile', 'Free', 'Grow', 'Unlimited', 'Prepaid', 'Basic', 'Smart', 'Connect'];
function psO2FuzzyTarif(line) {
  const m = /([A-Za-zÄÖÜäöü0-9|]{3,14})\s+(XS|S|M|L|XL|XXL)\s*\(\s*(20\d\d)\s*\)/.exec(String(line || ''));
  if (!m) return '';
  const tok = m[1].replace(/[^A-Za-zÄÖÜäöü]/g, '').toLowerCase();
  let best = '';
  PS_O2_FAMILIES.forEach(f => {
    if (best) return;
    const fl = f.toLowerCase();
    // Endstuecke des Wortes pruefen (davor kann Linien-/Icon-Muell haengen: "uOrMebile")
    for (let k = 0; k < tok.length; k++) {
      const t = tok.slice(k);
      if (t.length < fl.length - 1) break;
      if (t.length <= fl.length + 1 && psO2Dist(t, fl) <= 1) { best = f; return; }
    }
  });
  return best ? 'O2 ' + best + ' ' + m[2].toUpperCase() + ' (' + m[3] + ')' : '';
}
// Typische Lesefehler korrigieren ("Veice" -> "Voice", "Daterwolumen" -> "Datenvolumen", "Inklusk" -> "Inklusiv")
function psO2FixWords(s) {
  s = String(s || '').replace(/\bInklus[kl1I]\b/g, 'Inklusiv').replace(/\bDat[a-z]{0,3}[vw]olumen\b/g, 'Datenvolumen');
  s = s.replace(/\b(Mobile|Free|Grow|Unlimited)\s+5\b(?!\s*G)/g, '$1 S').replace(/\b[UuIil1]nk[li]us\w{0,4}\s?Dat\w{2,}/g, 'Inklusiv Datenvolumen').replace(/(Datenvolumen\s+\d{1,4})\s?[6G][8B]\b/g, '$1 GB');
  // v55.222: weitere beobachtete Lesefehler bei ungewohnter Bildschirm-Aufloesung (zu kurz fuer die
  // allgemeine Woerterbuch-Korrektur unten oder zu speziell dafuer).
  s = s.replace(/\bInternational\s+Yale\s+Standard\b/gi, 'International Voice Standard');
  s = s.replace(/\bunlimited\s+am\b/gi, 'unlimited (1M)');
  s = s.replace(/\b1?[Ii]tb\b/g, '1TB');
  return s.replace(/[A-Za-zÄÖÜäöüß]{5,}/g, w => {
    const lw = w.toLowerCase();
    if (PS_O2_VOCAB.some(v => v.toLowerCase() === lw)) return w;
    const tol = w.length >= 8 ? 2 : 1;
    let best = null, bd = 9;
    PS_O2_VOCAB.forEach(v => { const dd = psO2Dist(lw, v.toLowerCase()); if (dd <= tol && dd < bd) { bd = dd; best = v; } });
    return best ? (/[A-ZÄÖÜ]/.test(w[0]) ? best[0].toUpperCase() : best[0].toLowerCase()) + best.slice(1) : w;
  });
}
// v55.227: haeufige Inhaltszeilen der o2-Vorschlaege: verlesener Anfang wird korrigiert ("Witemational Voice Standard"),
// Muell dahinter abgeschnitten ("Roaming Standard Bat"); nur Zahlenangaben dahinter bleiben ("Inklusiv Datenvolumen 50 GB")
const PS_O2_DETAIL_KNOWN = ['International Voice Standard', 'International Voice Premium', 'Inklusiv Datenvolumen', 'Roaming Standard', 'Roaming Premium', 'Analog Option', 'O2 Installationsservice', 'O2 my Data unlimited'];
function psO2DetailKnown(s) {
  const w = String(s || '').split(' ').filter(Boolean);
  for (const p of PS_O2_DETAIL_KNOWN) {
    const n = p.split(' ').length;
    if (w.length < n) continue;
    const a = w.slice(0, n).join(' ').toLowerCase(), b = p.toLowerCase();
    if (psO2Dist(a, b) > Math.max(1, Math.round(b.length * 0.2))) continue;
    let rest = w.slice(n);
    if (/unlimited$/.test(b)) { const m = /^\(?\s*[1Il|]\s?M\s*\)?$/.exec(rest[0] || ''); return p + (m ? ' (1M)' : ''); }
    const num = [];
    for (const t of rest) { if (/^\d+([.,]\d+)?$/.test(t) || /^(GB|MB|TB|MBit\/s|Min\.?)$/i.test(t)) num.push(t); else break; }
    return (p + ' ' + num.join(' ')).trim();
  }
  return '';
}
// Preisspalten einer Zeile: [einmalig, monatlich]; "-" bedeutet kein Betrag. Nicht eindeutig lesbar -> undefined.
function psO2Cols(raw) {
  raw = String(raw || '');
  const a = psO2Amounts(raw);
  if (a.length >= 2) return [a[a.length - 2], a[a.length - 1]];
  if (a.length === 1) {
    const i = raw.lastIndexOf(a[0]);
    if (/(^|\s)[-–—]\s*$/.test(raw.slice(0, i))) return [null, a[0]];
    if (/^\s*€?\s*[-–—](\s|$)/.test(raw.slice(i + a[0].length))) return [a[0], null];
  }
  return undefined;
}
function psO2Cents(v) {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/\./g, '').replace(',', '.'));
  return isFinite(n) ? Math.round(n * 100) : null;
}
function psO2Fmt(c) { return (c / 100).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
// Rabatt-/Vorteilszeilen eines Produkts (negative Betraege je Spalte). bad = Betrag vorhanden, aber nicht lesbar -> keine Gegenprobe.
function psO2Adjust(lines, from) {
  const o = { e: 0, m: 0, bad: false, base: { e: null, m: null } };
  for (let k = from; k < Math.min(lines.length, from + 16); k++) {
    const l = lines[k];
    if (psO2HeadKind(l) || /(Einmalige|alige|Monatliche|natliche)\s*Kosten/i.test(l) || /Seite\s*(\d+\s*)?von|Telef[oó]nica|Brauchle/i.test(l)) break;
    // v55.227: Grundpreis-Zeilen ohne Rabatt ("Einmaliger Anschlusspreis 49,99 €", "Grundgebühr 44,99 €") merken
    if (!/Rabatt|Vortei|Gutschrift|Bonus|Nachlass|Kombi/i.test(l)) {
      const ba = psO2Amounts(l);
      if (ba.length && /Anschlusspreis|Aktivierung|Bereitstell/i.test(l) && o.base.e == null) o.base.e = psO2Cents(ba[ba.length - 1]);
      else if (ba.length && /Grundgeb|Grundpreis/i.test(l) && o.base.m == null) o.base.m = psO2Cents(ba[ba.length - 1]);
      continue;
    }
    const a = psO2Amounts(l);
    if (!a.length) { if (/\d/.test(l.replace(/\b\d+\s*EUR\b/gi, ''))) o.bad = true; continue; }
    let col;
    if (/monatl|Grundgeb/i.test(l)) col = 'm';
    else if (/Anschluss|einmal|Aktivier|Bereitstell/i.test(l)) col = 'e';
    else { const c = psO2Cols(l); if (c) col = c[0] != null && c[1] == null ? 'e' : c[1] != null && c[0] == null ? 'm' : ''; }
    if (!col) { o.bad = true; continue; }
    o[col] -= Math.abs(psO2Cents(a[a.length - 1]) || 0);
  }
  return o;
}
function psO2Amounts(line) { const m = String(line || '').match(PS_O2_AMT); return m ? m.map(x => x.replace(/\s*€/, '').trim()) : []; }
function psO2CleanName(line, kind) {
  line = String(line || '').replace(/\s+\S*\d\S*\s?€.*$/, ''); // Preisreste ("00€ 550€") hinter dem Namen
  line = line.replace(/(^|[\s‚'’`´])[O0][:;]\s?(?=[A-Z][a-z])/g, '$1O2 ');
  let s = String(line || '').replace(PS_O2_AMT, ' ').replace(/[€|\\\[\]{}_~„“"*]/g, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(/\b(S|M|L|XL)\.(?=\s*\()/g, '$1'); // v55.225: verirrter Punkt hinter der Tarifgroesse ("Mobile L. (2026)")
  if (kind !== 'geraete') {
    if (kind === 'tarife') { const fz = psO2FuzzyTarif(s); if (fz) return fz; } // v55.224
    // o2-Produkte beginnen mit O2/o2 (OCR liest auch 02, Oz, O₂)
    const m = s.match(/(?:^|[\s‚'’`´])(?:O|o|0)(?:[2₂z]|\s?[:;])[:;]?\s+\S/);
    if (m) s = 'O2 ' + s.slice(m.index + m[0].length - 1).trim();
    if (kind === 'tarife' && !/^O2\s/.test(s)) { const k = s.match(/\b(?:Mobile|Free|Grow|Unlimited)\s+(?:S|M|L|XL)\b.*$/i); if (k) s = 'O2 ' + k[0]; }
    if (kind === 'internet') s = s.replace(/\b(Home)\s?([SMLX]{1,2})\s?(\d{2,4})\b/i, (x, a, b, c) => a + ' ' + b.toUpperCase() + ' ' + c);
    const y = s.match(/\(\s*20\d\d\s*\)/);
    if (y) s = s.slice(0, y.index + y[0].length);
    else s = s.replace(/\(\s*(20\d\d)\s*$/, '($1)');
    s = s.replace(/\bInstallationsadresse\b.*$/i, '').trim();
  } else {
    const b = s.search(PS_O2_BRANDS);
    if (b > 0) s = s.slice(b);
    const cp = s.lastIndexOf(')');
    if (cp > 8) s = s.slice(0, cp + 1);
    else s = s.replace(/(\S+\s+\S+\s+\S+.*?)\s+\d{4,}\b.*$/, '$1');
  }
  const t = s.split(' ');
  while (t.length > 1 && (t[0].replace(/[^A-Za-zÄÖÜäöü0-9]/g, '').length < 2 || /^\(/.test(t[0]) && !/\)$/.test(t[0]))) t.shift();
  while (t.length > 1 && t[t.length - 1].replace(/[^A-Za-zÄÖÜäöü0-9]/g, '').length < 3 && !/\d/.test(t[t.length - 1])) t.pop();
  const out = t.join(' ').replace(/\s*,\s*$/, '').trim();
  return kind === 'geraete' ? out : psO2FixWords(out);
}
// Kopfzeile eines Bereichs? (kurze Zeile, OCR-Reste wie "| GC HANDY" oder "TARIF / | A Ak" erlaubt)
function psO2HeadKind(line) {
  const toks = String(line || '').replace(/[^A-Za-zÄÖÜäöü@\s]/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (!toks.length || toks.length > 4) return null;
  for (let k = toks.length - 1; k >= 0; k--) {
    const w = toks.slice(k).join(' ');
    for (const [kind, re] of PS_O2_HEAD) if (re.test(w)) return kind;
  }
  for (let k = 0; k < toks.length; k++) {
    if (toks[k].length < 4) continue;
    for (const [kind, re] of PS_O2_HEAD) if (re.test(toks[k]) && toks.every((t, j) => j === k || t.length <= 3)) return kind;
  }
  return null;
}
// Einzelnes Wort/Zeichen = OCR-Muell? ("A", "MA", "|", "£" ...). Echte Kurzwoerter und Einheiten bleiben.
function psO2Junk(t) {
  const a = String(t).replace(/[^A-Za-zÄÖÜäöüß0-9]/g, '');
  if (!a) return !/^[-/+&]$/.test(t);
  if (a.length >= 3) return false;
  if (a.length === 2) return !(/\d/.test(a) || /^(my|ab|im|in|zu|am|um|gb|tb|mb|kb|xl|xs|tv)$/i.test(a));
  return true;
}
// Eine Inhaltszeile (z. B. "Inklusiv Datenvolumen 50 GB") aus dem OCR-Text holen. Preisspalten rechts werden abgeschnitten;
// Rabatt-/Preiszeilen, Adressen und Muell fliegen raus (Einzelpreise interessieren nicht, nur die Summen).
function psO2Detail(line) {
  line = String(line || '').replace(/\s*\(?\s*Gesamtpreis.*$/i, '');
  if (/Kombi|Vortei|befreiu|Gutschrift|Plus-?\s?Bundle|TS-?\s?Opt|Rabatt|Anschlusspreis|Gesamtpreis|Ersparnis|Aktivierung|Bestell|m[öo]glich|E-?\s?Mail|Ausdrucken|Auftragsstatus|Jetzt im|Einmal|Monatl|Kosten|UMTS|Adresse|Grundgeb|Anschluss|maliger|Seite\s|Vorschlag|aufgerufen|ausstellend|Unverbindlich|Telef|Brauchle|Acrobat|\d+\s*EUR\b/i.test(line)) return '';
  const am = line.search(/\d{1,3}(?:\.\d{3})*,\d{2}/);
  if (am >= 0) { if (line.slice(0, am).replace(/[^A-Za-zÄÖÜäöüß]/g, '').length < 4) return ''; line = line.slice(0, am); }
  let s = line.replace(/[|\\\[\]{}_~„“"*¦]/g, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(/^[^A-Za-zÄÖÜ0-9]*(?:O|o|0)(?:[2₂z]|\s?[:;])[:;]?\s+(?=\S)/, 'O2 ').replace(/\(\s*[Il|]\s?M\s*\)?/, '(1M)').replace(/^my\s+Data\b/i, 'O2 my Data');
  let t = s.split(' ').filter(Boolean);
  // v55.195: Linien/Icons neben den Zeilen werden als "rnmnrnununu", "——m—m—ununu&" gelesen: Satzzeichen am Wortanfang abstreifen, solche Token verwerfen
  t = t.map(w => w.replace(/^[^A-Za-zÄÖÜäöüß0-9(]+(?=[A-Za-zÄÖÜäöüß0-9(])/, '')).filter(w => !(/^[rnmuil]{5,}$/i.test(w.replace(/[^A-Za-zÄÖÜäöüß]/g, '')) && !/^minimum$/i.test(w)));
  if (/^my$/i.test(t[0] || '') && /^Data/i.test(t[1] || '')) t.unshift('O2');
  else if (/^(?:O[lzs5]|[O0Q©])$/i.test(t[0] || '') && /^my$/i.test(t[1] || '')) t[0] = 'O2';
  if (/^O2[:;?!.,]$/i.test(t[0] || '')) t[0] = 'O2';
  while (t.length && psO2Junk(t[0])) t.shift();
  while (t.length && (psO2Junk(t[t.length - 1]) || /^[-/+&]$/.test(t[t.length - 1]))) t.pop();
  for (let i = 0; i < t.length; i++) if (psO2Junk(t[i]) && (i === t.length - 1 || psO2Junk(t[i + 1]))) { t = t.slice(0, i); break; }
  s = t.join(' ').replace(/[\s,;:.\-]+$/, '').trim();
  const lt = s.replace(/[^A-Za-zÄÖÜäöüß]/g, '').length, tk = s.split(' ').length;
  if (s.length > 60 || lt < 6 || tk < 2 && lt < 8 || lt > 3 && s === s.toUpperCase() && lt < 9) return '';
  // v55.195: reiner Grossbuchstaben-Muell ohne Ziffer ("GET STTTFSFER FREUT LEAST") und Woerter mit 5+ Konsonanten am Stueck sind nie echte Details
  if (!/[a-zäöüß]/.test(s) && !/\d/.test(s)) return '';
  if (s.split(' ').some(w => /[bcdfghjklmnpqrstvwxz]{5,}/i.test(w.replace(/[^A-Za-z]/g, '')))) return '';
  // Lesemuell (z. B. Werbebanner neben der Karte): viele kurze Woerter, keine Ziffer
  const tt = s.split(' ');
  if (tt.length >= 4 && !/\d/.test(s) && tt.filter(w => w.replace(/[^A-Za-zÄÖÜäöüß]/g, '').length <= 3).length >= tt.length * 0.6) return '';
  const fx = psO2FixWords(s).replace(/^inklusiv\b/, 'Inklusiv'), kn = psO2DetailKnown(fx);
  if (kn) return kn;
  // v55.227: drei oder mehr Woerter, davon die meisten mit hoechstens 3 Buchstaben, keine Ziffer ("Kom WE rer") = Lesemuell
  if (tt.length >= 3 && !/\d/.test(fx) && tt.filter(w => w.replace(/[^A-Za-zÄÖÜäöüß]/g, '').length <= 3).length >= tt.length * 2 / 3) return '';
  return fx;
}
// Inhalte unter einer Namenszeile einsammeln (bis zum naechsten Bereich bzw. den Summenzeilen)
function psO2Collect(lines, from) {
  const det = [];
  for (let k = from; k < Math.min(lines.length, from + 16); k++) {
    const l = lines[k];
    if (psO2HeadKind(l) || /(Einmalige|alige|Monatliche|natliche)\s*Kosten/i.test(l) || /Seite\s*(\d+\s*)?von|Telef[oó]nica|Brauchle/i.test(l)) break;
    if (PS_O2_BRANDS.test(l) && /(?:\d{2,5}\s?G|\b\d{1,2}\s?T)[B8]B?\b/i.test(l) && !/Datenvolumen/i.test(l)) break;
    if (k > from && PS_O2_NAME.tarife.test(l)) break; // naechster Tarif beginnt (Kopfzeile "TARIF" nicht gelesen)
    const d = psO2Detail(l);
    if (d && !det.some(x => psO2Similar(x, d))) det.push(d);
  }
  return det.slice(0, 10);
}
// Namenszeile eines Produkts (je Bereich ein Muster; steht meist direkt unter der Kopfzeile, davor kann OCR-Muell stehen)
const PS_O2_TARIF_RE = /(?:(?:^|[\s‚'’`´])(?:O|0)(?:[2₂z]|\s?[:;])[:;]?\s+(?:Mobile|Free|Grow|Unlimited|Prepaid|Basic|Smart|Blue|Connect)\b|\b(?:Mobile|Free|Grow|Unlimited)\s+(?:S|M|L|XL)\b)/i;
const PS_O2_NAME = {
  // v55.193: auch ohne gelesenes "O2" (die Texterkennung macht aus dem O₂-Zeichen oft "©:" oder "Ol"): Mobile/Free/Grow/Unlimited + Groesse
  tarife: { test: l => PS_O2_TARIF_RE.test(l) || !!psO2FuzzyTarif(l) }, // v55.224: auch verlesene Namen
  internet: /(?:^|[\s‚'’`´])(?:O|0)(?:[2₂z]|\s?[:;])[:;]?\s*Home(?:\b|(?=[SMLX]\d))/i,
  geraete: PS_O2_BRANDS
};
function psO2Parse(text) {
  const all = String(text || '').split(/\r?\n/).map(l => l.trim().replace(/(\d)[.,](\d{2})(?![\d.,])/g, '$1,$2')).filter(Boolean);
  // Bereich "Aktuell" (bisheriger Vertrag) nicht auswerten – aber nur, wenn davor schon Produkte oder Kosten standen.
  // Steht "Aktuell" als Beschriftung in der Seitenleiste VOR der Positionsliste (Bedarfsanalyse), wuerde sonst alles verworfen.
  const limRaw = all.findIndex(l => /^\W*Aktuell\W*$/i.test(l));
  const anchor0 = all.findIndex(l => psO2HeadKind(l) || /(Einmalige|Monatliche)\s*Kosten/i.test(l) || PS_O2_NAME.tarife.test(l));
  const lim = limRaw > -1 && (anchor0 < 0 || limRaw > anchor0) ? limRaw : -1;
  const lines = lim > -1 ? all.slice(0, lim) : all;
  // v55.224: Zeilen NACH "Aktuell": je nach Leserichtung der Texterkennung steht dort der Betrag der Kostenzeile davor
  // (bisher wurde alles hinter "Aktuell" verworfen -> "Monatliche Kosten" ohne Betrag -> "Kostenblock fehlt")
  const tail = lim > -1 ? all.slice(lim + 1, lim + 5) : [];
  const out = { internet: [], tarife: [], geraete: [], einmalig: '', monatlich: '', hinweis: '', hdr: { tarife: 0, geraete: 0, internet: 0 } };
  const kostZ = { e: null, m: null }; // Zeilennummern der Kostenzeilen ohne Betrag
  const next = (i, re) => { for (let k = i + 1; k < Math.min(lines.length, i + 4); k++) if (re.test(lines[k])) return lines[k]; return ''; };
  const head = l => { const a = l.search(/(?:\d{1,3}(?:\.\d{3})+|\d+),\d{2}/); return a > 0 ? l.slice(0, a) : l; }; // Preisspalten rechts abschneiden
  const add = (kind, i, raw, from, dedupe, hdr) => {
    const name = psO2CleanName(head(raw), kind);
    if (!name || name.length < 4) return;
    // v55.224: nur direkt benachbarte Zeilen sind dieselbe Position doppelt gelesen - zwei gleiche Tarife (je mit eigenen Inhalten) bleiben zwei
    if (dedupe && out[kind].some(x => Math.abs(x.idx - i) <= 3 && psO2Similar(x.name, name))) return;
    const am = next(i, PS_O2_ARTEN).match(PS_O2_ARTEN);
    let cols = psO2Cols(raw);
    if (!cols && kind === 'geraete') for (let k = from; k < Math.min(lines.length, from + 3) && !cols; k++) if (/MyHandy|Monate/i.test(lines[k])) cols = psO2Cols(lines[k].replace(/Gesamtpreis.*?€/i, ''));
    if (!cols && hdr) cols = psO2Cols(hdr); // v55.193: bei o2 steht der Preis oft in der Kopfzeile (TARIF 29,99 €)
    const rb = psO2Adjust(lines, from);
    // v55.227: Rabatt schon im Preis enthalten? ("Einmaliger Anschlusspreis 49,99" + "Rabatt -40,00" = 9,99 in der Kopfzeile) -> nicht nochmal abziehen
    if (cols && rb.base) ['e', 'm'].forEach((c, ci) => { const hp = psO2Cents(cols[ci]); if (rb[c] && rb.base[c] != null && hp != null && rb.base[c] + rb[c] === hp) rb[c] = 0; });
    delete rb.base;
    out[kind].push({ name, idx: i, yf: lines.length ? i / lines.length : 0, art: am ? am[1].replace(/a(?=ngerung)/, 'ä') : '', am: cols, rb, details: psO2Collect(lines, from) });
  };
  lines.forEach((l, i) => {
    const kind = psO2HeadKind(l);
    if (kind) out.hdr[kind]++; // v55.224: wie viele Bloecke stehen im Bild (Gegenprobe zur Anzahl gelesener Eintraege)
    if (kind && lines[i + 1]) {
      let j = i + 1;
      for (let k = i + 1; k < Math.min(lines.length, i + 4); k++) if (PS_O2_NAME[kind].test(lines[k])) { j = k; break; }
      let raw = lines[j], from = j + 1;
      // Geraetename ueber zwei Zeilen ("Apple IPHONE 17 PRO MAX" / "256GB, COSMIC ORANGE")
      if (kind === 'geraete' && lines[j + 1] && !psO2Amounts(raw).length && /\d+\s*GB|TB/i.test(lines[j + 1]) && !/\d+\s*GB|TB/i.test(raw)) { raw += ' ' + lines[j + 1]; from = j + 2; }
      // v55.198: PDF-Vorschlag: der Preis steht allein in einer Zeile zwischen Kopfzeile und Namen ("TARIF" / "39,99 € 19,99 €" / "O2 Mobile S")
      let hdr = l;
      for (let k = i + 1; k < j; k++) if (psO2Amounts(lines[k]).length && lines[k].replace(/[^A-Za-zÄÖÜäöü]/g, '').length <= 4) hdr = l + ' ' + lines[k];
      add(kind, i, raw, from, false, hdr);
    }
    if (!out.einmalig && (/(Einmalige|alige)\s*Kosten/i.test(l) || /^\W*einmalig\W+\d/i.test(l))) { const a = psO2Amounts(l); if (a.length) { out.einmalig = a[a.length - 1]; } else kostZ.e = i; }
    if (!out.monatlich && (/(Monatliche|natliche)\s*Kosten/i.test(l) || /^\W*monatlich\W+\d/i.test(l))) {
      // v55.194: Preiserhoehung "*Ab dem 25. Monat: X" ignorieren (Text samt Betrag aus der Zeile nehmen)
      const a = psO2Amounts(l.replace(PS_O2_AB_MONAT, ' '));
      const rest = a;
      if (rest.length) out.monatlich = rest[rest.length - 1]; else kostZ.m = i;
    }
  });
  // Beim Foto vom Bildschirm rutscht der Betrag oft in die Zeile darueber oder darunter ("35,49 €*" allein).
  // Solche Zeilen (nur ein Betrag, sonst nichts) der passenden Kostenzeile zuordnen, jede Zeile nur einmal.
  const nurBetragOf = l => {
    l = l || ''; const a = psO2Amounts(l);
    // genau ein Betrag, kurze Zeile, kaum Buchstaben (Lesemuell wie "a 35,49€ mm. 4" ist erlaubt)
    return a.length === 1 && l.length <= 26 && l.replace(/[^A-Za-zÄÖÜäöü]/g, '').length <= 4 ? a[0] : '';
  };
  const nurBetrag = i => nurBetragOf(lines[i]);
  const belegt = {};
  [['monatlich', kostZ.m], ['einmalig', kostZ.e]].forEach(([feld, i]) => {
    if (out[feld] || i == null) return;
    for (const k of [i + 1, i - 1, i + 2]) {
      if (k < 0 || belegt[k]) continue;
      const v = nurBetrag(k);
      if (v) { out[feld] = v; belegt[k] = 1; return; }
    }
  });
  // v55.224: Betrag erst hinter "Aktuell": der Reihe nach den Kostenzeilen ohne Betrag zuordnen (ob er stimmt, zeigt spaeter die Gegenprobe)
  if (tail.length) {
    const open = [['einmalig', kostZ.e], ['monatlich', kostZ.m]].filter(([f, i]) => !out[f] && i != null).sort((a, b) => a[1] - b[1]);
    const ta = tail.map(nurBetragOf).filter(Boolean);
    open.forEach(([f], n) => { if (ta[n]) out[f] = ta[n]; });
  }
  // Ohne Kopfzeilen (z. B. Uebersicht "Für Sie"): o2-Tarife und Geraete am Namen erkennen
  if (!out.internet.length) lines.forEach((l, i) => { if (PS_O2_NAME.internet.test(l)) add('internet', i - 1, l, i + 1, true); });
  lines.forEach((l, i) => { if ((!out.hdr.tarife || psO2Amounts(l).length) && PS_O2_NAME.tarife.test(l) && !/Activate|Bestandskunde|Beratung|VO:/i.test(l)) add('tarife', i - 1, l, i + 1, true); });
  if (!out.geraete.length) lines.forEach((l, i) => {
    if (!/My\s?Handy/i.test(l)) return;
    for (let k = i - 1; k >= Math.max(0, i - 2); k--) if (!psO2HeadKind(lines[k]) && !/My\s?Handy/i.test(lines[k]) && lines[k].replace(/[^A-Za-zÄÖÜäöü]/g, '').length >= 6) { add('geraete', k, lines[k], i, true); break; }
  });
  if (!out.geraete.length) lines.forEach((l, i) => { if (/\b(?:Apple\s+)?(?:iPhone|iPad|Galaxy|Pixel)\s*[A-Za-z0-9]/i.test(l) && /\d/.test(l) && !/Gesamtpreis|Jetzt im/i.test(l)) add('geraete', i - 1, l, i + 1, true); });
  if (!out.geraete.length) lines.forEach((l, i) => { if (PS_O2_BRANDS.test(l) && /\d{2,5}\s?G[B8]B?\b/i.test(l) && !/Gesamtpreis|Jetzt im|Datenvolumen/i.test(l)) add('geraete', i - 1, l, i + 1, true); });
  return out;
}
const psO2Key = s => String(s || '').toLowerCase().replace(/[^a-z0-9äöü]/g, '');
// v55.213: Groesse (S/M/L/XL), Zahlen (GB, Jahr, Modell) und Modellwoerter muessen genau passen – "Mobile S" ist nicht "Mobile L"
function psO2Marks(t) {
  return (String(t || '').replace(/[()]/g, ' ').match(/\b(?:XXS|XS|S|M|L|XL|XXL|\d+|Pro|Max|Plus|Ultra|Mini|Unlimited|Fold|Flip|Lite|FE|Special|Basic|Boost|Start|Home)\b/gi) || []).map(x => x.toLowerCase()).map(x => x === '5' ? 's' : x).sort().join(' '); // "Mobile 5" = verlesenes S
}
function psO2Similar(a, b) {
  if (psO2Marks(a) !== psO2Marks(b)) return false;
  a = psO2Key(a); b = psO2Key(b);
  if (!a || !b) return false;
  if (a === b || a.indexOf(b) > -1 || b.indexOf(a) > -1) return true;
  const n = a.length, m = b.length, d = Array.from({ length: n + 1 }, (_, i) => [i]);
  for (let j = 1; j <= m; j++) d[0][j] = j;
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[n][m] <= Math.max(2, Math.floor(Math.max(n, m) * 0.15));
}
// GROSSBUCHSTABEN-Geraetenamen lesbar machen: "IPHONE 18 PRO 256GB, BURGUNDER" -> "iPhone 18 Pro 256GB, Burgunder"
function psO2Pretty(s) {
  s = String(s || '').replace(/\bPIXE\b/i, 'PIXEL').replace(/\b(\d{2,4})\s?G[8B]B?\b/, '$1GB').replace(/\b[Il|]\s?TB\b/gi, '1TB'); // v55.224: "1TB" wird oft als "ITB" gelesen
  s = String(s || '').replace(/\bIP (\d{1,2})\b/, 'iPhone $1').replace(/\b(iPhone \d{1,2}) PM\b/, '$1 Pro Max').replace(/\bBURG\.?(?=\s|,|$)/, 'Burgunder');
  if (/iPhone/.test(s)) s = s.replace(/\b(64|128|256|512)\b(?!\s?GB)/, '$1GB');
  s = String(s || '').split(' ').map(w => /^SWZ[,.]?$/.test(w) ? w.replace('SWZ', 'Schwarz') : /^[A-ZÄÖÜ]{2,}[,.]?$/.test(w) && !/^(GB|TB|LTE|USB|SE|FE|XL|II|III)[,.]?$/.test(w) || /^[A-ZÄÖÜ]{3,}\d+[,.]?$/.test(w) ? w.charAt(0) + w.slice(1).toLowerCase() : w).join(' ');
  s = s.replace(/\bIphone\b/g, 'iPhone').replace(/\bIpad\b/g, 'iPad').replace(/\bAirpods\b/g, 'AirPods');
  // Marke steht im o2-Vorschlag teils doppelt ("Samsung SAMSUNG GALAXY ...")
  s = s.split(' ').filter((w, i, a) => !(i > 0 && w.toLowerCase() === a[i - 1].toLowerCase())).join(' ');
  { const t = s.split(' '); if (t.length > 3 && PS_O2_BRANDS.test(t[0])) for (const n of [1, 2]) { const j = t.slice(1, 1 + n).join('').toLowerCase(); if (j.length >= 3 && psO2Dist(j, t[0].toLowerCase()) <= 1 + Math.floor(t[0].length / 4)) { t.splice(1, n); s = t.join(' '); break; } } }
  // haeufiger Lesefehler am Bildschirm: "iPhone 77" statt "iPhone 17"
  if (/Samsung|Galaxy/i.test(s)) s = s.replace(/\b5(2\d)\b/, 'S$1');
  s = s.replace(/\b(\d{1,2})(64|128|256|512)\s?GB\b/, '$1 $2GB');
  return s.replace(/\biPhone 7(\d)\b/, 'iPhone 1$1');
}
// Gegenprobe: Summe der Einzelpreise (+ Rabattzeilen) gegen den gelesenen Kostenblock. null = nicht pruefbar.
// Ob ein Rabatt schon im Produktpreis steckt, ist je Spalte verschieden -> beide Rechenwege gelten als "stimmt".
function psO2Check(d) {
  const E = psO2Cents(d.einmalig), M = psO2Cents(d.monatlich);
  const items = [].concat(d.tarife || [], d.geraete || [], d.internet || []);
  if (!items.length || E == null && M == null) return null;
  let se = 0, sm = 0, re = 0, rm = 0, incM = false;
  const ae = [], am = [];
  for (const it of items) {
    if (!it.am || !it.rb || it.rb.bad) return null;
    const a = psO2Cents(it.am[0]) || 0, b = psO2Cents(it.am[1]) || 0;
    ae.push(a); am.push(b); se += a; sm += b; re += it.rb.e; rm += it.rb.m;
    // v55.224: ein Tarif ohne gelesenen Monatspreis = Einzelpreise unvollstaendig (nicht: Summe falsch)
    if (it.am[1] == null && (d.tarife || []).indexOf(it) > -1) incM = true;
  }
  // v55.206: Texterkennung verschluckt vorne gern eine Ziffer (19,99 -> 9,99). Passt die Differenz zur Summe bei genau
  // einem Eintrag genau so (9,99 + 10,00 = 19,99, endet auf 9,99), gilt die Summe als bestaetigt.
  const mk = (val, sum, adj, arr) => {
    if (val == null) return null;
    const c = adj ? [sum, sum + adj] : [sum];
    let ok = c.indexOf(val) > -1;
    if (!ok) for (const t of c) {
      const diff = val - t; if (diff <= 0) continue;
      const hit = arr.filter(a => a > 0 && String(a + diff).length > String(a).length && String(a + diff).endsWith(String(a)));
      if (hit.length === 1) { ok = true; break; }
    }
    return { val, calc: c, ok };
  };
  const res = { e: mk(E, se, re, ae), m: mk(M, sm, rm, am) };
  if (incM && res.m && !res.m.ok) res.m.incomplete = true;
  return res;
}
// v55.224: Fehlt eine Gesamtsumme, aber alle Einzelpreise sind gelesen, ist deren Summe ein VORSCHLAG (wird nie von selbst eingetragen).
// Rueckgabe: { einmalig: [Cent...], monatlich: [Cent...] } nur fuer fehlende Summen mit vollstaendigen Einzelpreisen, sonst null.
function psO2Suggest(d) {
  const items = [].concat(d.tarife || [], d.geraete || [], d.internet || []);
  if (!items.length || items.some(it => !it.am || !it.rb || it.rb.bad)) return null;
  const out = {};
  [['einmalig', 0], ['monatlich', 1]].forEach(([f, c]) => {
    if (d[f]) return;
    if (c === 1 && (d.tarife || []).some(t => t.am[1] == null)) return;
    let sum = 0, adj = 0;
    items.forEach(it => { sum += psO2Cents(it.am[c]) || 0; adj += c === 0 ? it.rb.e : it.rb.m; });
    if (sum > 0) out[f] = adj ? [sum, sum + adj] : [sum];
  });
  return out.einmalig || out.monatlich ? out : null;
}
// v55.224: Was genau wurde (nicht) erkannt? Unterscheidet: technischer Fehler / kein Text / Text ohne Zuordnung / teilweise / Summen pruefen / Erfolg.
// Rueckgabe { kind, msg, cnt }. Kein Kundentext, nur Zahlen und feste Saetze.
function psO2Verdict(r, o) {
  o = o || {};
  const nT = r.tarife.length, nG = r.geraete.length, nN = r.internet.length, items = nT + nG + nN, hasE = !!r.einmalig, hasM = !!r.monatlich, hasK = hasE || hasM;
  const txtLen = String(o.txt || '').replace(/^--- Durchgang \d+ ---$/gm, '').replace(/[^A-Za-zÄÖÜäöüß0-9]/g, '').length;
  const cnt = [nT ? nT + (nT === 1 ? ' Tarif' : ' Tarife') : '', nG ? nG + (nG === 1 ? ' Handy' : ' Handys') : '', nN ? 'Internet@Home' : ''].filter(Boolean).join(', ');
  const mk = (kind, msg) => ({ kind, msg, cnt });
  if (!items && !hasK) {
    if (o.cancelled || o.fail === 'cancelled') return mk('cancelled', 'Erkennung abgebrochen – neu fotografieren oder unten von Hand eintragen.');
    if (o.fail === 'timeout') return mk('fail', 'Die Erkennung hat zu lange gedauert und wurde beendet. Bitte noch einmal fotografieren (näher, gerade, ohne Spiegelung) oder unten von Hand eintragen.');
    if (o.fail === 'engine') return mk('fail', 'Die Texterkennung ist gerade nicht verfügbar (beim ersten Mal wird sie geladen – Internet prüfen). Du kannst unten von Hand eintragen.');
    if (o.fail === 'image') return mk('fail', 'Das Foto konnte nicht geöffnet werden. Bitte noch einmal fotografieren.');
    // kein einziges Beleg-Wort im gelesenen Text (oder kaum Zeichen): das Foto zeigt keinen lesbaren Beleg (Rauschen, Spiegelung, Unschaerfe)
    if (txtLen < 25 || !/Tarif|Handy|Kosten|Mobile|iPhone|Galaxy|Pixel|Vorschlag|monatlich|einmalig|Artikel|Roaming|Datenvolumen|Aktuell|Gesamtpreis/i.test(String(o.txt || ''))) return mk('notext', 'Kein lesbarer Text erkannt – näher ran, gerade von vorne, ohne Spiegelung und noch einmal fotografieren.');
    return mk('nopos', 'Text gelesen, aber keine Tarife, Handys oder Kosten zuordenbar – Foto gerader, näher und ohne Spiegelung wiederholen oder unten von Hand eintragen.');
  }
  if (!items) return mk('partial', 'Gesamtkosten erkannt. Tarife und Handys fehlen noch – bitte fotografieren oder unten eintragen.');
  if (!hasK) return mk('partial', cnt + ' erkannt. Gesamtkosten konnten nicht sicher zugeordnet werden – Kostenblock fotografieren oder unten eintragen.');
  if (hasE !== hasM) return mk('partial', cnt + ' erkannt. Nur die ' + (hasE ? 'einmaligen' : 'monatlichen') + ' Gesamtkosten erkannt – bitte die ' + (hasE ? 'monatlichen' : 'einmaligen') + ' ergänzen.');
  const c = psO2Check(r), bad = c ? [c.e, c.m].filter(x => x && !x.ok) : [];
  if (bad.some(x => x.incomplete)) return mk('check', 'Einige Angaben benötigen eine Kontrolle: ' + cnt + ' erkannt, bei einem Tarif fehlt der Einzelpreis – die gelesene Monatssumme bleibt unverändert.');
  if (bad.length) return mk('check', 'Einige Angaben benötigen eine Kontrolle: ' + cnt + ' erkannt, aber die Summen passen nicht zu den Einzelpreisen.');
  if (!c) return [].concat(r.tarife, r.geraete, r.internet).some(it => !it.am || it.am[0] == null && it.am[1] == null)
    ? mk('check', 'Einige Angaben benötigen eine Kontrolle: ' + cnt + ' und Gesamtkosten erkannt, aber nicht alle Einzelpreise gelesen – die Summen konnten nicht geprüft werden. Fehlt ein Tarif oder Handy?')
    : mk('ok', '✓ Erkennung abgeschlossen: ' + cnt + ' und Gesamtkosten erkannt – bitte kurz prüfen.');
  return mk('ok', '✓ Erkennung abgeschlossen: ' + cnt + ' und Gesamtkosten erkannt, Summen stimmen.');
}
// Zeitstempel "erstellt am 23.11.2026 17:15" (auch "23112026 17:15" aus der Texterkennung) -> "23.11.2026 17:15"; sonst ''
function psO2OfferTs(str) {
  const m = /(\d{1,2})[.\s]?(\d{2})[.\s]?(20\d{2})\D{0,3}(\d{1,2})\s*[:.]\s*(\d{2})/.exec(String(str || ''));
  if (!m) return '';
  return ('0' + m[1]).slice(-2) + '.' + m[2] + '.' + m[3] + ' ' + ('0' + m[4]).slice(-2) + ':' + m[5];
}
// Gehoert ein neues Foto zum selben Angebot? a/b = { id: Beratungs-ID, ts: Zeitstempel }. 'same' | 'other' | 'unknown'
function psO2OfferCmp(a, b) {
  a = a || {}; b = b || {};
  const idEq = a.id && b.id ? a.id === b.id : null, tsEq = a.ts && b.ts ? a.ts === b.ts : null;
  if (idEq === true || tsEq === true) return 'same'; // ein gleiches Kennzeichen genuegt (das andere kann verlesen sein)
  if (idEq === false || tsEq === false) return 'other';
  return 'unknown';
}
// Fehlende Preise aus dem anderen Foto ergaenzen, vorhandene nie ueberschreiben
function psO2FillAm(a, b) {
  if (!b) return a; if (!a) return b;
  const r = [a[0] != null ? a[0] : b[0], a[1] != null ? a[1] : b[1]];
  return r[0] === a[0] && r[1] === a[1] ? a : r;
}
// Antwort des Dienstes in dieselbe Form bringen, die auch der eigene Parser liefert (Reihenfolge ueber idx:
// so landet jedes Handy spaeter bei seinem Tarif).
// v55.230: Mehrseitiger Beleg: Internet@Home-Details koennen auf Seite 2 ohne Produktkopf beginnen.
function psO2Page2InternetDetails(txt) {
  const lines = String(txt || "").split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  const begin = lines.findIndex(x => /Installationsadresse/i.test(x));
  if (begin < 0 || !/(Einmalige|Monatliche)\s*Kosten/i.test(txt)) return [];
  const details = [];
  for (let i = begin + 1; i < Math.min(lines.length, begin + 16); i++) {
    const x = lines[i];
    if (/(Einmalige|Monatliche)\s*Kosten|^Aktuell\b|Seite\s+\d+\s+von/i.test(x)) break;
    const d = psO2Detail(x);
    if (d && !details.some(y => psO2Similar(y, d))) details.push(d);
  }
  return details.slice(0, 10);
}
// Schutz gegen falsche Zuordnung einer hohen Einmalsumme zum Monatsbetrag.
function psO2SuspectTotals(r) {
  return !!(r && r.einmalig && r.monatlich && r.einmalig === r.monatlich && (psO2Cents(r.einmalig) || 0) >= 100000);
}
function psO2JoinDetails(oldText, additions) {
  const all = String(oldText || "").split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  (additions || []).forEach(x => {
    const detail = psO2Detail(x);
    if (detail && !all.some(y => psO2Similar(y, detail))) all.push(detail);
  });
  return all.slice(0, 12).join("\n");
}
// === v55.193 (Beta): LESEN NACH POSITION ===================================================================
// Die Texterkennung liefert zu jedem Wort die Lage im Bild. Damit wird (1) nur die Positionsliste gelesen – ohne
// Suchfeld, Tabs, Seitenleiste ("Bedarfsanalyse", "Aktuell") und Buttons – und (2) jeder Preis ueber seine SPALTE
// (einmalig | monatlich) zugeordnet statt ueber die Zeile (der Preis steht oft in der Kopfzeile TARIF/HANDY oder
// rutscht beim Foto in die Nachbarzeile). Der Parser (psO2Parse) bleibt derselbe, er bekommt nur saubereren Text.
// Sind die Spaltenkoepfe nicht erkennbar, passiert nichts: dann gilt der unveraenderte Text.
function psO2WordsOf(data) {
  const out = [];
  let ln = 0;
  try {
    ((data && data.blocks) || []).forEach(b => (b.paragraphs || []).forEach(p => (p.lines || []).forEach(l => {
      ln++;
      (l.words || []).forEach(w => {
        const bb = w && w.bbox, t = w && String(w.text || '').trim();
        if (t && bb) out.push({ t, x0: bb.x0, y0: bb.y0, x1: bb.x1, y1: bb.y1, ln });
      });
    })));
  } catch (e) {}
  if (!out.length && data && typeof data.tsv === 'string') {
    data.tsv.split(/\r?\n/).forEach(row => {
      const c = row.split('\t');
      if (c.length < 12 || c[0] !== '5') return;
      const t = c.slice(11).join(' ').trim(), x = +c[6], y = +c[7];
      if (t) out.push({ t, x0: x, y0: y, x1: x + (+c[8]), y1: y + (+c[9]), ln: (+c[2]) * 100000 + (+c[3]) * 1000 + (+c[4]) });
    });
  }
  return out;
}
function psO2WordsToText(words, sparse) {
  if (!words || words.length < 8) return '';
  const byLn = new Map();
  words.forEach(w => { if (!byLn.has(w.ln)) byLn.set(w.ln, []); byLn.get(w.ln).push(w); });
  const yc = ws => ws.reduce((s, w) => s + (w.y0 + w.y1) / 2, 0) / ws.length;
  const lines = Array.from(byLn.values()).map(ws => ws.slice().sort((a, b) => a.x0 - b.x0)).sort((a, b) => yc(a) - yc(b));
  const hs = words.filter(w => w.t.replace(/[^A-Za-zÄÖÜäöüß0-9]/g, '').length >= 3).map(w => w.y1 - w.y0).sort((a, b) => a - b);
  const medH = hs.length ? hs[Math.floor(hs.length / 2)] : 14;
  const txt = ws => ws.map(w => w.t).join(' ');
  // Betrag mit Komma (oder verlesenem Punkt: "39.99")
  const AMT = /\d{1,3}(?:\.\d{3})*,\d{2}|\d{1,3}\.\d{2}(?!\d)/;
  const norm = x => /^\d{1,3}\.\d{2}$/.test(x) ? x.replace('.', ',') : x;
  const mean = v => v.reduce((s, x) => s + x, 0) / v.length;
  const isE = t => /^\W*\w{0,3}mal[iıl1|]g\W*$/i.test(t), isM = t => /^\W*\w{0,2}onatl[iıl1|]ch\W*$/i.test(t);
  const reE = /(Einmalige|alige)\s*Kosten/i, reM = /(Monatliche|natliche)\s*Kosten/i;
  // Sparse OCR liefert Beschriftungen und Beträge als getrennte Zeilen. Die
  // Überschriften liefern Spalten und Neigung unabhängig von der Bildgröße.
  if (sparse) {
    const e = words.find(w => isE(w.t));
    let m = e && words.find(w => isM(w.t) && Math.abs(w.y0 - e.y0) < 2 * medH);
    if (e && !m) {
      // Unlesbarer Monatsspaltenkopf: bestätige seine Lage durch wiederholte Beträge darunter.
      m = words.find(w => w.x0 > e.x1 + 3 * medH && Math.abs(w.y0 - e.y0) < 2 * medH &&
        words.filter(v => AMT.test(v.t) && v.y0 > w.y1 && Math.abs(v.x1 - w.x1) < Math.min((w.x0 - e.x0) / 2, 6 * medH)).length >= 2);
    }
    if (e && m && m.x0 - e.x0 > 4 * medH && Math.abs(m.y0 - e.y0) < 2 * medH) {
      const span = m.x0 - e.x0;
      const slope = Math.max(-0.08, Math.min(0.08, (m.y0 - e.y0) / span));
      const anchors = lines.filter(ws => ws[0].x0 < e.x0 - span &&
        (Object.values(PS_O2_NAME).some(re => re.test(txt(ws))) ||
        /Rabatt|Anschluss|Grundgeb|Einmalige Kosten|Monatliche Kosten|Vorteil|Gutschrift/i.test(txt(ws))));
      const joined = new Set();
      const eLine = lines.find(row => row.includes(e)), mLine = lines.find(row => row.includes(m));
      if (!isM(m.t)) mLine[mLine.indexOf(m)] = Object.assign({}, m, { t: 'monatlich' });
      if (eLine !== mLine) { eLine.push(...mLine); joined.add(mLine); }
      for (const ws of lines) {
        if (ws[0].x0 < e.x0 - span || !/^[-−–+ ]*\d[\d.,]*\s*[€£*]*$/.test(txt(ws)) || !AMT.test(txt(ws))) continue;
        let target, best = 1.65 * medH;
        for (const row of anchors) {
          const dy = Math.abs(yc(ws) - yc(row.filter(w => w.x0 < e.x0 - span)) - slope * (ws[0].x0 - row[0].x0));
          if (dy < best) { best = dy; target = row; }
        }
        if (target) { target.push(...ws); joined.add(ws); }
      }
      for (let i = lines.length - 1; i >= 0; i--) {
        if (joined.has(lines[i])) lines.splice(i, 1);
        else lines[i].sort((a, b) => a.x0 - b.x0);
      }
    }
  }
  const firstHead = lines.findIndex(ws => psO2HeadKind(txt(ws)));
  const costIdx = lines.findIndex(ws => reE.test(txt(ws)) || reM.test(txt(ws)));
  // Rechter Rand jedes Preises (Betrag samt "€"/"*" dahinter) – Preise stehen rechtsbuendig in ihrer Spalte
  const edgeOf = (ws, i) => { const nx = ws[i + 1]; return nx && /^[€*£]+$/.test(nx.t) ? nx.x1 : ws[i].x1; };
  const isAmt = w => AMT.test(w.t) && !/[A-Za-zÄÖÜäöü]{2,}/.test(w.t);
  // 1. Spaltenkoepfe "einmalig | monatlich" (stehen vor dem ersten Bereich) – oft zu klein/grau gelesen, dann Schritt 2
  const lim = firstHead > -1 ? firstHead : (costIdx > -1 ? costIdx : lines.length);
  let hdrIdx = -1, hE = null, hM = null;
  for (let i = 0; i < lim; i++) {
    const e = lines[i].find(w => isE(w.t)), m = lines[i].find(w => isM(w.t));
    if (m && (e || lines[i].length <= 4 || lines[i].some(w => /^Art[il1]kel$/i.test(w.t)))) { hdrIdx = i; hE = e || null; hM = m; }
  }
  let Ex1 = hE ? hE.x1 : null, Mx1 = hM ? hM.x1 : null;
  // 2. Sonst aus den Preisen selbst: "monatlich" ist die Spalte mit den meisten rechtsbuendigen Betraegen (bei Gleichstand die rechte);
  // "einmalig" die Gruppe 4-14 Zeilenhoehen links davon (Gesamtpreis-/Ersparnis-Zeilen zaehlen nicht)
  let firstAmt = -1;
  if (Mx1 == null) {
    const edges = [];
    lines.forEach((ws, idx) => {
      if (/Gesamtpreis|Ersparnis/i.test(txt(ws))) return;
      ws.forEach((w, i) => { if (isAmt(w)) { edges.push(edgeOf(ws, i)); if (firstAmt < 0) firstAmt = idx; } });
    });
    edges.sort((a, b) => a - b);
    const groups = [];
    edges.forEach(x => { const g = groups[groups.length - 1]; if (g && x - g.max <= 2.5 * medH) { g.v.push(x); g.max = x; } else groups.push({ v: [x], max: x }); });
    // "monatlich" = rechteste Gruppe mit mind. 2 Betraegen (die Spalte "einmalig" kann mehr Eintraege haben, steht aber links davon)
    // v55.199: Zeilen mit zwei Betraegen nebeneinander (Kopfzeile "39,99 € 19,99 €", Handy "1,00 € 20,50 €") zeigen beide Spalten direkt.
    // Zeigt ein Foto nur EINEN Block, steht in "monatlich" oft nur ein Betrag - die Gruppenregel hielte dann "einmalig" fuer "monatlich".
    const pl = [], pr = [];
    lines.forEach(ws => {
      if (/Gesamtpreis|Ersparnis/i.test(txt(ws))) return;
      const ed = []; ws.forEach((w, i) => { if (isAmt(w)) ed.push(edgeOf(ws, i)); });
      if (ed.length >= 2) { const a = ed[ed.length - 2], b = ed[ed.length - 1]; if (b - a >= 4 * medH && b - a <= 14 * medH) { pl.push(a); pr.push(b); } }
    });
    const mg = groups.filter(g => g.v.length >= 2).sort((a, b) => b.max - a.max)[0];
    if (pr.length && (!mg || mean(pr) - mg.max > 3 * medH)) { Mx1 = mean(pr); Ex1 = mean(pl); }
    else if (mg) {
      Mx1 = mean(mg.v);
      const eg = groups.filter(g => g !== mg && Mx1 - mean(g.v) >= 4 * medH && Mx1 - mean(g.v) <= 14 * medH).sort((a, b) => b.v.length - a.v.length || b.max - a.max)[0];
      if (eg) Ex1 = mean(eg.v);
    }
  }
  if (Mx1 == null) return '';
  // Oben: Kopfzeile bzw. Programmkopf (Tabs, Suchfeld) weg; rechts neben "monatlich": Seitenleiste (Bedarfsanalyse, Werbung, "Ersparnis"-Schild);
  // unten: die Buttons (Bestellen / Als E-Mail senden / Ausdrucken) unter dem Kostenblock
  let topIdx = hdrIdx;
  if (topIdx < 0) {
    const chrome = /Activate|Bestandskunde|Neue\s+Beratung|Beratung\s+öffnen|Verwaltete|Favoriten|VO:/i;
    for (let i = 0; i < lines.length && (firstAmt < 0 || i < firstAmt); i++) if (chrome.test(txt(lines[i]))) topIdx = i;
  }
  // v55.227: schraeg/perspektivisch fotografiert -> die Spalten laufen mit der Zeilenhoehe nach links/rechts (gemessen: ~10 % Neigung).
  // Spaltenlage je Hoehe als Gerade x = a + b*y aus den Betraegen selbst schaetzen (Kopfzeile "einmalig/monatlich" zaehlt mit).
  const colPts = [];
  lines.forEach(ws => { if (/Gesamtpreis|Ersparnis/i.test(txt(ws))) return; const y = yc(ws); ws.forEach((w, i) => { if (isAmt(w)) colPts.push({ x: edgeOf(ws, i), y }); }); });
  const fitCol = (x0, anchor, other, b0) => {
    const y0 = anchor ? (anchor.y0 + anchor.y1) / 2 : 0;
    let b = b0 || 0, a = x0;
    for (let it = 0; it < 3; it++) {
      const P = colPts.filter(p => { const dd = Math.abs(p.x - (a + b * (p.y - y0))); return dd <= 3.5 * medH && (!other || dd <= Math.abs(p.x - other(p.y))); });
      if (anchor) P.push({ x: x0, y: y0 });
      if (P.length < 3) break;
      const ys = P.map(p => p.y), my = mean(ys), mx = mean(P.map(p => p.x)), vy = ys.reduce((q, y) => q + (y - my) * (y - my), 0);
      if (vy < 9 * medH * medH * P.length) break; // Betraege muessen ueber die Hoehe verteilt sein, sonst keine Neigung schaetzen
      b = Math.max(-0.25, Math.min(0.25, P.reduce((q, p) => q + (p.y - my) * (p.x - mx), 0) / vy));
      a = mx + b * (y0 - my);
    }
    return { a, b, y0 };
  };
  let EL = null, ML = null;
  const EcolX = y => EL ? EL.a + EL.b * (y - EL.y0) : Ex1, McolX = y => ML ? ML.a + ML.b * (y - ML.y0) : Mx1;
  // Beide Spalten haben (fast) dieselbe Neigung: hat eine Spalte zu wenige Betraege, uebernimmt sie die Neigung der anderen
  if (colPts.length >= 3) {
    if (Ex1 != null) { EL = fitCol(Ex1, hE, McolX); ML = fitCol(Mx1, hM, EcolX, EL.b); EL = fitCol(Ex1, hE, McolX, ML.b || EL.b); }
    else ML = fitCol(Mx1, hM, null);
  }
  const cutX = Mx1 + 1.5 * medH;
  const botIdx = costIdx > -1 ? lines.findIndex((ws, i) => i > costIdx && /Auftragsstatus|Bestellen\b|E-?\s?Mail\s?senden|Ausdruck/i.test(txt(ws))) : -1;
  const colOf = (x, y) => {
    const mX = y == null ? Mx1 : McolX(y), eX = y == null ? Ex1 : EcolX(y);
    if (Ex1 != null) { const dm = Math.abs(x - mX), de = Math.abs(x - eX); return Math.min(dm, de) > 3.5 * medH ? '' : dm <= de ? 'm' : 'e'; }
    const d = mX - x;
    return d >= -1.5 * medH && d <= 3 * medH ? 'm' : d >= 4 * medH && d <= 14 * medH ? 'e' : '';
  };
  const kept = [];
  lines.forEach((ws, idx) => {
    if (idx <= topIdx || (botIdx > -1 && idx >= botIdx)) return;
    const w2 = ws.filter(w => w.x0 <= Math.max(cutX, McolX(yc(ws)) + 1.5 * medH));
    if (w2.length) kept.push({ idx, ws: w2, y: yc(w2), t: txt(w2) });
  });
  // Kostenblock: die Summen stehen rechtsbuendig in ihrer Spalte, aber oft eine Zeile versetzt zu ihrer Beschriftung.
  // Betraege im Bereich um die beiden Beschriftungen (ueber Spalte zugeordnet) werden den Beschriftungen zugeschrieben.
  const lE = kept.find(k => reE.test(k.t)), lM = kept.find(k => reM.test(k.t));
  const lab = lE || lM;
  let zTop = -Infinity, zBot = -Infinity, E = null, M = null;
  if (lab) {
    zTop = (lE || lM).y - 3.2 * medH;
    zBot = lM ? lM.y + 1.5 * medH : lE.y + 5 * medH;
    if (lE && lM && lM.y < lE.y) { zTop = lM.y - 3.2 * medH; zBot = lE.y + 1.5 * medH; }
  }
  // v55.198: PDF-Seite "Einmalige/Monatliche Kosten": beide Summen stehen untereinander in EINER Spalte, je neben ihrer Beschriftung -> nach Zeile zuordnen
  if (lE && lM) {
    const za = [];
    kept.forEach(k => { if (k.y < zTop || k.y > zBot) return; k.ws.forEach((w, i) => { if (!isAmt(w)) return; const c = colOf(edgeOf(k.ws, i), k.y); if (c) za.push({ y: k.y, c, v: norm(w.t.match(AMT)[0]) }); }); });
    if (za.length >= 2 && za.every(a => a.c === 'm')) {
      const near = L => za.slice().sort((a, b) => Math.abs(a.y - L.y) - Math.abs(b.y - L.y))[0];
      const ae = near(lE), am = near(lM);
      if (ae !== am && Math.abs(ae.y - lE.y) < 1.2 * medH && Math.abs(am.y - lM.y) < 1.2 * medH) { E = ae.v; M = am.v; }
    }
  }
  const out = [];
  let attE = false, attM = false;
  kept.forEach(k => {
    const inZone = lab && k.y >= zTop && k.y <= zBot;
    const toks = [], col = { e: null, m: null };
    for (let i = 0; i < k.ws.length; i++) {
      const w = k.ws[i];
      if (isAmt(w)) {
        const c = colOf(edgeOf(k.ws, i), k.y), eu = k.ws[i + 1] && /^[€*£]+$/.test(k.ws[i + 1].t);
        if (c && inZone) {
          // Kostenblock: erster Betrag je Spalte (von oben) = Summe; weitere Betraege in der Spalte (z. B. Ersparnis) verwerfen
          if (c === 'e' && E == null) E = norm(w.t.match(AMT)[0]);
          if (c === 'm' && M == null) M = norm(w.t.match(AMT)[0]);
          if (eu) i++;
          continue;
        }
        if (c && !inZone && col[c] == null) { col[c] = norm(w.t.match(AMT)[0]); if (eu) i++; continue; }
      }
      toks.push(w.t);
    }
    if (!inZone && (col.e != null || col.m != null)) toks.push((col.e != null ? col.e + ' €' : '–') + ' ' + (col.m != null ? col.m + ' €' : '–'));
    let t = toks.join(' ');
    if (inZone) {
      // Preiserhoehung "*Ab dem 25. Monat: 84,98 €" (klein gedruckt, ausserhalb der Spalten) wird ignoriert: Text und Betrag weg.
      // Uebrig gebliebene Betraege an der Monatlich-Zeile sind nie die Summe.
      t = t.replace(PS_O2_AB_MONAT, ' ').replace(/\*?\s*Ab\s*dem\s*\d{1,2}\.?\s*Mon\w*:?/i, ' ');
      if (reM.test(t)) t = t.replace(new RegExp(AMT.source, 'g'), ' ');
      t = t.replace(/\s+/g, ' ').trim();
      if (reE.test(t) && E != null && !attE) { t += ' ' + E + ' €'; attE = true; }
      else if (reM.test(t) && M != null && !attM) { t += ' ' + M + ' €'; attM = true; }
    }
    if (t.trim()) out.push(t);
  });
  if (E != null && !attE) out.push('Einmalige Kosten ' + E + ' €');
  if (M != null && !attM) out.push('Monatliche Kosten ' + M + ' €');
  return out.join('\n');
}
// Wie gut ist ein Leseergebnis? Mehr erkannte Felder und stimmige Summen = besser.
function psO2Score(r) {
  if (!r) return -1;
  let s = Math.min(r.tarife.length, 6) + Math.min(r.geraete.length, 6) + Math.min(r.internet.length, 2) + (r.einmalig ? 1 : 0) + (r.monatlich ? 1 : 0);
  const c = psO2Check(r);
  if (c) [c.e, c.m].forEach(x => { if (x) s += x.ok ? 2 : -1; });
  return s;
}
// Was auf dem Foto zu sehen ist, aber (noch) nicht gelesen wurde -> noch ein Durchgang lohnt sich.
function psO2Gaps(r, txt) {
  const g = [];
  if (!r.geraete.length && /My\s?Handy|Gesamtpreis|\bHANDY\b|iPhone|Galaxy|PIXE|Xiaomi|Samsung/i.test(txt)) g.push('geraete');
  if (!r.tarife.length && /\bTARIF\b|(?:Mobile|Free|Grow|Unlimited)\s+(?:S|M|L|XL)\b/i.test(txt)) g.push('tarife');
  if (!(r.einmalig && r.monatlich) && /(Einmalige|Monatliche)\s*Kosten/i.test(txt)) g.push('kosten');
  // v55.224: mehr Bloecke im Bild als Eintraege gelesen (z. B. 2 x TARIF, aber nur 1 Tarif erkannt)
  if (r.hdr) { if (r.hdr.tarife > r.tarife.length) g.push('tarife-anzahl'); if (r.hdr.geraete > r.geraete.length) g.push('geraete-anzahl'); }
  const c = psO2Check(r);
  if (c && [c.e, c.m].some(x => x && !x.ok)) g.push('summen');
  // Summen gelesen, aber Einzelpreise nicht vollstaendig -> Pruefung unmoeglich; ein weiterer (entrauschter) Durchgang findet oft den fehlenden Tarif/Preis
  if ((r.tarife || []).some(it => !it.am || it.am[1] == null) || (r.internet || []).some(it => !it.am || it.am[1] == null) ||
      (!c && (r.einmalig || r.monatlich) && (r.geraete || []).some(it => !it.am))) g.push('einzelpreise');
  return g;
}
// Wie "echt" ist ein gelesener Produktname? Anteil der Woerter, die zu Geraeten/Tarifen/Farben passen (Lesemuell wie "Goc Igle" faellt auf).
const PS_O2_KNOWN = /^(?:O2|Google|Pixel|Pro|Max|Plus|Ultra|Mini|Air|Fold|Flip|FE|SE|XL|Apple|iPhone|iPad|Samsung|Galaxy|Xiaomi|Redmi|Poco|Motorola|Moto|Edge|Razr|Nokia|Oppo|Find|Honor|Magic|Huawei|Fairphone|OnePlus|Sony|Xperia|Nothing|Phone|Watch|AirPods|Mobile|Free|Grow|Unlimited|Home|Smart|Basic|Prepaid|Frost|Schwarz|Weiß|Weiss|Blau|Grün|Gruen|Rot|Rosa|Grau|Silber|Gold|Violett|Lila|Beige|Creme|Titan|Graphit|Mint|Lavendel|Burgunder|Cosmic|Orange|Black|White|Blue|Green|Silver|Obsidian|Porcelain|Hazel|Bay|Iris|Peony|Lemongrass|Jade|Navy|Midnight|Starlight|Natural|Desert|Ocean|Teal|Ultramarine|Space|Deep|Sky|Moonstone|Charcoal|LTE|5G|GB|TB|DSL|Kabel|Glasfaser|Router|Box|Cube)$/i;
function psO2NameQ(name) {
  const t = String(name || '').split(/\s+/).map(w => w.replace(/^[(\[]+|[)\],.;:]+$/g, '')).filter(Boolean);
  if (!t.length) return 0;
  return t.filter(w => /\d/.test(w) || /^[A-Z]{2}$/.test(w) || /^(?:XS|S|M|L|XL|XXL)$/.test(w) || PS_O2_KNOWN.test(w)).length / t.length; // v55.224: S/M/L = Tarifgroesse
}
function psO2ItemQ(kind, it) { return psO2NameQ(kind === 'geraete' ? psO2Pretty(it.name) : it.name); }
// Qualitaet einer Liste (Tarife/Handys/Internet) aus einem Durchgang: echte Namen, viele Inhaltszeilen, Preise vorhanden
function psO2ListQ(kind, list) {
  return list.reduce((s, it) => s + psO2ItemQ(kind, it) * 3 + Math.min((it.details || []).length, 6) * 0.5 + (it.am ? 0.5 : 0), 0);
}
// Weiche Luecken: alles gelesen, aber ein Name sieht nach Lesemuell aus oder ein Tarif hat auffallend wenig Inhalte -> ein zweiter Durchgang lohnt sich
function psO2Soft(r) {
  return ['tarife', 'geraete', 'internet'].some(k => (r[k] || []).some(it => psO2ItemQ(k, it) < 0.8)) || (r.tarife || []).some(t => (t.details || []).length < 3 || !/\b(?:S|M|L|XL)\b/.test(t.name));
}
// Ergebnisse mehrerer Durchgaenge zusammenfuehren: je Bereich die Liste mit der besten Qualitaet, bei Summen gewinnt der Wert, der
// am haeufigsten gelesen wurde (bei Gleichstand der fruehere).
// v57: Summen eines Durchgangs plausibel? (Schutz gegen vertauschte Einmal-/Monatssummen durch Zeilenversatz)
function psO2TotalsPlausible(x, all) {
  if (!x) return false;
  const max = (typeof window !== 'undefined' && window.PS_SMART_SCAN && window.PS_SMART_SCAN.monthlyMaxCents) || 100000;
  if (x.monatlich && (psO2Cents(x.monatlich) || 0) >= max) return false;
  if (x.monatlich && (all || []).some(y => y !== x && y.einmalig && y.einmalig === x.monatlich && !(y.monatlich && (psO2Cents(y.monatlich) || 0) >= max))) return false;
  return true;
}
function psO2Combine(res) {
  const pick = kind => {
    const L = res.map(x => x[kind]).filter(a => a && a.length);
    if (!L.length) return [];
    return L.slice().sort((a, b) => psO2ListQ(kind, b) - psO2ListQ(kind, a))[0];
  };
  // v55.214: Durchgang mit Einmalig = Monatlich (schraeges Foto: Betrag in die falsche Zeile gerutscht) zaehlt nicht,
  // wenn ein anderer Durchgang zwei verschiedene Summen gelesen hat
  const twoDiff = res.some(x => x.einmalig && x.monatlich && x.einmalig !== x.monatlich);
  // v57: Zeilenversatz-Schutz. Liest ein Durchgang die Summen um eine Zeile verschoben, landet die Einmalsumme im
  // Monatsfeld (z. B. Monatlich 2.468,98 €). Solche Summen zählen nicht: Monatlich ab PS_SMART_SCAN.monthlyMaxCents
  // (Standard 1.000 €) ist unplausibel, ebenso ein Monatsbetrag, den ein anderer Durchgang als Einmalsumme gelesen hat.
  // Betroffen sind dann BEIDE Summen dieses Durchgangs. Lieber leer (Mitarbeiter trägt ein) als vertauscht.
  const totalsOk = x => psO2TotalsPlausible(x, res);
  const vote = f => {
    const cnt = {};
    const tot = f === 'einmalig' || f === 'monatlich';
    res.forEach(x => { if (x[f] && !(tot && !totalsOk(x)) && !(twoDiff && tot && x.einmalig === x.monatlich)) cnt[x[f]] = (cnt[x[f]] || 0) + (x.byPos ? 2 : 1) + (x.einmalig && x.monatlich && x.einmalig !== x.monatlich ? 1 : 0); });
    let best = '', n = 0;
    res.forEach(x => { if (x[f] && cnt[x[f]] > n && !(tot && !totalsOk(x))) { best = x[f]; n = cnt[x[f]]; } });
    return best;
  };
  const kinds = ['geraete', 'tarife', 'internet'];
  const chosen = Object.fromEntries(kinds.map(k => [k, pick(k)]));
  const einmalig = vote('einmalig'), monatlich = vote('monatlich');
  // Ein Durchgang mit beiden exakt passenden Summen liefert zusammengehörige
  // Preise und Rabatte. Lesbarere Namen können aus den übrigen Läufen stammen.
  const verified = res.find(x => {
    if (!einmalig || !monatlich || x.einmalig !== einmalig || x.monatlich !== monatlich ||
        !kinds.every(k => x[k].length === chosen[k].length)) return false;
    const c = psO2Check(x);
    return c && [c.e, c.m].every(v => v && v.calc.includes(v.val));
  });
  const fill = kind => {
    if (!verified) return psO2FillPrices(chosen[kind], res, kind);
    return verified[kind].map((ref, i) => {
      const it = chosen[kind][i];
      return psO2Similar(it.name, ref.name) ? Object.assign({}, it, { am: ref.am, rb: ref.rb }) : ref;
    });
  };
  const hdr = { tarife: 0, geraete: 0, internet: 0 };
  res.forEach(x => { if (x.hdr) Object.keys(hdr).forEach(k => { hdr[k] = Math.max(hdr[k], x.hdr[k] || 0); }); });
  return { tarife: fill('tarife'), geraete: fill('geraete'), internet: fill('internet'), hdr, einmalig: vote('einmalig'), monatlich: (() => { const e = vote('einmalig'), m = vote('monatlich'); if (!e || m !== e) return m; const alt = res.filter(totalsOk).map(x => x.monatlich).filter(v => v && v !== e); return alt.length ? alt[0] : m; })(), hinweis: vote('hinweis'), mixed: res.length > 1 };
}
// v55.224: Fehlt einem Eintrag ein Preis, der in einem anderen Durchgang an gleicher Stelle gelesen wurde, wird er von dort ergaenzt
// (n-tes Vorkommen gleichen Namens = gleicher Eintrag). "monatlich" nur bei Tarif/Internet (ein Handy hat oft keinen Monatspreis).
function psO2FillPrices(list, res, kind) {
  if (!list || !list.length || res.length < 2) return list;
  const ord = it => { let n = 0; for (const x of list) { if (x === it) return n; if (psO2Similar(x.name, it.name)) n++; } return n; };
  return list.map(it => {
    const rb0 = it.rb || { e: 0, m: 0, bad: false };
    if (it.am && it.am[0] != null && it.am[1] != null && rb0.e && rb0.m) return it;
    const am = it.am ? it.am.slice() : [null, null], rb = Object.assign({}, rb0), n = ord(it); // v55.227: auch Eintraege ganz ohne Preis und fehlende Rabatte ergaenzen
    for (const o of res) {
      const arr = o[kind] || [];
      if (arr === list) continue;
      const same = arr.filter(x => (x.am || x.rb) && psO2Similar(x.name, it.name)), cand = same[n] || same[0];
      if (!cand) continue;
      if (cand.am) [0, 1].forEach(c => { if (am[c] == null && cand.am[c] != null && (c === 0 || kind !== 'geraete')) am[c] = cand.am[c]; });
      if (cand.rb) ['e', 'm'].forEach(c => { if (!rb[c] && cand.rb[c] && !cand.rb.bad) rb[c] = cand.rb[c]; });
    }
    const same0 = it.am ? am[0] === it.am[0] && am[1] === it.am[1] : am[0] == null && am[1] == null;
    if (same0 && rb.e === rb0.e && rb.m === rb0.m) return it;
    return Object.assign({}, it, { am: am[0] == null && am[1] == null ? it.am : am, rb });
  });
}
// v55.227: enthaelt gelesener Text Spuren eines o2-Vorschlags (Bereichsueberschriften, Kostenzeilen, mind. 2 Betraege)?
function psO2Signal(t) {
  t = String(t || '');
  const n = (/INTERNET\s?@\s?HOME|\bHANDY\b|\bTARIF\b/i.test(t) ? 1 : 0) + (/(Einmalige|Monatliche)\s*Kosten|einmalig|monatlich/i.test(t) ? 1 : 0) + ((t.match(/\d{1,3}(?:\.\d{3})*,\d{2}/g) || []).length >= 2 ? 1 : 0);
  return n >= 2;
}
// v55.227: wie viele Einzelpreise/Rabatte/Summen gelesen sind (Fortschritt eines weiteren Durchgangs)
function psO2Filled(r) {
  if (!r) return 0;
  let n = (r.einmalig ? 1 : 0) + (r.monatlich ? 1 : 0);
  ['tarife', 'geraete', 'internet'].forEach(k => (r[k] || []).forEach(it => { if (it.am) n += (it.am[0] != null ? 1 : 0) + (it.am[1] != null ? 1 : 0); if (it.rb) n += (it.rb.e ? 1 : 0) + (it.rb.m ? 1 : 0); }));
  return n;
}
// v55.209: Lage jedes Eintrags im Foto (0 = oben, 1 = unten) aus den Wortpositionen – fuer die Ueberschneidung beim Scannen
function psO2PlaceItems(r, words) {
  if (!r || !words || words.length < 8) return;
  const byLn = new Map();
  words.forEach(w => { if (!byLn.has(w.ln)) byLn.set(w.ln, []); byLn.get(w.ln).push(w); });
  const L = Array.from(byLn.values()).map(ws => ({ t: ws.map(w => w.t).join(' ').toLowerCase(), y: ws.reduce((a, w) => a + (w.y0 + w.y1) / 2, 0) / ws.length })).sort((a, b) => a.y - b.y);
  let Y0 = Infinity, Y1 = -Infinity;
  words.forEach(w => { if (w.y0 < Y0) Y0 = w.y0; if (w.y1 > Y1) Y1 = w.y1; });
  if (!(Y1 - Y0 > 10)) return;
  const hit = (nm, t) => { const tk = String(nm || '').toLowerCase().replace(/[(),]/g, ' ').split(/\s+/).filter(x => x.length >= 2); return tk.length > 0 && tk.filter(x => t.indexOf(x) > -1).length / tk.length >= 0.6; };
  ['tarife', 'geraete', 'internet'].forEach(kind => {
    let from = 0;
    (r[kind] || []).forEach(it => {
      const j = L.findIndex((l, li) => li >= from && (hit(it.name, l.t) || kind === 'geraete' && hit(psO2Pretty(it.name), l.t)));
      if (j >= 0) { it.yf = (L[j].y - Y0) / (Y1 - Y0); from = j + 1; }
    });
  });
}

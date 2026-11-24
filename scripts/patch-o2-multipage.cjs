'use strict';
// Applies an idempotent, targeted fix to the large monolithic index.html on this feature branch.
// Run from repository root. Does not require internet, dependencies or access to customer data.
const fs = require('node:fs');
const path = require('node:path');
const indexPath = path.join(__dirname, '../index.html');
let s = fs.readFileSync(indexPath, 'utf8');
// Release version: update the actual UI indicator (not just comments), even when the OCR patch is already present.
const versionAnchor = "window.APP_VERSION = '55.229';";
const versionUpdated = "window.APP_VERSION = '55.230';";
if (s.includes(versionAnchor)) {
  if (s.indexOf(versionAnchor) !== s.lastIndexOf(versionAnchor)) throw new Error('Duplicate version declaration');
  s = s.replace(versionAnchor, versionUpdated);
  fs.writeFileSync(indexPath, s, 'utf8');
  console.log('Updated user-facing version to 55.230.');
} else if (!s.includes(versionUpdated)) {
  throw new Error('Unexpected application version; aborting release');
}
if (s.includes('function psO2Page2InternetDetails(txt) {')) {
  // Follow-up fix: page 1 has no total block, but prices can still be missing.
  // Keep retrying a targeted local pass instead of accepting empty S/Home prices.
  const original = "  if (!c && (r.einmalig || r.monatlich) && ([].concat(r.tarife || [], r.geraete || []).some(it => !it.am) || (r.tarife || []).some(t => t.am[1] == null))) g.push('einzelpreise');";
  const improved = "  if ((r.tarife || []).some(it => !it.am || it.am[1] == null) || (r.internet || []).some(it => !it.am || it.am[1] == null) ||" +
    "\r\n      (!c && (r.einmalig || r.monatlich) && (r.geraete || []).some(it => !it.am))) g.push('einzelpreise');";
  if (s.includes(original)) {
    s = s.replace(original, improved);
    const jsStart = s.indexOf('const PS_O2_AMT'), jsEnd = s.indexOf('// === v55.176 (Beta)', jsStart);
    new Function(s.slice(jsStart, jsEnd));
    fs.writeFileSync(indexPath, s, 'utf8');
    console.log('Applied additional missing-price retry for first page.');
  } else if (!s.includes("(!c && (r.einmalig || r.monatlich) && (r.geraete || []).some(it => !it.am))")) {
    throw new Error('Missing price-gap anchor unexpectedly changed');
  }
  process.exit(0);
}
const NL = s.includes('\r\n') ? '\r\n' : '\n';
const changes = [];
function rep(a, b, label) {
  const pos = s.indexOf(a);
  if (pos < 0 || s.indexOf(a, pos + 1) >= 0) throw new Error('Invalid or duplicate anchor: ' + label);
  s = s.slice(0, pos) + b + s.slice(pos + a.length);
  changes.push(label);
}
const helpers = [
  '// v55.230: Mehrseitiger Beleg: Internet@Home-Details koennen auf Seite 2 ohne Produktkopf beginnen.',
  'function psO2Page2InternetDetails(txt) {',
  '  const lines = String(txt || "").split(/\\r?\\n/).map(x => x.trim()).filter(Boolean);',
  '  const begin = lines.findIndex(x => /Installationsadresse/i.test(x));',
  '  if (begin < 0 || !/(Einmalige|Monatliche)\\s*Kosten/i.test(txt)) return [];',
  '  const details = [];',
  '  for (let i = begin + 1; i < Math.min(lines.length, begin + 16); i++) {',
  '    const x = lines[i];',
  '    if (/(Einmalige|Monatliche)\\s*Kosten|^Aktuell\\b|Seite\\s+\\d+\\s+von/i.test(x)) break;',
  '    const d = psO2Detail(x);',
  '    if (d && !details.some(y => psO2Similar(y, d))) details.push(d);',
  '  }',
  '  return details.slice(0, 10);',
  '}',
  '// Schutz gegen falsche Zuordnung einer hohen Einmalsumme zum Monatsbetrag.',
  'function psO2SuspectTotals(r) {',
  '  return !!(r && r.einmalig && r.monatlich && r.einmalig === r.monatlich && (psO2Cents(r.einmalig) || 0) >= 100000);',
  '}',
  'function psO2CloudNeedsLocal(r, stage, previous) {',
  '  if (!r || (stage !== "ganz" && stage !== "scan")) return false;',
  '  const cats = ["tarife", "geraete", "internet"].filter(k => (r[k] || []).length).length;',
  '  const priceMissing = ["tarife", "internet"].some(k => (r[k] || []).some(it => !it.am || it.am[0] == null || it.am[1] == null));',
  '  const continuation = !!(previous && previous.internet && previous.internet.length && !r.internet.length && (r.einmalig || r.monatlich));',
  '  return psO2SuspectTotals(r) || priceMissing || continuation || (cats < 2 && !(r.einmalig || r.monatlich));',
  '}',
  'function psO2JoinDetails(oldText, additions) {',
  '  const all = String(oldText || "").split(/\\r?\\n/).map(x => x.trim()).filter(Boolean);',
  '  (additions || []).forEach(x => {',
  '    const detail = psO2Detail(x);',
  '    if (detail && !all.some(y => psO2Similar(y, detail))) all.push(detail);',
  '  });',
  '  return all.slice(0, 12).join("\\n");',
  '}',
  ''
].join(NL);
rep('function psO2CloudShape(d) {', helpers + 'function psO2CloudShape(d) {', 'helpers');
rep("    einmalig: d.einmalig || '', monatlich: d.monatlich || '', hinweis: '',",
  "    einmalig: d.einmalig || '', monatlich: d.monatlich || '', hinweis: ''," + NL +
  "    internetFortsetzung: Array.isArray(d.internetFortsetzung) ? d.internetFortsetzung.filter(x => typeof x === 'string').slice(0, 10) : [],", 'cloud-shape');
rep('              cloudThin = catN < 2 && !(cd.einmalig || cd.monatlich);',
  '              cloudThin = psO2SuspectTotals(cd) || psO2CloudNeedsLocal(cd, stage, dRef.current);' + NL +
  "              if (psO2SuspectTotals(cd)) cd.monatlich = ''; // hohe Einmalsumme ist keine Monatsrate",
  'cloud-fallback');
rep('            else if (lc.length === rc.length && lc.length > 0 && cut(rc, lc)) r[k] = lc;',
  '            else if (lc.length === rc.length && lc.length > 0 && cut(rc, lc)) r[k] = lc;' + NL +
  '            else if (lc.length) r[k] = psO2FillPrices(rc, [{ [k]: rc }, { [k]: lc }], k);',
  'fill-prices');
rep('          if (!r.monatlich && loc.r.monatlich) r.monatlich = loc.r.monatlich;',
  '          if (!r.monatlich && loc.r.monatlich) r.monatlich = loc.r.monatlich;' + NL +
  '          if (!r.internetFortsetzung || !r.internetFortsetzung.length) r.internetFortsetzung = loc.r.internetFortsetzung || [];',
  'copy-continuation');
rep('      setSeen(txt); lastRRef.current = r;',
  "      if (psO2SuspectTotals(r)) r.monatlich = '';" + NL +
  '      const internetContinue = [].concat(r.internetFortsetzung || [], psO2Page2InternetDetails(txt));' + NL +
  '      setSeen(txt); lastRRef.current = r;', 'safe-totals');
rep("        if (!cur[f] || cur[f] === r[f] || stage === 'kosten') { totTake[f] = true; return; }",
  "        if (!cur[f] || cur[f] === r[f] || stage === 'kosten' ||" + NL +
  "            (f === 'monatlich' && cur.einmalig === cur.monatlich &&" + NL +
  "             (psO2Cents(cur.einmalig) || 0) >= 100000 && r.einmalig === cur.einmalig && r.monatlich !== r.einmalig)) { totTake[f] = true; return; }",
  'totals-correction');
rep("        if (r.internet.length) n.internet = merge('internet', p).map(it => it.det !== undefined ? it : conv('internet', it));",
  "        if (r.internet.length) n.internet = merge('internet', p).map(it => it.det !== undefined ? it : conv('internet', it));" + NL +
  '        // Internet@Home-Block von Seite 1: Fortsetzungszeilen von Seite 2 anhängen.' + NL +
  '        if (internetContinue.length && n.internet.length && !r.internet.length) {' + NL +
  '          n.internet = n.internet.slice();' + NL +
  '          const k = n.internet.length - 1, it = n.internet[k];' + NL +
  '          n.internet[k] = { ...it, det: psO2JoinDetails(it.det, internetContinue) };' + NL +
  '        }', 'page-continuation');
const jsStart = s.indexOf('const PS_O2_AMT');
const jsEnd = s.indexOf('// === v55.176 (Beta)', jsStart);
if (jsStart < 0 || jsEnd < 0) throw new Error('OCR scope absent');
new Function(s.slice(jsStart, jsEnd)); // syntax validation
fs.writeFileSync(indexPath, s, 'utf8');
const swPath = path.join(__dirname, '../sw.js');
let sw = fs.readFileSync(swPath, 'utf8');
sw = sw.replace(/const CACHE = "pencil-o2-v\d+";/, 'const CACHE = "pencil-o2-v33";');
fs.writeFileSync(swPath, sw, 'utf8');
console.log('Patched:', changes.join(', '));

// Liest die MagentaTV-Preise (nach den 6 Gratis-Monaten, 24 Monate Laufzeit) von telekom.de und schreibt telekom-tv-preise.json.
// Tarife: Smart, SmartStream, MegaStream. Läuft per GitHub Action täglich. Nur lesen. Erst einfacher Abruf, bei Bedarf mit echtem Browser.
// Bei Fehler/unplausiblen Werten: Abbruch OHNE Änderung, die alte Datei bleibt (Exit 0). Diagnose steht dann in telekom-tv-debug.txt.
import { readFile, writeFile, rm } from 'node:fs/promises';
import { UA, textAusHtml, zahl, heute, mitBrowser, ausschnitte } from './tv-helfer.mjs';

const QUELLEN = [
  'https://www.telekom.de/magenta-tv/tarife-und-optionen/magenta-tv-mit-app',
  'https://www.telekom.de/magenta-tv/tarife-und-optionen/magenta-tv-mit-internet-festnetz',
  'https://www.telekom.de/magenta-tv'
];
const DATEI = new URL('../telekom-tv-preise.json', import.meta.url);
const DEBUG = new URL('../telekom-tv-debug.txt', import.meta.url);
const TARIFE = [
  ['mega', 'MegaStream'],
  ['stream', 'SmartStream'],
  ['smart', 'Smart(?!\\s?Stream)']
];
const GRENZEN = { smart: [5, 20], stream: [8, 35], mega: [15, 60] };

// "MAGENTA TV MegaStream … 0 € mtl. ab dem 7. Monat 30 € mtl. …" -> { mega: 30, … }
export function preiseAusText(text) {
  const t = String(text || '').replace(/(\d)\s+,(\d{2})/g, '$1,$2');
  const preise = {};
  for (const [id, name] of TARIFE) {
    const re = new RegExp('MAGENTA\\s?TV\\s+' + name + '(?![A-Za-z])', 'gi');
    let m;
    while ((m = re.exec(t)) && preise[id] === undefined) {
      const start = m.index + m[0].length;
      const rest = t.slice(start, start + 700);
      const naechster = rest.search(/MAGENTA\s?TV/i);
      const abschnitt = naechster >= 0 ? rest.slice(0, naechster) : rest;
      const p = /ab dem 7\.?\s*Monat\s+(\d{1,2}(?:,\d{2})?)\s*€/i.exec(abschnitt);
      if (p) preise[id] = zahl(p[1]);
    }
  }
  return preise;
}

export function plausibel(p) {
  if (!p) return false;
  for (const k of Object.keys(GRENZEN)) {
    if (typeof p[k] !== 'number' || !isFinite(p[k]) || p[k] < GRENZEN[k][0] || p[k] > GRENZEN[k][1]) return false;
  }
  return p.smart < p.stream && p.stream < p.mega;
}

async function lesen(quelle, diag) {
  let p = null;
  try {
    const r = await fetch(quelle, { headers: { 'User-Agent': UA, 'Accept-Language': 'de-DE,de;q=0.9' } });
    const html = await r.text();
    console.log(quelle, '-> HTTP', r.status, 'Länge', html.length);
    diag.push(quelle + ' | einfacher Abruf: HTTP ' + r.status + ', ' + html.length + ' Zeichen');
    if (r.status === 200) {
      p = preiseAusText(textAusHtml(html, false));
      if (!plausibel(p)) p = preiseAusText(textAusHtml(html, true));
    }
  } catch (e) {
    console.log('nicht erreichbar:', quelle, e.message);
    diag.push(quelle + ' | einfacher Abruf fehlgeschlagen: ' + e.message);
  }
  if (!plausibel(p)) {
    const render = await mitBrowser(quelle);
    if (render) {
      p = preiseAusText(render.text);
      if (!plausibel(p)) p = preiseAusText(textAusHtml(render.html, false));
      diag.push(quelle + ' | Browser: ' + render.text.length + ' Zeichen');
      if (!plausibel(p)) diag.push('  Gelesen: ' + JSON.stringify(p), ...ausschnitte(render.text, 'MAGENTA\\s?TV (?:Mega|Smart)', 6, 200), '  Seitenanfang: ' + render.text.slice(0, 300));
    }
  }
  return p;
}

async function main() {
  const alt = JSON.parse(await readFile(DATEI, 'utf8'));
  const diag = [];
  let treffer = null;
  for (const q of QUELLEN) {
    const p = await lesen(q, diag);
    console.log('Gelesen:', JSON.stringify(p));
    if (plausibel(p)) {
      treffer = { quelle: q, p };
      break;
    }
  }
  if (!treffer) {
    console.log('Preise nicht lesbar oder unplausibel – Datei bleibt unverändert. Diagnose: telekom-tv-debug.txt');
    await writeFile(DEBUG, diag.join('\n') + '\n');
    return;
  }
  await rm(DEBUG, { force: true });
  const neu = JSON.parse(JSON.stringify(alt));
  neu.preise = neu.preise || {};
  let geaendert = false;
  for (const k of ['smart', 'stream', 'mega']) {
    if (neu.preise[k] !== treffer.p[k]) geaendert = true;
    neu.preise[k] = treffer.p[k];
  }
  neu.quelle = treffer.quelle;
  neu.geprueft = heute();
  delete neu.hinweis;
  if (geaendert) neu.geaendertAm = heute();
  await writeFile(DATEI, JSON.stringify(neu, null, 2) + '\n');
  console.log(geaendert ? 'Preise geändert.' : 'Preise unverändert, Prüfdatum aktualisiert.');
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href) main();

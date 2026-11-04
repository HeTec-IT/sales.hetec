// Liest die Giga-TV-Preise von vodafone.de und schreibt vodafone-tv-preise.json.
// Gelesen wird: "… kostet die ersten 6 Monate 9,99 €, danach 14,99 € pro Monat" (GigaTV Home) und der Netflix-Angebotspreis für Vodafone-Kunden.
// Läuft per GitHub Action täglich. Nur lesen. Erst einfacher Abruf, bei Bedarf mit echtem Browser.
// Bei Fehler/unplausiblen Werten: Abbruch OHNE Änderung, die alte Datei bleibt (Exit 0). Diagnose steht dann in vodafone-tv-debug.txt.
import { readFile, writeFile, rm } from 'node:fs/promises';
import { UA, textAusHtml, zahl, heute, mitBrowser, ausschnitte } from './tv-helfer.mjs';

const QUELLEN = ['https://www.vodafone.de/privat/fernsehen.html'];
const DATEI = new URL('../vodafone-tv-preise.json', import.meta.url);
const DEBUG = new URL('../vodafone-tv-debug.txt', import.meta.url);

export function preiseAusText(text) {
  const t = String(text || '').replace(/(\d)\s+,(\d{2})/g, '$1,$2');
  const g = /kostet\s+die\s+ersten\s+(\d{1,2})\s+Monate\s+(\d{1,2},\d{2})\s?(?:€|EUR),?\s+danach\s+(\d{1,2},\d{2})\s?(?:€|EUR)/i.exec(t);
  const n = /Angebotspreis\s+(?:Ab\s+)?(\d{1,2},\d{2})\s?(?:€|EUR)/i.exec(t);
  if (!g) return null;
  const p = { monate: Number(g[1]), s: zahl(g[2]), m: zahl(g[3]) };
  if (n) p.netflix = zahl(n[1]);
  return p;
}

export function plausibel(p) {
  if (!p) return false;
  const ok = (x, a, b) => typeof x === 'number' && isFinite(x) && x >= a && x <= b;
  return ok(p.s, 3, 20) && ok(p.m, 5, 30) && p.s < p.m && ok(p.monate, 1, 24) && (p.netflix === undefined || ok(p.netflix, 2, 12));
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
      // Die FAQ-Antworten stehen oft nur im HTML, nicht im sichtbaren Text
      p = preiseAusText(render.text);
      if (!plausibel(p)) p = preiseAusText(textAusHtml(render.html, false));
      diag.push(quelle + ' | Browser: ' + render.text.length + ' Zeichen');
      if (!plausibel(p)) diag.push('  Gelesen: ' + JSON.stringify(p), ...ausschnitte(render.text, 'ersten \\d+ Monate|Angebotspreis', 4, 200), '  Seitenanfang: ' + render.text.slice(0, 300));
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
    console.log('Preise nicht lesbar oder unplausibel – Datei bleibt unverändert. Diagnose: vodafone-tv-debug.txt');
    await writeFile(DEBUG, diag.join('\n') + '\n');
    return;
  }
  await rm(DEBUG, { force: true });
  const neu = JSON.parse(JSON.stringify(alt));
  neu.preise = neu.preise || {};
  const w = treffer.p;
  const vorher = JSON.stringify(neu.preise);
  neu.preise.s = w.s;
  neu.preise.m = w.m;
  neu.preise.monate = w.monate;
  if (w.netflix !== undefined) neu.preise.netflix = w.netflix;
  neu.quelle = treffer.quelle;
  neu.geprueft = heute();
  delete neu.hinweis;
  if (JSON.stringify(neu.preise) !== vorher) neu.geaendertAm = heute();
  await writeFile(DATEI, JSON.stringify(neu, null, 2) + '\n');
  console.log(JSON.stringify(neu.preise) !== vorher ? 'Preise geändert.' : 'Preise unverändert, Prüfdatum aktualisiert.');
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href) main();

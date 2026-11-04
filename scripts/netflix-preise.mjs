// Liest die Netflix-Preise für Deutschland von der Netflix-Hilfeseite und schreibt netflix-preise.json.
// Läuft per GitHub Action täglich. Nur lesen, ein Seitenaufruf pro Lauf.
// Bei Fehler/unplausiblen Werten: Abbruch OHNE Änderung, die alte Datei bleibt (Exit 0, Hinweis im Log).
import { readFile, writeFile } from 'node:fs/promises';

const QUELLE = 'https://help.netflix.com/de/node/24926';
const DATEI = new URL('../netflix-preise.json', import.meta.url);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const GRENZEN = { werbung: [3, 12], standard: [8, 25], premium: [12, 35] };

const zahl = s => Number(String(s).replace(/\./g, '').replace(',', '.'));

// "Standard mit Werbung ... 6,99 €" -> 6.99 ; sucht den ersten Preis kurz hinter dem Tarifnamen
export function preiseAusText(text) {
  const t = String(text || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;| /g, ' ').replace(/&euro;/g, '€').replace(/\s+/g, ' ');
  const nach = (re) => {
    let m;
    const r = new RegExp(re, 'gi');
    while ((m = r.exec(t))) {
      const stueck = t.slice(m.index + m[0].length, m.index + m[0].length + 140);
      const p = /(\d{1,2}(?:,\d{2}))\s?(?:€|EUR)/.exec(stueck);
      if (p) return zahl(p[1]);
    }
    return null;
  };
  return {
    werbung: nach('Standard mit Werbung'),
    standard: nach('Standard(?! mit Werbung)'),
    premium: nach('Premium')
  };
}

export function plausibel(p) {
  if (!p) return false;
  for (const k of Object.keys(GRENZEN)) {
    if (typeof p[k] !== 'number' || !isFinite(p[k]) || p[k] < GRENZEN[k][0] || p[k] > GRENZEN[k][1]) return false;
  }
  return p.werbung < p.standard && p.standard < p.premium;
}

const heute = () => new Date().toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin' });

async function main() {
  const alt = JSON.parse(await readFile(DATEI, 'utf8'));
  let html = '';
  try {
    const r = await fetch(QUELLE, { headers: { 'User-Agent': UA, 'Accept-Language': 'de-DE,de;q=0.9' } });
    html = await r.text();
    console.log('HTTP', r.status, 'Länge', html.length);
  } catch (e) {
    console.log('Netflix-Seite nicht erreichbar:', e.message);
    return;
  }
  const p = preiseAusText(html);
  console.log('Gelesen:', JSON.stringify(p));
  if (!plausibel(p)) {
    console.log('Preise nicht lesbar oder unplausibel – Datei bleibt unverändert.');
    return;
  }
  const neu = JSON.parse(JSON.stringify(alt));
  const preise = { werbung: p.werbung, standard: p.standard, premium: p.premium };
  let geaendert = false;
  for (const t of neu.tarife) {
    if (preise[t.id] !== undefined && t.preis !== preise[t.id]) { t.preis = preise[t.id]; geaendert = true; }
  }
  neu.geprueft = heute();
  delete neu.hinweis;
  if (geaendert) neu.geaendertAm = heute();
  await writeFile(DATEI, JSON.stringify(neu, null, 2) + '\n');
  console.log(geaendert ? 'Preise geändert.' : 'Preise unverändert, Prüfdatum aktualisiert.');
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href) main();

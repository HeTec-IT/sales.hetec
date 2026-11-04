// Liest die Giga-TV-Preise von vodafone.de und schreibt vodafone-tv-preise.json.
// Gelesen wird:
//  - Home: "… kostet die ersten 6 Monate 9,99 €, danach 14,99 € pro Monat" (fernsehen.html) bzw. "Pro Monat 9,99 € … Ab dem 7. Monat 14,99 €" (giga-tv.html)
//  - Vodafone Premium: "20 HD-Sender ohne Werbung für 5 € pro Monat" und Internet-Rabatt "Dann sparst Du 5 € pro Monat" (giga-tv.html)
//  - Netflix über Vodafone (Angebotspreise Mit Werbung / Standard / Premium, streaming-angebote.html – nur im gerenderten Text, der einfache Abruf zeigt dort falsche Preise)
// Läuft per GitHub Action täglich. Nur lesen. Erst einfacher Abruf, bei Bedarf mit echtem Browser.
// Bei Fehler/unplausiblen Werten: Abbruch OHNE Änderung, die alte Datei bleibt (Exit 0). Diagnose steht dann in vodafone-tv-debug.txt.
import { readFile, writeFile, rm } from 'node:fs/promises';
import { UA, textAusHtml, zahl, heute, mitBrowser, ausschnitte } from './tv-helfer.mjs';

const QUELLEN = ['https://www.vodafone.de/privat/fernsehen.html', 'https://www.vodafone.de/privat/fernsehen/giga-tv.html'];
const Q_GIGA = 'https://www.vodafone.de/privat/fernsehen/giga-tv.html';
const Q_NETFLIX = 'https://www.vodafone.de/privat/fernsehen/streaming-angebote.html';
const DATEI = new URL('../vodafone-tv-preise.json', import.meta.url);
const DEBUG = new URL('../vodafone-tv-debug.txt', import.meta.url);
const EUR = '\\s?(?:€|EUR)';
const norm = t => String(t || '').replace(/(\d)\s+,(\d{2})/g, '$1,$2');
const ok = (x, a, b) => typeof x === 'number' && isFinite(x) && x >= a && x <= b;

// Home-Preise: Phase 1 (s), danach (m), Anzahl Monate Phase 1
export function preiseAusText(text) {
  const t = norm(text);
  const g = new RegExp('kostet\\s+die\\s+ersten\\s+(\\d{1,2})\\s+Monate\\s+(\\d{1,2},\\d{2})' + EUR + ',?\\s+danach\\s+(\\d{1,2},\\d{2})' + EUR, 'i').exec(t);
  if (g) {
    const p = { monate: Number(g[1]), s: zahl(g[2]), m: zahl(g[3]) };
    const n = new RegExp('Angebotspreis\\s+(?:Ab\\s+)?(\\d{1,2},\\d{2})' + EUR, 'i').exec(t);
    if (n) p.netflix = zahl(n[1]);
    return p;
  }
  const h = new RegExp('Pro\\s+Monat[^A-Za-z]{0,30}?(\\d{1,2},\\d{2})' + EUR + '[^A-Za-z]{0,40}?Ab\\s+dem\\s+(\\d{1,2})\\.\\s+Monat\\s+(\\d{1,2},\\d{2})' + EUR, 'i').exec(t);
  if (h) return { monate: Number(h[2]) - 1, s: zahl(h[1]), m: zahl(h[3]) };
  return null;
}

export function plausibel(p) {
  if (!p) return false;
  return ok(p.s, 3, 20) && ok(p.m, 5, 30) && p.s < p.m && ok(p.monate, 1, 24) && (p.netflix === undefined || ok(p.netflix, 2, 12));
}

// Vodafone Premium (zusätzlich zu Home) und Rabatt bei Vodafone-Internet
export function zusatzAusText(text) {
  const t = norm(text);
  const out = {};
  const p = new RegExp('20\\s+HD-Sender\\s+ohne\\s+Werbung\\s+f(?:ü|&uuml;|ue)r\\s+(\\d{1,2}(?:,\\d{2})?)' + EUR, 'i').exec(t);
  if (p) out.premium = zahl(p[1]);
  const r = new RegExp('Hast\\s+Du\\s+Internet\\s+von\\s+uns\\?[^€]{0,40}?Dann\\s+sparst\\s+Du\\s+(\\d{1,2}(?:,\\d{2})?)' + EUR, 'i').exec(t);
  if (r) out.internetRabatt = zahl(r[1]);
  return out;
}

export function zusatzPlausibel(z) {
  return !!z && (z.premium === undefined || ok(z.premium, 1, 20)) && (z.internetRabatt === undefined || ok(z.internetRabatt, 1, 20)) && z.premium !== undefined;
}

// Netflix über Vodafone: "Standardpreis 6,99 € – Angebotspreis 4,99 € pro Monat" für Mit Werbung, Standard, Premium (in dieser Reihenfolge)
export function netflixAusText(text) {
  const t = norm(text);
  const re = new RegExp('Standardpreis\\s+(\\d{1,2},\\d{2})' + EUR + '\\s*[–-]\\s*Angebotspreis\\s+(\\d{1,2},\\d{2})' + EUR, 'gi');
  const f = [];
  let m;
  while ((m = re.exec(t)) && f.length < 3) f.push({ normal: zahl(m[1]), angebot: zahl(m[2]) });
  if (f.length < 3) return null;
  return { normal: { werbung: f[0].normal, standard: f[1].normal, premium: f[2].normal }, preise: { werbung: f[0].angebot, standard: f[1].angebot, premium: f[2].angebot } };
}

export function netflixPlausibel(n) {
  if (!n) return false;
  const a = n.preise;
  const b = n.normal;
  return ok(a.werbung, 2, 12) && ok(a.standard, 6, 25) && ok(a.premium, 9, 35) && a.werbung < a.standard && a.standard < a.premium
    && ['werbung', 'standard', 'premium'].every(k => ok(b[k] - a[k], 1, 4));
}

async function abruf(quelle, diag) {
  try {
    const r = await fetch(quelle, { headers: { 'User-Agent': UA, 'Accept-Language': 'de-DE,de;q=0.9' } });
    const html = await r.text();
    console.log(quelle, '-> HTTP', r.status, 'Länge', html.length);
    diag.push(quelle + ' | einfacher Abruf: HTTP ' + r.status + ', ' + html.length + ' Zeichen');
    return r.status === 200 ? html : null;
  } catch (e) {
    console.log('nicht erreichbar:', quelle, e.message);
    diag.push(quelle + ' | einfacher Abruf fehlgeschlagen: ' + e.message);
    return null;
  }
}

// Seite lesen: erst einfacher Abruf, sonst/zusätzlich echter Browser. 'lese' bekommt Text und liefert Ergebnis oder null; 'gut' prüft es.
async function lesen(quelle, diag, lese, gut, suche, nurBrowser) {
  let p = null;
  if (!nurBrowser) {
    const html = await abruf(quelle, diag);
    if (html) {
      p = lese(textAusHtml(html, false));
      if (!gut(p)) p = lese(textAusHtml(html, true));
    }
  }
  if (!gut(p)) {
    const render = await mitBrowser(quelle);
    if (render) {
      p = lese(render.text);
      if (!gut(p) && !nurBrowser) p = lese(textAusHtml(render.html, false));
      diag.push(quelle + ' | Browser: ' + render.text.length + ' Zeichen');
      if (!gut(p)) diag.push('  Gelesen: ' + JSON.stringify(p), ...ausschnitte(render.text, suche, 4, 200), '  Seitenanfang: ' + render.text.slice(0, 300));
    }
  }
  return gut(p) ? p : null;
}

async function main() {
  const alt = JSON.parse(await readFile(DATEI, 'utf8'));
  const diag = [];
  let treffer = null;
  for (const q of QUELLEN) {
    const p = await lesen(q, diag, preiseAusText, plausibel, 'ersten \\d+ Monate|Ab dem \\d+\\. Monat', false);
    console.log('Gelesen:', JSON.stringify(p));
    if (p) {
      treffer = { quelle: q, p };
      break;
    }
  }
  if (!treffer) {
    console.log('Preise nicht lesbar oder unplausibel – Datei bleibt unverändert. Diagnose: vodafone-tv-debug.txt');
    await writeFile(DEBUG, diag.join('\n') + '\n');
    return;
  }
  // Zusätze (Premium, Internet-Rabatt, Netflix über Vodafone): fehlen sie, bleiben die bisherigen Werte stehen
  const zusatz = await lesen(Q_GIGA, diag, zusatzAusText, zusatzPlausibel, 'Vodafone Premium|20 HD-Sender|Hast Du Internet', false);
  console.log('Zusatz:', JSON.stringify(zusatz));
  let nf = await lesen(Q_NETFLIX, diag, netflixAusText, netflixPlausibel, 'Standardpreis|Angebotspreis', true);
  // Gegenprobe: Die Normalpreise müssen zu netflix-preise.json passen (schützt vor falsch gelesenen Preisen)
  if (nf) {
    try {
      const nfj = JSON.parse(await readFile(new URL('../netflix-preise.json', import.meta.url), 'utf8'));
      const ref = Object.fromEntries((nfj.tarife || []).map(t => [t.id, t.preis]));
      const abw = ['werbung', 'standard', 'premium'].filter(k => typeof ref[k] === 'number' && Math.abs(ref[k] - nf.normal[k]) > 0.005);
      if (abw.length) {
        diag.push('Netflix über Vodafone verworfen: Normalpreis weicht von netflix-preise.json ab (' + abw.join(', ') + ')');
        nf = null;
      }
    } catch (_) {}
  }
  console.log('Netflix über Vodafone:', JSON.stringify(nf));
  if (!zusatz || !nf) await writeFile(DEBUG, diag.join('\n') + '\n');
  else await rm(DEBUG, { force: true });

  const neu = JSON.parse(JSON.stringify(alt));
  neu.preise = neu.preise || {};
  const w = treffer.p;
  const vorher = JSON.stringify(neu.preise);
  neu.preise.s = w.s;
  neu.preise.m = w.m;
  neu.preise.monate = w.monate;
  if (zusatz && zusatz.premium !== undefined) neu.preise.premium = zusatz.premium;
  if (zusatz && zusatz.internetRabatt !== undefined) neu.preise.internetRabatt = zusatz.internetRabatt;
  if (nf) {
    neu.preise.netflixPreise = nf.preise;
    neu.preise.netflix = nf.preise.werbung;
  } else if (w.netflix !== undefined && !neu.preise.netflixPreise) neu.preise.netflix = w.netflix;
  neu.quelle = treffer.quelle;
  neu.geprueft = heute();
  delete neu.hinweis;
  if (JSON.stringify(neu.preise) !== vorher) neu.geaendertAm = heute();
  await writeFile(DATEI, JSON.stringify(neu, null, 2) + '\n');
  console.log(JSON.stringify(neu.preise) !== vorher ? 'Preise geändert.' : 'Preise unverändert, Prüfdatum aktualisiert.');
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href) main();

// Liest die Disney+-Preise für Deutschland (Regelpreise pro Monat) und schreibt disney-preise.json.
// Läuft per GitHub Action täglich. Nur lesen. Erst einfacher Abruf, bei Bedarf mit echtem Browser.
// Bei Fehler/unplausiblen Werten: Abbruch OHNE Änderung, die alte Datei bleibt (Exit 0). Diagnose steht dann in disney-debug.txt.
import { readFile, writeFile, rm } from 'node:fs/promises';

const QUELLEN = [
  'https://www.disneyplus.com/de-de',
  'https://www.disneyplus.com/de-de/subscribe',
  'https://help.disneyplus.com/de/article/disneyplus-price'
];
const DATEI = new URL('../disney-preise.json', import.meta.url);
const DEBUG = new URL('../disney-debug.txt', import.meta.url);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const GRENZEN = { werbung: [3, 12], standard: [6, 20], premium: [9, 28] };

const zahl = s => Number(String(s).replace(/\./g, '').replace(',', '.'));

export function textAusHtml(html, mitSkripten) {
  let t = String(html || '');
  if (!mitSkripten) t = t.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  return t
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\\u20ac|\\u20AC|&euro;|&#8364;/g, '€')
    .replace(/\\u00a0|&nbsp;|&#160;| /g, ' ')
    .replace(/\\"/g, '"')
    .replace(/\s+/g, ' ');
}

// Preise im Textstück: bei "Sparpreis ... danach X" gilt der höchste Preis (= Regelpreis)
const hoechsterPreis = stueck => {
  const re = /(\d{1,2},\d{2})\s?(?:€|EUR)/g;
  let m;
  let max = null;
  while ((m = re.exec(stueck))) {
    const v = zahl(m[1]);
    if (max === null || v > max) max = v;
  }
  return max;
};

// Die Seite nennt die Pakete in wechselnder Reihenfolge (Karten: Premium, Standard, Standard mit Werbung; Fußnoten anders).
// Darum: jeden Tarifnamen finden, das Textstück bis zum nächsten Tarifnamen lesen und per Mehrheit abstimmen.
// Bei "Sparpreis ... danach X" zählt X (= Regelpreis) dreifach, sonst der höchste Preis im Stück.
export function preiseAusText(html, mitSkripten = false) {
  const t = textAusHtml(html, mitSkripten);
  const marken = [];
  const sammle = (art, re) => {
    let m;
    const r = new RegExp(re, 'gi');
    while ((m = r.exec(t))) marken.push({ art, pos: m.index, ende: m.index + m[0].length });
  };
  sammle('werbung', 'Standard\\s+mit\\s+Werbung');
  sammle('standard', 'Standard(?!\\s+mit\\s+Werbung)');
  sammle('premium', 'Premium');
  marken.sort((x, y) => x.pos - y.pos);
  const stimmen = { werbung: new Map(), standard: new Map(), premium: new Map() };
  marken.forEach((m, i) => {
    const bis = Math.min(i + 1 < marken.length ? marken[i + 1].pos : t.length, m.ende + 260);
    const stueck = t.slice(m.ende, bis);
    const danach = /danach\s+(\d{1,2},\d{2})\s?(?:€|EUR)/i.exec(stueck);
    const wert = danach ? zahl(danach[1]) : hoechsterPreis(stueck);
    if (wert === null) return;
    stimmen[m.art].set(wert, (stimmen[m.art].get(wert) || 0) + (danach ? 3 : 1));
  });
  const sieger = map => {
    let best = null;
    for (const [wert, n] of map) if (!best || n > best.n || (n === best.n && wert > best.wert)) best = { wert, n };
    return best ? best.wert : null;
  };
  return { werbung: sieger(stimmen.werbung), standard: sieger(stimmen.standard), premium: sieger(stimmen.premium) };
}

export function plausibel(p) {
  if (!p) return false;
  for (const k of Object.keys(GRENZEN)) {
    if (typeof p[k] !== 'number' || !isFinite(p[k]) || p[k] < GRENZEN[k][0] || p[k] > GRENZEN[k][1]) return false;
  }
  return p.werbung < p.standard && p.standard < p.premium;
}

const heute = () => new Date().toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', year: 'numeric' });

function ausschnitte(text, re, n = 12, rand = 110) {
  const out = [];
  let m;
  const r = new RegExp(re, 'gi');
  while ((m = r.exec(text)) && out.length < n) out.push('…' + text.slice(Math.max(0, m.index - rand), m.index + rand) + '…');
  return out;
}

async function mitBrowser(quelle) {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch (e) {
    console.log('Playwright nicht installiert:', e.message);
    return null;
  }
  const br = await chromium.launch();
  try {
    const page = await (await br.newContext({ userAgent: UA, locale: 'de-DE' })).newPage();
    // Disney+ lädt dauerhaft nach -> nicht auf "networkidle" warten
    await page.goto(quelle, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(9000);
    return { text: await page.evaluate(() => document.body.innerText), html: await page.content() };
  } catch (e) {
    console.log('Browser-Abruf fehlgeschlagen:', e.message);
    return null;
  } finally {
    await br.close();
  }
}

async function lesen(quelle, diag) {
  let p = null;
  try {
    const r = await fetch(quelle, { headers: { 'User-Agent': UA, 'Accept-Language': 'de-DE,de;q=0.9' } });
    const html = await r.text();
    console.log(quelle, '-> HTTP', r.status, 'Länge', html.length);
    diag.push(quelle + ' | einfacher Abruf: HTTP ' + r.status + ', ' + html.length + ' Zeichen');
    p = preiseAusText(html, false);
    if (!plausibel(p)) p = preiseAusText(html, true);
    if (!plausibel(p)) {
      const roh = textAusHtml(html, true);
      diag.push('  Einfacher Abruf, Gelesen: ' + JSON.stringify(p), '  Stellen mit Euro:', ...ausschnitte(roh, '[0-9],[0-9]{2}\\s?(?:€|EUR)', 8), '  Stellen mit "mit Werbung":', ...ausschnitte(roh, 'mit Werbung', 4));
    }
  } catch (e) {
    console.log('nicht erreichbar:', quelle, e.message);
    diag.push(quelle + ' | einfacher Abruf fehlgeschlagen: ' + e.message);
  }
  if (!plausibel(p)) {
    const render = await mitBrowser(quelle);
    if (render) {
      p = preiseAusText(render.text, false);
      if (!plausibel(p)) p = preiseAusText(render.html, true);
      const txt = render.text.replace(/\s+/g, ' ');
      diag.push(quelle + ' | Browser: ' + txt.length + ' Zeichen');
      if (!plausibel(p)) {
        diag.push('  Gelesen: ' + JSON.stringify(p), ...ausschnitte(txt, '€|EUR\\b', 8), '  Seitenanfang: ' + txt.slice(0, 500));
      }
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
    console.log('Preise nicht lesbar oder unplausibel – Datei bleibt unverändert. Diagnose: disney-debug.txt');
    await writeFile(DEBUG, diag.join('\n') + '\n');
    return;
  }
  await rm(DEBUG, { force: true });
  const neu = JSON.parse(JSON.stringify(alt));
  let geaendert = false;
  for (const t of neu.tarife) {
    if (treffer.p[t.id] !== undefined && t.preis !== treffer.p[t.id]) {
      t.preis = treffer.p[t.id];
      geaendert = true;
    }
  }
  neu.quelle = treffer.quelle;
  neu.geprueft = heute();
  delete neu.hinweis;
  if (geaendert) neu.geaendertAm = heute();
  await writeFile(DATEI, JSON.stringify(neu, null, 2) + '\n');
  console.log(geaendert ? 'Preise geändert.' : 'Preise unverändert, Prüfdatum aktualisiert.');
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href) main();

// Liest die Netflix-Preise für Deutschland von der Netflix-Hilfeseite und schreibt netflix-preise.json.
// Läuft per GitHub Action täglich. Nur lesen, ein Seitenaufruf pro Lauf (erst einfach, bei Bedarf mit echtem Browser).
// Bei Fehler/unplausiblen Werten: Abbruch OHNE Änderung, die alte Datei bleibt (Exit 0). Diagnose steht dann in netflix-debug.txt.
import { readFile, writeFile, rm } from 'node:fs/promises';

// Die Hilfeseite zeigt je nach Standort des Servers das Land (Runner = USA). Mit Ländercode am Ende gibt es die deutschen Preise.
const QUELLEN = [
  'https://help.netflix.com/de/node/24926/de',
  'https://help.netflix.com/en/node/24926/de',
  'https://help.netflix.com/de/node/24926?country=DE'
];
const DATEI = new URL('../netflix-preise.json', import.meta.url);
const DEBUG = new URL('../netflix-debug.txt', import.meta.url);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const GRENZEN = { werbung: [3, 12], standard: [8, 25], premium: [12, 35] };

const zahl = s => Number(String(s).replace(/\./g, '').replace(',', '.'));

// HTML -> reiner Text (optional mit dem Inhalt der Skripte, falls die Preise dort als JSON stehen)
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

// "Standard mit Werbung ... 6,99 €" -> 6.99 ; sucht den ersten Preis kurz hinter dem Tarifnamen
export function preiseAusText(html, mitSkripten = false) {
  const t = textAusHtml(html, mitSkripten);
  const nach = re => {
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
    werbung: nach('Standard(?:-Abo)?\\s+(?:mit Werbung|with ads)'),
    standard: nach('Standard-Abo(?!\\s+mit Werbung)|Standard(?!-Abo)(?!\\s+mit Werbung)(?!\\s+with ads)'),
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
    await page.goto(quelle, { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(3000);
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
  let html = '';
  let render = null;
  try {
    const r = await fetch(quelle, { headers: { 'User-Agent': UA, 'Accept-Language': 'de-DE,de;q=0.9' } });
    html = await r.text();
    console.log(quelle, '-> HTTP', r.status, 'Länge', html.length);
    diag.push(quelle + ' | einfacher Abruf: HTTP ' + r.status + ', ' + html.length + ' Zeichen');
    p = preiseAusText(html, false);
    if (!plausibel(p)) p = preiseAusText(html, true);
  } catch (e) {
    console.log('nicht erreichbar:', quelle, e.message);
    diag.push(quelle + ' | einfacher Abruf fehlgeschlagen: ' + e.message);
  }
  if (!plausibel(p)) {
    render = await mitBrowser(quelle);
    if (render) {
      p = preiseAusText(render.text, false);
      if (!plausibel(p)) p = preiseAusText(render.html, true);
      const txt = render.text.replace(/\s+/g, ' ');
      diag.push(quelle + ' | Browser: ' + txt.length + ' Zeichen, Land-Hinweis: ' + (/Die derzeit angezeigten Informationen beziehen sich auf: ([^.]{0,40})/.exec(txt) || [])[1]);
      if (!plausibel(p)) {
        diag.push('  Gelesen: ' + JSON.stringify(p), ...ausschnitte(txt, '€|EUR\\b', 8), '  Seitenanfang: ' + txt.slice(0, 400));
      }
    }
  }
  return { p, html, render };
}

async function main() {
  const alt = JSON.parse(await readFile(DATEI, 'utf8'));
  const diag = [];
  let treffer = null;
  for (const q of QUELLEN) {
    const r = await lesen(q, diag);
    console.log('Gelesen:', JSON.stringify(r.p));
    if (plausibel(r.p)) {
      treffer = { quelle: q, p: r.p };
      break;
    }
  }
  if (!treffer) {
    console.log('Preise nicht lesbar oder unplausibel – Datei bleibt unverändert. Diagnose: netflix-debug.txt');
    await writeFile(DEBUG, diag.join('\n') + '\n');
    return;
  }
  const p = treffer.p;
  await rm(DEBUG, { force: true });
  const neu = JSON.parse(JSON.stringify(alt));
  const preise = { werbung: p.werbung, standard: p.standard, premium: p.premium };
  let geaendert = false;
  for (const t of neu.tarife) {
    if (preise[t.id] !== undefined && t.preis !== preise[t.id]) {
      t.preis = preise[t.id];
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

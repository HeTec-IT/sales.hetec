// Liest die Netflix-Preise für Deutschland von der Netflix-Hilfeseite und schreibt netflix-preise.json.
// Läuft per GitHub Action täglich. Nur lesen, ein Seitenaufruf pro Lauf (erst einfach, bei Bedarf mit echtem Browser).
// Bei Fehler/unplausiblen Werten: Abbruch OHNE Änderung, die alte Datei bleibt (Exit 0). Diagnose steht dann in netflix-debug.txt.
import { readFile, writeFile, rm } from 'node:fs/promises';

const QUELLE = 'https://help.netflix.com/de/node/24926';
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

function ausschnitte(text, re, n = 12, rand = 110) {
  const out = [];
  let m;
  const r = new RegExp(re, 'gi');
  while ((m = r.exec(text)) && out.length < n) out.push('…' + text.slice(Math.max(0, m.index - rand), m.index + rand) + '…');
  return out;
}

async function mitBrowser() {
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
    await page.goto(QUELLE, { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(3000);
    return { text: await page.evaluate(() => document.body.innerText), html: await page.content() };
  } catch (e) {
    console.log('Browser-Abruf fehlgeschlagen:', e.message);
    return null;
  } finally {
    await br.close();
  }
}

async function main() {
  const alt = JSON.parse(await readFile(DATEI, 'utf8'));
  const diag = [];
  let p = null;
  let html = '';

  // 1) einfacher Abruf
  try {
    const r = await fetch(QUELLE, { headers: { 'User-Agent': UA, 'Accept-Language': 'de-DE,de;q=0.9' } });
    html = await r.text();
    console.log('HTTP', r.status, 'Länge', html.length);
    diag.push('Einfacher Abruf: HTTP ' + r.status + ', ' + html.length + ' Zeichen');
    p = preiseAusText(html, false);
    if (!plausibel(p)) p = preiseAusText(html, true);
  } catch (e) {
    console.log('Netflix-Seite nicht erreichbar:', e.message);
    diag.push('Einfacher Abruf fehlgeschlagen: ' + e.message);
  }

  // 2) Seite mit echtem Browser rendern
  let render = null;
  if (!plausibel(p)) {
    render = await mitBrowser();
    if (render) {
      p = preiseAusText(render.text, false);
      if (!plausibel(p)) p = preiseAusText(render.html, true);
      diag.push('Browser-Abruf: ' + render.text.length + ' Zeichen Text');
    }
  }
  console.log('Gelesen:', JSON.stringify(p));

  if (!plausibel(p)) {
    console.log('Preise nicht lesbar oder unplausibel – Datei bleibt unverändert. Diagnose: netflix-debug.txt');
    const roh = textAusHtml(html, true);
    const txt = render ? render.text.replace(/\s+/g, ' ') : '';
    diag.push('Gelesen: ' + JSON.stringify(p));
    diag.push('--- Einfacher Abruf: Stellen mit Euro ---', ...ausschnitte(roh, '€|EUR\\b'));
    diag.push('--- Einfacher Abruf: Stellen mit "Standard mit Werbung" ---', ...ausschnitte(roh, 'Standard mit Werbung', 6));
    if (render) {
      diag.push('--- Browser: Stellen mit Euro ---', ...ausschnitte(txt, '€|EUR\\b'));
      diag.push('--- Browser: Seitenanfang ---', txt.slice(0, 800));
    }
    await writeFile(DEBUG, diag.join('\n') + '\n');
    return;
  }

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
  neu.geprueft = heute();
  delete neu.hinweis;
  if (geaendert) neu.geaendertAm = heute();
  await writeFile(DATEI, JSON.stringify(neu, null, 2) + '\n');
  console.log(geaendert ? 'Preise geändert.' : 'Preise unverändert, Prüfdatum aktualisiert.');
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href) main();

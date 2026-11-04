// Liest den Preis für den Kabel-TV-Anschluss (Kabelgebühr pro Monat) von der Vodafone-Seite und schreibt kabel-preise.json.
// Quelle: FAQ "Was kostet TV bei Vodafone pro Monat?" – "Der TV-Anschluss über Kabel kostet in der Regel zwischen X € und Y € pro Monat."
// Es gilt der obere Wert (Y). Läuft per GitHub Action täglich. Nur lesen. Erst einfacher Abruf, bei Bedarf mit echtem Browser.
// Bei Fehler/unplausiblen Werten: Abbruch OHNE Änderung, die alte Datei bleibt (Exit 0). Diagnose steht dann in kabel-debug.txt.
import { readFile, writeFile, rm } from 'node:fs/promises';

const QUELLEN = [
  'https://www.vodafone.de/privat/fernsehen.html',
  'https://www.vodafone.de/privat/fernsehen/kabel-tv.html'
];
const DATEI = new URL('../kabel-preise.json', import.meta.url);
const DEBUG = new URL('../kabel-debug.txt', import.meta.url);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';

const zahl = s => Number(String(s).replace(/\./g, '').replace(',', '.'));

export function textAusHtml(html, mitSkripten) {
  let t = String(html || '');
  if (!mitSkripten) t = t.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  return t
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\\u20ac|\\u20AC|&euro;|&#8364;/g, '€')
    .replace(/\\u00a0|&nbsp;|&#160;| /g, ' ')
    .replace(/\\"/g, '"')
    .replace(/\s+/g, ' ');
}

// "... TV-Anschluss über Kabel kostet in der Regel zwischen 6,99 € und 12,99 € pro Monat" -> { von: 6.99, bis: 12.99 }
export function kabelAusText(html, mitSkripten = false) {
  const t = textAusHtml(html, mitSkripten).replace(/(\d)\s+,(\d{2})/g, '$1,$2');
  const re = /Kabel[^.]{0,80}?kostet[^.]{0,80}?zwischen\s+(\d{1,2},\d{2})\s?(?:€|EUR)\s+und\s+(\d{1,2},\d{2})\s?(?:€|EUR)/i;
  const m = re.exec(t);
  return m ? { von: zahl(m[1]), bis: zahl(m[2]) } : null;
}

export function plausibel(p) {
  return !!p && [p.von, p.bis].every(x => typeof x === 'number' && isFinite(x)) && p.von >= 3 && p.von < p.bis && p.bis <= 30;
}

const heute = () => new Date().toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', year: 'numeric' });

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
    await page.goto(quelle, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(6000);
    // Cookie-Banner wegklicken, falls vorhanden (nur lesen, keine weiteren Aktionen)
    for (const name of ['Alle akzeptieren', 'Akzeptieren', 'Zustimmen']) {
      try { await page.getByRole('button', { name }).first().click({ timeout: 1500 }); break; } catch (_) {}
    }
    // FAQ-Fragen aufklappen, damit der Antworttext im DOM steht
    try { await page.getByText('Was kostet TV bei Vodafone pro Monat?').first().click({ timeout: 3000 }); } catch (_) {}
    await page.waitForTimeout(1500);
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
    p = kabelAusText(html, false);
    if (!plausibel(p)) p = kabelAusText(html, true);
  } catch (e) {
    console.log('nicht erreichbar:', quelle, e.message);
    diag.push(quelle + ' | einfacher Abruf fehlgeschlagen: ' + e.message);
  }
  if (!plausibel(p)) {
    const render = await mitBrowser(quelle);
    if (render) {
      p = kabelAusText(render.text, false);
      if (!plausibel(p)) p = kabelAusText(render.html, true);
      const txt = render.text.replace(/\s+/g, ' ');
      diag.push(quelle + ' | Browser: ' + txt.length + ' Zeichen');
      if (!plausibel(p)) {
        const i = txt.search(/Kabel/i);
        diag.push('  Gelesen: ' + JSON.stringify(p), '  Ausschnitt um "Kabel": ' + (i >= 0 ? txt.slice(Math.max(0, i - 150), i + 350) : '(Wort Kabel nicht gefunden)'), '  Seitenanfang: ' + txt.slice(0, 300));
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
    console.log('Preis nicht lesbar oder unplausibel – Datei bleibt unverändert. Diagnose: kabel-debug.txt');
    await writeFile(DEBUG, diag.join('\n') + '\n');
    return;
  }
  await rm(DEBUG, { force: true });
  const neu = JSON.parse(JSON.stringify(alt));
  const geaendert = neu.preis !== treffer.p.bis || neu.von !== treffer.p.von;
  neu.preis = treffer.p.bis;
  neu.von = treffer.p.von;
  neu.quelle = treffer.quelle;
  neu.geprueft = heute();
  delete neu.hinweis;
  if (geaendert) neu.geaendertAm = heute();
  await writeFile(DATEI, JSON.stringify(neu, null, 2) + '\n');
  console.log(geaendert ? 'Preis geändert.' : 'Preis unverändert, Prüfdatum aktualisiert.');
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href) main();

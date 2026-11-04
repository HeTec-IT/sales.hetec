// Holt die Google-Pixel-Handys (ohne Tarif) aus dem o2 Shop und schreibt pixel-geraete.json.
// Läuft per GitHub Action täglich (ca. 12 Uhr). Die Shop-Seite baut ihre Geräteliste per JavaScript auf,
// darum wird ein echter Browser (Playwright) benutzt. Nur lesen, genau ein Seitenaufruf pro Lauf.
// Bei Fehler/unplausiblen Werten: Abbruch, die alte Datei bleibt. Die Diagnose steht dann in pixel-debug.txt.
import { readFile, writeFile, rm } from 'node:fs/promises';

export const QUELLE = 'https://www.o2online.de/e-shop/google?ohne-tarif=ja&zielgruppe=privatkunden';
const BASIS = 'https://www.o2online.de';
const DATEI = new URL('../pixel-geraete.json', import.meta.url);
const DEBUG = new URL('../pixel-debug.txt', import.meta.url);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';

// Pixel 10 | Pixel 10 Pro | Pixel 10 Pro XL | Pixel 10 Pro Fold | Pixel 10a | Pixel 10 Fold
const MODELL_RE = /Pixel\s+(\d{1,2})(?:\s*(Pro\s*Fold|Pro\s*XL|Pro|XL|Fold|a))?(?![A-Za-z0-9])/i;
const STUFE = { '': 'basis', a: 'a', pro: 'pro', proxl: 'pro-xl', xl: 'pro-xl', fold: 'fold', profold: 'fold' };
const STUFE_NAME = { a: 'a', pro: ' Pro', proxl: ' Pro XL', xl: ' XL', fold: ' Fold', profold: ' Pro Fold' };
const STUFEN_REIHE = ['basis', 'a', 'pro', 'pro-xl', 'fold'];
const PREIS_MIN = 100;
const PREIS_MAX = 2600;

export function modellAusText(text) {
  const m = MODELL_RE.exec(String(text || ''));
  if (!m) return null;
  const gen = Number(m[1]);
  const zus = (m[2] || '').replace(/\s+/g, '').toLowerCase();
  return { gen, stufe: STUFE[zus], modell: `Pixel ${gen}${STUFE_NAME[zus] || ''}` };
}

export function speicherAusText(text) {
  const re = /(\d{2,4})\s?(GB|TB)(?!\s*RAM)/gi;
  let m;
  while ((m = re.exec(String(text || '')))) {
    const gb = m[2].toUpperCase() === 'TB' ? Number(m[1]) * 1024 : Number(m[1]);
    if (gb >= 64) return { speicher: `${m[1]} ${m[2].toUpperCase()}`, speicherGb: gb };
  }
  return null;
}

// "1.099,00 €" -> 1099 ; Raten ("29,99 € mtl.") werden ausgelassen
export function preiseAusText(text) {
  const re = /(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{2}))?\s*€(\s*\*{0,3}\s*(?:mtl\.?|monatlich|\/\s*Monat|pro\s+Monat))?/gi;
  const out = [];
  let m;
  while ((m = re.exec(String(text || '')))) {
    if (m[3]) continue;
    const wert = Number(`${m[1].replace(/\./g, '')}.${m[2] || '00'}`);
    if (wert >= PREIS_MIN && wert <= PREIS_MAX) out.push(wert);
  }
  return out;
}

function absolut(u) {
  if (!u || typeof u !== 'string') return '';
  if (/^https?:\/\//i.test(u)) return u;
  if (u.startsWith('//')) return 'https:' + u;
  if (u.startsWith('/')) return BASIS + u;
  return '';
}

function bauen(modell, extra) {
  return {
    name: `Google ${modell.modell}`,
    modell: modell.modell,
    gen: modell.gen,
    stufe: modell.stufe,
    speicher: extra.speicher || '',
    speicherGb: extra.speicherGb || 0,
    preis: extra.preis || 0,
    url: extra.url || '',
    bild: extra.bild || '',
  };
}

// Eine Kachel aus dem sichtbaren Seitentext (Name + Preis + Speicher)
export function kandidatAusKartentext(text, url = '', bild = '') {
  const modell = modellAusText(text);
  if (!modell) return null;
  const preise = preiseAusText(text);
  if (!preise.length) return null;
  return bauen(modell, { ...(speicherAusText(text) || {}), preis: Math.min(...preise), url: absolut(url), bild: absolut(bild) });
}

// Fallback: den ganzen Seitentext in Abschnitte je "Pixel NN" zerlegen
export function kandidatenAusSeitentext(text) {
  const t = String(text || '').replace(/\s+/g, ' ');
  const re = /Google\s+Pixel\s+\d/gi;
  const starts = [];
  let m;
  while ((m = re.exec(t))) starts.push(m.index);
  const out = [];
  starts.forEach((s, i) => {
    const ende = Math.min(starts[i + 1] ?? t.length, s + 320);
    const k = kandidatAusKartentext(t.slice(s, ende));
    if (k) out.push(k);
  });
  return out;
}

// JSON-Antworten der Shop-Seite: jedes Objekt mit "Pixel NN" im Text und einem plausiblen Preis
export function kandidatenAusJson(wurzel) {
  const out = [];
  const preisSchluessel = /price|preis|amount|brutto|gross|einmal|cash|value/i;
  const urlSchluessel = /url|href|link|path|slug/i;
  const bildSchluessel = /image|img|bild|thumb|src/i;

  const blaetter = (o, pfad, fn, tiefe = 0) => {
    if (o == null || tiefe > 6) return;
    if (typeof o !== 'object') return fn(pfad, o);
    Object.entries(o).forEach(([k, v]) => blaetter(v, k, fn, tiefe + 1));
  };

  const ausObjekt = o => {
    const texte = Object.values(o).filter(v => typeof v === 'string' && v.length < 200);
    const name = texte.find(t => /Pixel\s+\d/.test(t));
    if (!name) return null;
    const modell = modellAusText(name);
    if (!modell) return null;
    const preise = [];
    const addPreis = n => { if (n >= PREIS_MIN && n <= PREIS_MAX) preise.push(n); };
    let url = '';
    let bild = '';
    let speicher = speicherAusText(name);
    blaetter(o, '', (k, v) => {
      if (typeof v === 'number' && preisSchluessel.test(k)) addPreis(v);
      if (typeof v === 'string') {
        if (preisSchluessel.test(k) && /^\d{2,4}([.,]\d{1,2})?$/.test(v.trim())) addPreis(Number(v.trim().replace(',', '.')));
        if (v.includes('€')) preiseAusText(v).forEach(addPreis);
        if (!url && urlSchluessel.test(k) && /^(https?:\/\/|\/)/.test(v)) url = v;
        if (!bild && bildSchluessel.test(k) && /\.(png|jpe?g|webp)(\?|$)/i.test(v)) bild = v;
        if (!speicher) speicher = speicherAusText(v);
      }
    });
    if (!preise.length) return null;
    return bauen(modell, { ...(speicher || {}), preis: Math.min(...preise), url: absolut(url), bild: absolut(bild) });
  };

  const besuche = (o, tiefe) => {
    if (o == null || typeof o !== 'object' || tiefe > 14) return;
    if (Array.isArray(o)) return o.forEach(x => besuche(x, tiefe + 1));
    const k = ausObjekt(o);
    if (k) return void out.push(k);
    Object.values(o).forEach(v => besuche(v, tiefe + 1));
  };
  besuche(wurzel, 0);
  return out;
}

// Gleiche Geräte (Modell + Speicher) zusammenführen, früheste Quelle gewinnt, fehlende Felder werden ergänzt
export function zusammenfuehren(liste) {
  const map = new Map();
  for (const k of liste) {
    if (!k || !k.modell) continue;
    const key = `${k.modell}|${k.speicherGb || 0}`;
    const alt = map.get(key);
    if (!alt) map.set(key, { ...k });
    else for (const f of ['preis', 'url', 'bild', 'speicher']) if (!alt[f] && k[f]) alt[f] = k[f];
  }
  let geraete = [...map.values()].filter(g => g.preis >= PREIS_MIN && g.preis <= PREIS_MAX);
  // Gibt es ein Modell mit Speicherangabe, fliegen die Einträge ohne Speicher raus (Doppelte)
  const mitSpeicher = new Set(geraete.filter(g => g.speicherGb).map(g => g.modell));
  geraete = geraete.filter(g => g.speicherGb || !mitSpeicher.has(g.modell));
  geraete.sort((a, b) =>
    b.gen - a.gen ||
    STUFEN_REIHE.indexOf(a.stufe) - STUFEN_REIHE.indexOf(b.stufe) ||
    (a.speicherGb || 0) - (b.speicherGb || 0));
  return geraete;
}

export function pruefen(geraete, alt) {
  if (geraete.length < 2) throw new Error('Zu wenige Pixel-Geräte mit Preis gefunden: ' + geraete.length);
  if (new Set(geraete.map(g => g.modell)).size < 2) throw new Error('Nur ein Pixel-Modell gefunden');
  const vorher = alt?.geraete?.length || 0;
  if (vorher >= 4 && geraete.length < vorher * 0.5)
    throw new Error(`Ergebnis unplausibel klein (${geraete.length} statt bisher ${vorher})`);
}

const jetzt = () => {
  const d = new Date();
  const datum = d.toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', year: 'numeric' });
  const zeit = d.toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' });
  return { datum, stand: `${datum} ${zeit}` };
};

// ── Browser-Teil ─────────────────────────────────────────────────────────────
async function seiteLesen() {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({
      locale: 'de-DE',
      timezoneId: 'Europe/Berlin',
      userAgent: UA,
      viewport: { width: 1366, height: 900 },
    });
    const page = await ctx.newPage();
    const jsons = [];
    page.on('response', async r => {
      try {
        if (!(r.headers()['content-type'] || '').includes('json')) return;
        const text = await r.text();
        jsons.push({ url: r.url(), status: r.status(), laenge: text.length, text: text.length < 3_000_000 ? text : '' });
      } catch { /* Antwort nicht lesbar – egal */ }
    });
    const resp = await page.goto(QUELLE, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForLoadState('networkidle', { timeout: 45000 }).catch(() => {});
    for (let i = 0; i < 6; i++) { // Lazy-Laden der Kacheln
      await page.mouse.wheel(0, 1500);
      await page.waitForTimeout(700);
    }
    await page.waitForTimeout(2500);
    const karten = await page.evaluate(() => {
      const norm = s => (s || '').replace(/\s+/g, ' ').trim();
      const out = [];
      const gesehen = new Set();
      for (const a of document.querySelectorAll('a[href]')) {
        const href = a.href || '';
        if (!/pixel/i.test(href + ' ' + norm(a.innerText || a.getAttribute('aria-label')))) continue;
        let el = a;
        let karte = null;
        for (let i = 0; i < 7 && el; i++, el = el.parentElement) {
          const t = norm(el.innerText);
          if (t.length > 900) break;
          if (t.includes('€') && /pixel\s+\d/i.test(t)) { karte = el; break; }
        }
        if (!karte) continue;
        const t = norm(karte.innerText);
        if (gesehen.has(t)) continue;
        gesehen.add(t);
        const img = karte.querySelector('img');
        out.push({ text: t, href, bild: img ? (img.currentSrc || img.src) : '' });
      }
      return out;
    });
    const text = await page.evaluate(() => document.body.innerText || '');
    return { status: resp?.status(), url: page.url(), titel: await page.title(), karten, text, jsons };
  } finally {
    await browser.close();
  }
}

function kandidatenSammeln(s) {
  const karten = s.karten.map(k => kandidatAusKartentext(k.text, k.href, k.bild)).filter(Boolean);
  const json = [];
  for (const j of s.jsons) {
    if (!/Pixel/.test(j.text)) continue;
    try { json.push(...kandidatenAusJson(JSON.parse(j.text))); } catch { /* kein gültiges JSON */ }
  }
  let alle = [...karten, ...json];
  if (zusammenfuehren(alle).length < 2) alle = [...alle, ...kandidatenAusSeitentext(s.text)];
  return { karten, json, alle };
}

function debugText(s, k, fehler, geraete) {
  const z = [];
  z.push(fehler ? `Pixel-Abruf fehlgeschlagen: ${fehler}` : 'Pixel-Abruf OK (Diagnose eingeschaltet)', `Zeit: ${jetzt().stand}`, `Quelle: ${QUELLE}`);
  const zeile = c => `- ${c.modell} | ${c.speicher || 'ohne Speicher'} | ${c.preis} € | ${c.url || 'ohne Link'}`;
  if (k) {
    z.push('', `Aus Kacheln (${k.karten.length}):`, ...k.karten.map(zeile));
    z.push('', `Aus JSON (${k.json.length}):`, ...k.json.slice(0, 40).map(zeile));
  }
  if (geraete) z.push('', `Ergebnis (${geraete.length}):`, ...geraete.map(zeile));
  if (s) {
    z.push(`HTTP: ${s.status}  Endadresse: ${s.url}`, `Titel: ${s.titel}`);
    z.push('', `Kacheln (Links mit Pixel): ${s.karten.length}`);
    s.karten.slice(0, 6).forEach(c => z.push(`- ${c.text.slice(0, 300)}  [${c.href}]`));
    z.push('', `JSON-Antworten: ${s.jsons.length}`);
    s.jsons.slice(0, 40).forEach(j => z.push(`- ${j.status} ${j.laenge} ${j.url.slice(0, 200)}${/Pixel/.test(j.text) ? '  <- enthält Pixel' : ''}`));
    s.jsons.filter(j => /Pixel/.test(j.text)).slice(0, 2).forEach(j => {
      const i = j.text.indexOf('Pixel');
      z.push('', `Ausschnitt ${j.url.slice(0, 120)}:`, j.text.slice(Math.max(0, i - 600), i + 900));
    });
    z.push('', 'Zeilen mit Pixel im Seitentext:');
    s.text.split('\n').filter(l => /Pixel/i.test(l)).slice(0, 40).forEach(l => z.push('  ' + l.trim().slice(0, 200)));
    z.push('', 'Seitentext (Anfang):', s.text.replace(/\n{2,}/g, '\n').slice(0, 2500));
  }
  if (k) z.push('', `Kandidaten: Kacheln ${k.karten.length}, JSON ${k.json.length}, gesamt ${k.alle.length}`);
  return z.join('\n') + '\n';
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let seite;
  let kand;
  try {
    seite = await seiteLesen();
    kand = kandidatenSammeln(seite);
    const geraete = zusammenfuehren(kand.alle);

    let alt = {};
    try { alt = JSON.parse(await readFile(DATEI, 'utf8')); } catch { /* erste Ausführung */ }
    pruefen(geraete, alt);

    const { datum, stand } = jetzt();
    const geaendert = JSON.stringify(alt.geraete) !== JSON.stringify(geraete);
    await writeFile(DATEI, JSON.stringify({
      quelle: QUELLE,
      geprueft: datum,
      stand,
      geaendertAm: geaendert ? datum : (alt.geaendertAm || datum),
      geraete,
    }, null, 2) + '\n');
    if (process.env.PIXEL_DEBUG) await writeFile(DEBUG, debugText(seite, kand, null, geraete));
    else await rm(DEBUG, { force: true });
    console.log(geaendert ? 'PIXEL-GERÄTE GEÄNDERT:' : 'unverändert:', geraete.map(g => `${g.modell} ${g.speicher} ${g.preis} €`).join(' | '));
  } catch (e) {
    await writeFile(DEBUG, debugText(seite, kand, e.message));
    console.error('FEHLER:', e.message);
    process.exitCode = 1;
  }
}

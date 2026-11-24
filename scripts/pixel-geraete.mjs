import { execFileSync } from 'node:child_process';
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
  const re = /(\d{1,4})\s?(GB|TB)(?!\s*RAM)/gi;
  let m;
  while ((m = re.exec(String(text || '')))) {
    const gb = m[2].toUpperCase() === 'TB' ? Number(m[1]) * 1024 : Number(m[1]);
    if (gb >= 64) return { speicher: `${m[1]} ${m[2].toUpperCase()}`, speicherGb: gb };
  }
  return null;
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

// Der Shop liefert den Katalog im JSON-Skript pageValue bereits im HTML.
export function leseKatalog(html, monate) {
  const script = html.match(/<script\b(?=[^>]*\bid=["']pageValue["'])[^>]*>([\s\S]*?)<\/script>/i);
  if (!script) throw new Error('o2-Produktkatalog fehlt');
  const result = new Map();
  for (const tab of JSON.parse(script[1]).tabs || []) {
    for (const h of tab.hwCatalogValue?.hardware || []) {
      const attr = h.ecommerceProductValue?.attributes;
      const modell = modellAusText(attr?.dimension164);
      if (!modell || attr.dimension165 !== 'Google' || attr.category !== 'hw-only_smartphone' ||
          attr.dimension164 !== modell.modell || !h.externalId) continue;
      const link = h.detailWwwAbsoluteCall?.constantPayload?.link?.uri;
      if (!link) continue;
      const url = new URL(link, BASIS);
      const slug = 'google-' + modell.modell.toLowerCase().replaceAll(' ', '-');
      const prefix = '/e-shop/google/' + slug + '-';
      const variant = url.pathname.slice(prefix.length);
      if (url.origin !== BASIS || !url.pathname.startsWith(prefix) ||
          !/^\d{1,4}(?:gb|tb)-[a-z0-9-]+-details$/i.test(variant) || variant.includes('-mit-') ||
          url.searchParams.get('ohne-tarif') !== 'ja' || url.searchParams.get('ratenzahlung') !== String(monate) ||
          !new RegExp('^' + monate + '\\s*Monate$').test(h.rateDurationValue)) continue;
      const speicher = speicherAusText(variant);
      const p = h.price;
      if (!speicher || !p) continue;
      const preis = p.promotionActive ? p.promotionTotalPrice : p.totalPrice;
      const rate = p.promotionActive ? p.promotionMonthlyPrice : p.monthlyPrice;
      const anzahlung = p.promotionActive ? p.promotionOneTimePrice : p.oneTimePrice;
      if (![preis, rate, anzahlung].every(Number.isFinite) || preis < PREIS_MIN || preis > PREIS_MAX ||
          rate <= 0 || anzahlung < 0 || Math.round(preis * 100) !== monate * Math.round(rate * 100) + Math.round(anzahlung * 100)) continue;
      const bild = h.imageUrl && !/samsung|galaxy|iphone|xiaomi/i.test(h.imageUrl) ? h.imageUrl : '';
      result.set(h.externalId, { ...modell, ...speicher, name: 'Google ' + modell.modell, preis, rate, anzahlung, url: url.href, bild });
    }
  }
  return result;
}

export function kombiniere(liste36, liste24) {
  return [...liste36].map(([id, g]) => {
    const kurz = liste24.get(id);
    if (kurz?.modell === g.modell && kurz.speicherGb === g.speicherGb && kurz.preis === g.preis)
      return { ...g, rate24: kurz.rate, anzahlung24: kurz.anzahlung };
    return g;
  }).sort((a, b) => b.gen - a.gen || STUFEN_REIHE.indexOf(a.stufe) - STUFEN_REIHE.indexOf(b.stufe) || a.speicherGb - b.speicherGb);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const abruf = monate => {
      const html = execFileSync('curl', ['--fail', '--silent', '--show-error', '--location', '--retry', '2',
        '--max-time', '45', '--user-agent', UA, QUELLE + '&ratenzahlung=' + monate], { encoding: 'utf8', maxBuffer: 8000000 });
      return leseKatalog(html, monate);
    };
    const geraete = kombiniere(abruf(36), abruf(24));
    const alt = JSON.parse(await readFile(DATEI, 'utf8'));
    pruefen(geraete, alt);
    const { datum, stand } = jetzt();
    const geaendertAm = JSON.stringify(alt.geraete) === JSON.stringify(geraete) ? alt.geaendertAm : datum;
    await writeFile(DATEI, JSON.stringify({ quelle: QUELLE, geprueft: datum, stand, geaendertAm, geraete }, null, 2) + '\n');
    await rm(DEBUG, { force: true });
    console.log(geraete.length + ' Geräte aktualisiert');
  } catch (e) {
    await writeFile(DEBUG, 'Pixel-Abruf fehlgeschlagen: ' + e.message + '\n');
    console.error(e.message);
    process.exitCode = 1;
  }
}

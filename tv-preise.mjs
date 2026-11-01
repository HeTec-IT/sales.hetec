// Holt die aktuellen o2-TV-Preise (24 Monate) von o2online.de und schreibt tv-preise.json.
// Läuft per GitHub Action täglich. Bei Fehler/unplausiblen Werten: Abbruch, alte Datei bleibt.
import { readFile, writeFile } from 'node:fs/promises';

const QUELLE = 'https://www.o2online.de/extras/o2-tv/';
const DATEI = new URL('../tv-preise.json', import.meta.url);
const PAKETE = [
  ['classic', 'Classic'],
  ['smart', 'Smart'],
  ['prem', 'Premium(?!\\s*Pro)'],
  ['prempro', 'Premium\\s*Pro'],
];

export function htmlZuText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;|&#xa0;/gi, ' ')
    .replace(/&euro;|&#8364;|&#x20ac;/gi, '€')
    .replace(/&amp;/gi, '&')
    .replace(/₂/g, '2')
    .replace(/\s+/g, ' ');
}

export function preiseAuslesen(text) {
  const kopf = /O\s*2\s*TV\s+(?:Classic|Smart|Premium)/gi;
  const preisRe = /(\d{1,2})\s*[,.]?\s*(\d{2})\s*,?\s*€\s*(?:\*+|\d{1,2}\s*)?monatlich/i;
  const preise = {};
  for (const [id, name] of PAKETE) {
    const re = new RegExp(`O\\s*2\\s*TV\\s+${name}\\b(?!\\s*Flex)`, 'gi');
    let m;
    while ((m = re.exec(text)) && preise[id] === undefined) {
      kopf.lastIndex = m.index + m[0].length;
      const naechster = kopf.exec(text);
      const ende = Math.min(naechster ? naechster.index : text.length, m.index + 2000);
      const abschnitt = text.slice(m.index, ende);
      if (!/24\s*Monate/i.test(abschnitt)) continue;
      const p = abschnitt.match(preisRe);
      if (p) preise[id] = Number(`${p[1]}.${p[2]}`);
    }
  }
  return preise;
}

function pruefen(p) {
  const ids = PAKETE.map(([id]) => id);
  const fehlt = ids.filter(k => !(p[k] > 0 && p[k] < 100));
  if (fehlt.length) throw new Error('Preise nicht gefunden: ' + fehlt.join(', '));
  if (!(p.classic < p.smart && p.smart < p.prem && p.prem < p.prempro))
    throw new Error('Preisreihenfolge unplausibel: ' + JSON.stringify(p));
}

async function laden() {
  let fehler;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(QUELLE, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'de-DE,de;q=0.9',
        },
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.text();
    } catch (e) {
      fehler = e;
      await new Promise(res => setTimeout(res, 5000 * (i + 1)));
    }
  }
  throw fehler;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const preise = preiseAuslesen(htmlZuText(await laden()));
  pruefen(preise);

  let alt = {};
  try { alt = JSON.parse(await readFile(DATEI, 'utf8')); } catch {}
  const heute = new Date().toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', year: 'numeric' });
  const geaendert = JSON.stringify(alt?.o2?.preise) !== JSON.stringify(preise);

  const neu = {
    o2: {
      preise,
      geprueft: heute,
      geaendertAm: geaendert ? heute : (alt?.o2?.geaendertAm || heute),
      quelle: QUELLE,
    },
  };
  await writeFile(DATEI, JSON.stringify(neu, null, 2) + '\n');
  console.log(geaendert ? 'PREISE GEÄNDERT:' : 'unverändert:', JSON.stringify(preise));
}

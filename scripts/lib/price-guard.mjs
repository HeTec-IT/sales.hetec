// Schutz für automatische Preisaktualisierungen (alle *-preise.mjs / pixel-geraete.mjs).
//
// - Eine fehlgeschlagene oder unplausible Aktualisierung überschreibt NIE die vorhandenen, gültigen Preise
//   (die Skripte brechen vorher ab; hier zusätzlich: Struktur- und Sprungprüfung).
// - Preissprung > maxRatio (Standard 40 %) gegenüber dem letzten gültigen Stand wird erst übernommen, wenn
//   derselbe neue Wert beim nächsten Lauf erneut gelesen wird (zwei Läufe in Folge). Bis dahin bleibt der alte Wert.
// - Jeder Lauf schreibt ein Protokoll (price-status/<datei>.json): Zeitpunkt, Ergebnis, letzter erfolgreicher Lauf.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// Ein Statusfile je Datei (keine Push-Konflikte, wenn mehrere Preis-Workflows gleichzeitig laufen)
const statusFile = key => path.join(process.env.PS_PRICE_STATUS_DIR || path.join(ROOT, 'price-status'), key.replace(/\.json$/, '') + '.json');

/** Alle Zahlen eines Objekts mit Pfad sammeln (z. B. tarife.1.preis → 15.99). */
export function zahlen(obj, prefix = '', out = {}) {
  if (Array.isArray(obj)) obj.forEach((v, i) => zahlen(v, prefix + (v && typeof v === 'object' && (v.id || v.name) ? (v.id || v.name) : i) + '.', out));
  else if (obj && typeof obj === 'object') for (const [k, v] of Object.entries(obj)) zahlen(v, prefix + k + '.', out);
  else if (typeof obj === 'number' && isFinite(obj)) out[prefix.slice(0, -1)] = obj;
  return out;
}

/** Preissprünge zwischen altem und neuem Stand (nur Preisfelder, keine Zähler wie Monate/GB). */
export function spruenge(alt, neu, maxRatio = 0.4) {
  const a = zahlen(alt), n = zahlen(neu), out = [];
  for (const [k, v] of Object.entries(n)) {
    if (!/(preis|price|rate|netflix|werbung|standard|premium|smart|stream|mega|classic|prem|^s$|^m$|\.s$|\.m$|von)$/i.test(k)) continue;
    if (!(k in a) || a[k] <= 0) continue;
    const r = Math.abs(v - a[k]) / a[k];
    if (r > maxRatio) out.push({ feld: k, alt: a[k], neu: v, aenderung: Math.round(r * 100) + '%' });
  }
  return out;
}

async function lesen(file) { try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; } }

/**
 * Schreibt neue Preisdaten nur, wenn sie die Prüfungen bestehen.
 * @returns {Promise<{geschrieben:boolean, grund?:string, spruenge?:object[]}>}
 */
export async function geschuetztSchreiben(datei, neu, { name, maxRatio = 0.4, pruefe } = {}) {
  const file = datei instanceof URL ? fileURLToPath(datei) : datei;
  const key = name || path.basename(file);
  const alt = await lesen(file);
  const eintrag = (await lesen(statusFile(key))) || {};
  const jetzt = new Date().toISOString();
  const fertig = async (geschrieben, grund, extra = {}) => {
    const st = { ...eintrag, letzterLauf: jetzt, ergebnis: geschrieben ? 'aktualisiert' : 'unverändert', grund: grund || '', ...extra };
    if (geschrieben) st.letzterErfolg = jetzt;
    await mkdir(path.dirname(statusFile(key)), { recursive: true });
    await writeFile(statusFile(key), JSON.stringify(st, null, 2) + '\n');
    return { geschrieben, grund, ...extra };
  };
  if (!neu || typeof neu !== 'object') return fertig(false, 'keine Daten');
  if (pruefe) {
    try { pruefe(neu); } catch (e) { return fertig(false, 'Prüfung: ' + e.message); }
  }
  const sp = alt ? spruenge(alt, neu, maxRatio) : [];
  if (sp.length) {
    const sig = JSON.stringify(sp.map(s => [s.feld, s.neu]));
    if (eintrag.wartend !== sig) {
      return fertig(false, 'Preissprung – wartet auf Bestätigung im nächsten Lauf', { wartend: sig, spruenge: sp });
    }
  }
  await writeFile(file, JSON.stringify(neu, null, 2) + '\n');
  return fertig(true, sp.length ? 'Preissprung bestätigt (zweiter Lauf)' : '', { wartend: '' });
}

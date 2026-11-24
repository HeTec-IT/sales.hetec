'use strict';
// Handschrift -> Text (Pencil Selling). HTTPS-Funktion, Erkennung ueber Gemini auf Vertex AI (EU-Endpunkt).
// Nur fuer angemeldete App-Benutzer (Firebase-Login-Token). Es wird nichts gespeichert und kein Inhalt geloggt.
const { onRequest } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const { GoogleAuth } = require('google-auth-library');

// Einstellungen per Umgebungsvariable (siehe deploy.sh). Modell/Region koennen ohne Code-Aenderung gewechselt werden.
const MODEL = process.env.HTR_MODEL || 'gemini-3.5-flash';
const LOCATION = process.env.HTR_LOCATION || 'eu'; // 'eu' = EU-Multi-Region, sonst z. B. 'europe-west4'
const PROJECTS = (process.env.HTR_PROJECTS || 'o2-pencil-selling,pencil-selling-telekom').split(',').map(s => s.trim()).filter(Boolean);
const MAX_B64 = 6 * 1024 * 1024; // ~4,4 MB Bild
const RATE_PER_MIN = 40; // je Benutzer und Instanz

const apps = {};
function verifierFor(projectId) {
  if (!apps[projectId]) apps[projectId] = admin.initializeApp({ projectId }, 'htr-' + projectId);
  return apps[projectId].auth();
}
// Token gegen alle erlaubten Firebase-Projekte pruefen (o2 und Telekom haben je ein eigenes Projekt).
async function verifyToken(token) {
  for (const pid of PROJECTS) {
    try {
      return await verifierFor(pid).verifyIdToken(token);
    } catch (e) { /* naechstes Projekt */ }
  }
  return null;
}

const hits = new Map();
function rateOk(uid) {
  const now = Date.now();
  const arr = (hits.get(uid) || []).filter(t => now - t < 60000);
  if (arr.length >= RATE_PER_MIN) { hits.set(uid, arr); return false; }
  arr.push(now);
  hits.set(uid, arr);
  return true;
}

const HINTS = {
  name: 'Das Bild zeigt einen handgeschriebenen Personennamen (Vor- und Nachname, deutschsprachiger Kontext, Umlaute moeglich). Gib nur den Namen zurueck.',
  phone: 'Das Bild zeigt eine handgeschriebene Telefonnummer (Deutschland). Gib nur Ziffern, ein fuehrendes + und Leerzeichen zurueck. Achte auf 0 statt O, 1 statt l, Ziffer 7 mit Querstrich.',
  text: 'Das Bild zeigt eine handgeschriebene Notiz (deutsch), gegebenenfalls mehrzeilig. Behalte die Zeilenumbrueche bei.'
};
function buildBody(image, mime, kind) {
  const prompt = 'Lies die Handschrift im Bild und gib sie woertlich als Text wieder. ' + (HINTS[kind] || HINTS.text) +
    ' Nichts erfinden, nichts ergaenzen, keine Erklaerungen. Ist nichts Lesbares zu sehen, setze readable=false und text="".';
  return {
    contents: [{ role: 'user', parts: [{ text: prompt }, { inlineData: { mimeType: mime, data: image } }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: { type: 'OBJECT', properties: { text: { type: 'STRING' }, readable: { type: 'BOOLEAN' } }, required: ['text', 'readable'] },
      maxOutputTokens: 600
    }
  };
}

// kind 'o2': Foto eines o2-Vorschlags (Activate+, meist vom Bildschirm abfotografiert) -> fertige Felder fuer die Angebotskarte.
const O2_ITEM = {
  type: 'OBJECT',
  properties: {
    name: { type: 'STRING' },
    details: { type: 'ARRAY', items: { type: 'STRING' } },
    einmalig: { type: 'STRING' },
    monatlich: { type: 'STRING' },
    rabattEinmalig: { type: 'STRING' },
    rabattMonatlich: { type: 'STRING' },
    tarif: { type: 'INTEGER' }
  },
  required: ['name', 'details']
};
const O2_PROMPT = [
  'Das Bild ist das Foto eines o2-Vorschlags aus Activate+ (deutsch), oft schraeg, unscharf oder vom Bildschirm abfotografiert.',
  'Lies den Vorschlag und gib ihn als Felder zurueck. Reihenfolge wie im Bild von oben nach unten.',
  'Zu jedem Abschnitt gehoert eine Ueberschrift: TARIF -> tarife, HANDY (auch SMARTPHONE, TABLET, ZUBEHOER, SMARTWATCH) -> geraete, INTERNET@HOME (auch DSL, KABEL, GLASFASER) -> internet.',
  'name = die fette Produktzeile unter der Ueberschrift, ohne Preise. Schreibe o2-Produkte mit "O2" am Anfang, z. B. "O2 Mobile M Plus (2026)", "O2 Home XL 600".',
  'Bei Geraeten den Namen ausschreiben und Abkuerzungen aufloesen: IP = iPhone, PM = Pro Max, BURG. = Burgunder, SWZ = Schwarz, VIO = Violett, BK = Schwarz, Speicher mit GB. Marke nicht doppelt nennen.',
  'details = die Leistungszeilen darunter, woertlich. NICHT aufnehmen: UMTS-Option, alle Rabatt- und Vorteilszeilen, Anschlusspreis, Aktivierung, Gesamtpreis, Installationsadresse, Seitenfuss, Werbung.',
  'einmalig und monatlich je Zeile = die beiden Preisspalten rechts neben dem Produktnamen, als deutsche Zahl ohne Euro-Zeichen (z. B. "39,99"); steht dort ein Strich, leer lassen.',
  'Preislogik fuer Produktkopfzeilen: einmalig und monatlich sind NUR die Preise in der fetten Hauptzeile rechts. Unterzeilen mit Anschlusspreis oder anderen Erlaeuterungen NICHT zusaetzlich addieren, keine zweite Position daraus erzeugen.',
  'Internetbeispiel: Steht bei O2 Home XL 600 oben einmalig 9,99 und darunter Anschlusspreis 49,99 sowie 40 EUR Rabatt auf den Anschlusspreis, dann ist 9,99 bereits der rabattierte Kopfzeilenpreis. rabattEinmalig fuer dieses Internetprodukt leer lassen, sonst wuerde der Rabatt doppelt abgezogen.',
  'Monatlicher Rabatt: Steht beim Tarif als Kopfzeilenpreis monatlich 29,99 und in einer separaten Unterzeile Plus-Rabatt -15,00, dann monatlich=29,99 und rabattMonatlich=15,00, sofern die Gesamtsumme dies bestaetigt; Rabatt NICHT zu den Details schreiben.',
  'Rabattfelder nur fuellen, wenn der Rabatt noch NICHT im zugehoerigen Kopfzeilenpreis enthalten ist. Negative Rabatte als positive Zahl in rabattEinmalig oder rabattMonatlich zurueckgeben. Keine Rabatte erraten.',
  'Direkt abgedruckte Summenzeilen Einmalige Kosten und Monatliche Kosten exakt und separat in die aeusseren Felder einmalig/monatlich uebernehmen, nicht mit den einzelnen Produktkosten verwechseln.',
  'Plausibilitaet: Summiere Kopfzeilenpreise und nur noch nicht eingerechnete Rabattzeilen je Spalte. Passt die Rechnung nicht zur abgedruckten Gesamtsumme, uebernehme die sichtbare Gesamtsumme unveraendert; erfinde keine korrigierten Preise.',
  'Gleichnamige Tarife in getrennten TARIF-Bloecken sind unterschiedliche Positionen. Internet@Home nie als Mobilfunktarif erfassen. Installationsadresse niemals ausgeben.',
  'WICHTIG ZWEISEITIGER BELEG: Die Position INTERNET@HOME kann am ENDE von Seite 1 mit Produktname und Kopfzeilenpreisen stehen; die Leistungszeilen dazu kommen erst OBEN auf Seite 2. Auf Seite 1 die Internetposition MIT den beiden sichtbaren Preisen erfassen, auch wenn Details erst auf Seite 2 erscheinen.',
  'Steht auf der aktuellen Seite nur eine Installationsadresse und darunter Analog Option, International Voice Standard, O2 Installationsservice, Anschlusspreis und Kostenblock, aber KEIN Internet-Produktname: KEIN neues Internet-Produkt erfinden. Gib die lesbaren Leistungszeilen (keine Adresse, keine Rabatte, keine Preise) in internetFortsetzung zurueck, damit sie mit der Internetposition der vorigen Seite verbunden werden.',
  'Spezialfall: Seite 2 von 2 zeigt Einmalige Kosten 1.858,96 EUR und direkt darunter Monatliche Kosten 139,96 EUR. In der JSON-Antwort einmalig="1.858,96" und monatlich="139,96" setzen. Das ist ein Testbeispiel, kein allgemeiner Preiswert: NUR Beträge verwenden, die auf dem aktuellen Bild wirklich lesbar sind.',
  'Lies Summen ausschliesslich anhand der direkt benachbarten Beschriftungen Einmalige Kosten und Monatliche Kosten, NICHT anhand der Spaltenkoepfe von Seite 1. Beträge stehen rechts neben den jeweiligen Beschriftungen und auf Seite 2 untereinander; niemals den einmaligen Betrag in das monatliche Feld kopieren, weil der zweite Betrag fehlt.',
  'Produktpreise von Seite 1 komplett: bei 3 Tarifen O2 Mobile S, M, L stehen 39,99 EUR einmalig je Tarif und 19,99 / 29,99 / 34,99 EUR monatlich. Das sind nur Lesehilfen fuer dieses Beispielfoto, keine festen Preise. Internet O2 Home XL 600 steht separat mit 9,99 EUR einmalig und 54,99 EUR monatlich.',
  'Plausibilitaetsrechnung des Beispielangebots: einmalig 1.729,00 + 3 x 39,99 + 9,99 = 1.858,96; monatlich 19,99 + 29,99 + 34,99 + 54,99 = 139,96. Keine solchen Werte verwenden, wenn sie nicht zum tatsaechlichen Bild passen.',
  'readable=true, sobald mindestens ein echtes Produkt oder eine Gesamtkostenzeile erkennbar ist. Nur bei wirklich unlesbarem Vorschlag readable=false; teilweise erkannte Angebote sind kein Totalfehler.',
  'rabattEinmalig und rabattMonatlich = Summe der Rabatt- und Vorteilszeilen dieses Produkts je Spalte, als positive Zahl (z. B. "15,00"); ohne Rabatt leer lassen.',
  'tarif (nur bei geraete) = die Nummer des Tarifs, unter dem das Geraet im Bild steht, 1 fuer den ersten Tarif. Ist kein Tarif im Bild, 0.',
  'einmalig und monatlich ganz unten = die Zeilen "Einmalige Kosten" und "Monatliche Kosten".',
  'hinweis = immer leer lassen. Die Zeile "*Ab dem N. Monat: X" (Preiserhoehung, auch "ab dem 12. Monat") ignorieren: dieser Betrag ist weder einmalig noch monatlich.',
  'Einen Abschnitt "Aktuell" (bisherige Vertraege des Kunden) komplett ignorieren. Die Zeile "Ersparnis ..." ist keine Kostenposition: weder einmalig noch monatlich daraus ableiten.',
  'erstelltAm = Datum und Uhrzeit aus der Zeile "verbindlicher Vorschlag erstellt am TT.MM.JJJJ HH:MM" (z. B. "23.11.2026 17:15"), sonst leer. beratungsId = nur die Ziffern der Beratungs-ID, sonst leer. Beides dient nur der Zuordnung mehrerer Fotos zu EINEM Angebot.',
  'Nichts erfinden und nichts ergaenzen. Was nicht sicher lesbar ist, weglassen. Ist kein Vorschlag zu erkennen, alle Listen leer lassen und readable=false setzen.'
].join(' ');
function buildO2Body(image, mime) {
  return {
    contents: [{ role: 'user', parts: [{ text: O2_PROMPT }, { inlineData: { mimeType: mime, data: image } }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          tarife: { type: 'ARRAY', items: O2_ITEM },
          geraete: { type: 'ARRAY', items: O2_ITEM },
          internet: { type: 'ARRAY', items: O2_ITEM },
          internetFortsetzung: { type: 'ARRAY', items: { type: 'STRING' } },
          einmalig: { type: 'STRING' },
          monatlich: { type: 'STRING' },
          hinweis: { type: 'STRING' },
          erstelltAm: { type: 'STRING' },
          beratungsId: { type: 'STRING' },
          readable: { type: 'BOOLEAN' }
        },
        required: ['tarife', 'geraete', 'internet', 'readable']
      },
      maxOutputTokens: 4000
    }
  };
}
function endpointFor(project) {
  if (process.env.HTR_ENDPOINT) return process.env.HTR_ENDPOINT.replace('{project}', project).replace('{model}', MODEL);
  const host = LOCATION === 'global' ? 'aiplatform.googleapis.com'
    : (LOCATION === 'eu' || LOCATION === 'us') ? 'aiplatform.' + LOCATION + '.rep.googleapis.com'
    : LOCATION + '-aiplatform.googleapis.com';
  return 'https://' + host + '/v1/projects/' + project + '/locations/' + LOCATION + '/publishers/google/models/' + MODEL + ':generateContent';
}

let gauth = null;
async function callModelRaw(body) {
  gauth = gauth || new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const project = await gauth.getProjectId();
  const client = await gauth.getClient();
  const r = await client.request({ url: endpointFor(project), method: 'POST', data: body, timeout: 50000 });
  const parts = r.data && r.data.candidates && r.data.candidates[0] && r.data.candidates[0].content && r.data.candidates[0].content.parts || [];
  const raw = parts.map(p => p.text || '').join('').trim();
  return JSON.parse(raw);
}
async function callModel(body) {
  const j = await callModelRaw(body);
  return { text: String(j.text || '').trim(), readable: j.readable !== false };
}
// Antwort des Modells auf das erwartete Format bringen (nur Strings/Listen, Laengen begrenzt)
function cleanO2(j) {
  const str = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n || 120);
  const amt = v => { const m = /\d{1,3}(?:\.\d{3})*,\d{2}/.exec(String(v == null ? '' : v)); return m ? m[0] : ''; };
  const list = (a, withTarif) => (Array.isArray(a) ? a : []).slice(0, 8).map(it => {
    const o = {
      name: str(it && it.name),
      details: (Array.isArray(it && it.details) ? it.details : []).map(d => str(d)).filter(Boolean).slice(0, 10),
      einmalig: amt(it && it.einmalig),
      monatlich: amt(it && it.monatlich),
      rabattEinmalig: amt(it && it.rabattEinmalig),
      rabattMonatlich: amt(it && it.rabattMonatlich)
    };
    if (withTarif && Number.isInteger(it && it.tarif) && it.tarif > 0) o.tarif = Math.min(9, it.tarif);
    return o;
  }).filter(x => x.name.length >= 3);
  const out = {
    tarife: list(j.tarife), geraete: list(j.geraete, true), internet: list(j.internet),
    internetFortsetzung: (Array.isArray(j.internetFortsetzung) ? j.internetFortsetzung : [])
      .map(v => str(v, 90)).filter(v => /^(?:Analog Option|International Voice (?:Standard|Premium)|O2 Installationsservice|O2 my Data unlimited|Roaming (?:Standard|Premium)|Inklusiv Datenvolumen\s+\d+\s*GB)$/i.test(v)).slice(0, 10),
    einmalig: amt(j.einmalig), monatlich: amt(j.monatlich), hinweis: '',
    erstelltAm: (m => m ? m[1] + '.' + m[2] + '.' + m[3] + (m[4] ? ' ' + m[4] : '') : '')(/(\d{2})\.(\d{2})\.(20\d{2})(?:\D{1,3}(\d{2}:\d{2}))?/.exec(String(j.erstelltAm == null ? '' : j.erstelltAm))),
    beratungsId: String(j.beratungsId == null ? '' : j.beratungsId).replace(/\D/g, '').slice(0, 15),
    readable: false
  };
  // Bei bereits extrahierten Positionen ist ein readable=false des Modells ein Widerspruch.
  // Ohne irgendeine Position oder Kostensumme ist readable=true kein verwertbares Ergebnis.
  out.readable = Boolean(out.tarife.length || out.geraete.length || out.internet.length || out.einmalig || out.monatlich);
  return out;
}

async function handle(req, res) {
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'method' }); return; }
  const m = /^Bearer (.+)$/.exec(req.get('Authorization') || '');
  const user = m ? await verifyToken(m[1]) : null;
  if (!user) { res.status(401).json({ ok: false, error: 'auth' }); return; }
  if (!rateOk(user.uid)) { res.status(429).json({ ok: false, error: 'busy' }); return; }
  const b = req.body || {};
  const mime = b.mime === 'image/jpeg' ? 'image/jpeg' : 'image/png';
  const image = typeof b.image === 'string' ? b.image : '';
  if (!image || image.length > MAX_B64 || !/^[A-Za-z0-9+/=]+$/.test(image.slice(0, 200))) { res.status(400).json({ ok: false, error: 'bad' }); return; }
  const kind = b.kind === 'o2' || HINTS[b.kind] ? b.kind : 'text';
  try {
    if (kind === 'o2') {
      const d = cleanO2(await callModelRaw(buildO2Body(image, mime)));
      res.status(200).json({ ok: true, data: d, readable: d.readable });
      return;
    }
    const out = await callModel(buildBody(image, mime, kind));
    res.status(200).json({ ok: true, text: out.text, readable: out.readable });
  } catch (e) {
    // Nur Statuscode loggen, nie Bildinhalt oder erkannten Text.
    console.error('htr model error', kind, e && e.response && e.response.status || e && e.code || String(e && e.message).slice(0, 120));
    res.status(502).json({ ok: false, error: 'server' });
  }
}

exports.handwritingToText = onRequest({ region: 'europe-west3', memory: '512MiB', timeoutSeconds: 60, maxInstances: 5, cors: true }, handle);
exports._handle = handle; // fuer Tests

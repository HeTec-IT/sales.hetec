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
  'rabattEinmalig und rabattMonatlich = Summe der Rabatt- und Vorteilszeilen dieses Produkts je Spalte, als positive Zahl (z. B. "15,00"); ohne Rabatt leer lassen.',
  'tarif (nur bei geraete) = die Nummer des Tarifs, unter dem das Geraet im Bild steht, 1 fuer den ersten Tarif. Ist kein Tarif im Bild, 0.',
  'einmalig und monatlich ganz unten = die Zeilen "Einmalige Kosten" und "Monatliche Kosten".',
  'hinweis = nur wenn dort "*Ab dem N. Monat: X" steht, dann genau "Monatlich ab dem N. Monat: X €", sonst leer.',
  'Einen Abschnitt "Aktuell" (bisherige Vertraege des Kunden) komplett ignorieren.',
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
          einmalig: { type: 'STRING' },
          monatlich: { type: 'STRING' },
          hinweis: { type: 'STRING' },
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
  return {
    tarife: list(j.tarife), geraete: list(j.geraete, true), internet: list(j.internet),
    einmalig: amt(j.einmalig), monatlich: amt(j.monatlich), hinweis: str(j.hinweis, 80),
    readable: j.readable !== false
  };
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

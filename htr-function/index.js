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
const MAX_B64 = 3 * 1024 * 1024; // ~2,2 MB Bild
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
function endpointFor(project) {
  if (process.env.HTR_ENDPOINT) return process.env.HTR_ENDPOINT.replace('{project}', project).replace('{model}', MODEL);
  const host = LOCATION === 'global' ? 'aiplatform.googleapis.com'
    : (LOCATION === 'eu' || LOCATION === 'us') ? 'aiplatform.' + LOCATION + '.rep.googleapis.com'
    : LOCATION + '-aiplatform.googleapis.com';
  return 'https://' + host + '/v1/projects/' + project + '/locations/' + LOCATION + '/publishers/google/models/' + MODEL + ':generateContent';
}

let gauth = null;
async function callModel(body) {
  gauth = gauth || new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const project = await gauth.getProjectId();
  const client = await gauth.getClient();
  const r = await client.request({ url: endpointFor(project), method: 'POST', data: body, timeout: 22000 });
  const parts = r.data && r.data.candidates && r.data.candidates[0] && r.data.candidates[0].content && r.data.candidates[0].content.parts || [];
  const raw = parts.map(p => p.text || '').join('').trim();
  const j = JSON.parse(raw);
  return { text: String(j.text || '').trim(), readable: j.readable !== false };
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
  const kind = HINTS[b.kind] ? b.kind : 'text';
  try {
    const out = await callModel(buildBody(image, mime, kind));
    res.status(200).json({ ok: true, text: out.text, readable: out.readable });
  } catch (e) {
    // Nur Statuscode loggen, nie Bildinhalt oder erkannten Text.
    console.error('htr model error', e && e.response && e.response.status || e && e.code || String(e && e.message).slice(0, 120));
    res.status(502).json({ ok: false, error: 'server' });
  }
}

exports.handwritingToText = onRequest({ region: 'europe-west3', memory: '256MiB', timeoutSeconds: 30, maxInstances: 5, cors: true }, handle);
exports._handle = handle; // fuer Tests

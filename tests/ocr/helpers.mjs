// Laedt die Smart-Scan-Logikmodule (frontend/smart-scan) ohne Browser in eine Node-VM. Kein Build, keine Abhaengigkeiten.
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'frontend', 'smart-scan');

// Logik-Module von Smart Scan (ohne Oberfläche), in Ladereihenfolge
export const LOGIC_MODULES = ['parser.js', 'preprocess.js', 'neural.js', 'engine.js', 'transfer.js'];
export function ocrSource() {
  return LOGIC_MODULES.map(f => fs.readFileSync(path.join(SS, f), 'utf8')).join('\n;\n');
}

const NAMES = ['psO2Parse', 'psO2WordsToText', 'psO2Score', 'psO2Check', 'psO2Suggest', 'psO2Verdict', 'psO2Gaps', 'psO2Combine',
  'psO2Pretty', 'psO2ReadLocal', 'psO2NewJob', 'psO2Release', 'psO2Worker', 'psO2ResetEngine', 'psO2WithTimeout', 'psO2Cents', 'psO2Fmt', 'PS_O2_T', 'PS_O2_PLAN', 'psO2OfferTs', 'psO2OfferCmp', 'psO2FillAm', 'psO2CleanName', 'psO2TotalsDigitSlip'];

// tess = Attrappe fuer window.Tesseract (siehe fakeTesseract), sonst keine
export function loadOcr(tess) {
  const win = { PS_VENDOR: { tesseractScript: 'vendor/tesseract/tesseract.min.js', tesseractOptions: o => Object.assign({ workerPath: 'vendor/tesseract/worker.min.js' }, o || {}) }, PS_SMART_SCAN: { neural: false } };
  if (tess) win.Tesseract = tess;
  const ctx = vm.createContext({ window: win, console, setTimeout, clearTimeout, Promise, navigator: {}, document: {}, AbortController, fetch: () => Promise.reject(new Error('kein Netzwerk in der lokalen OCR')) });
  vm.runInContext(ocrSource() + '\n;this.__ocr = {' + NAMES.join(',') + '};', ctx);
  const X = ctx.__ocr;
  X.peek = expr => vm.runInContext(expr, ctx); // z. B. peek('__psO2W')
  X.setFetch = fn => { ctx.fetch = fn; };
  return X;
}

// Attrappe fuer Tesseract: jede recognize()-Antwort kommt aus `script` (Liste, der Reihe nach):
//   { text } | { text, delay } | { hang: true } (antwortet nie) | { throw: 'msg' }
export function fakeTesseract(script, opts = {}) {
  let call = 0;
  const T = { created: [], recognized: 0, terminated: [], failCreate: !!opts.failCreate };
  T.createWorker = async () => {
    if (T.failCreate) throw new Error('create failed');
    if (opts.createDelay) await new Promise(r => setTimeout(r, opts.createDelay));
    const w = {
      id: T.created.length, dead: false,
      setParameters: async () => {},
      recognize: () => {
        const s = script[Math.min(call++, script.length - 1)] || { text: '' };
        T.recognized++;
        if (s.hang) return new Promise(() => {});
        if (s.throw) return Promise.reject(new Error(s.throw));
        return new Promise(r => setTimeout(() => r({ data: { text: s.text || '', blocks: [] } }), s.delay || 0));
      },
      terminate: async () => { w.dead = true; T.terminated.push(w.id); }
    };
    T.created.push(w);
    return w;
  };
  return T;
}

// Foto-Attrappe: kein echtes Bild noetig (hooks ersetzen Dekodieren und Aufbereiten)
export const hooks = (opts = {}) => ({
  source: async () => { if (opts.badImage) throw new Error('decode'); return { close() { hooks.closed = (hooks.closed || 0) + 1; } }; },
  prepare: async () => ({})
});

// So liest die Texterkennung den Beleg (verrauscht wie ein Monitorfoto; Namen/Preise wie im Pflichtfall):
// Handy 2.389,00 EUR, zwei gleiche Tarife "O2 Mobile L (2026)" je 39,99 / 34,99, Summen 2.468,98 / 69,98.
export const BELEG = [
  'verbindlicher Vorschlag erstellt am 23112026 17:15',
  'Artikel einmalig monatlich',
  'HANDY',
  '2.389,00 € –',
  'Apple iPhone 18 Pro 1TB, Burgunder',
  'TARIF',
  '39,99 € 34,99 €',
  'O2 Mobile L (2026)',
  'International Voice Standard',
  'Inklusiv Datenvolumen 150 GB',
  'Roaming Standard',
  'Einmaliger Anschlusspreis 39,99 € –',
  'TARIF',
  '39,99 € 34,99 €',
  'O2 Mobile L (2026)',
  'International Voice Standard',
  'Inklusiv Datenvolumen 150 GB',
  'Roaming Standard',
  'Einmaliger Anschlusspreis 39,99 € –',
  'Einmalige Kosten 2.468,98 €',
  'Monatliche Kosten 69,98 €',
  'Aktuell'
].join('\n');

export const plain = x => JSON.parse(JSON.stringify(x));

// Angebot B (Internet + Handy + Tarif mit separatem Plus-Rabatt), Summen 2.438,98 / 69,98; "Ersparnis" ist keine Kostenposition, "Aktuell" gehoert nicht dazu.
export const BELEG_B = [
  'verbindlicher Vorschlag erstellt am 23112026 18:02',
  'Artikel einmalig monatlich',
  'INTERNET@HOME',
  '9,99 € 54,99 €',
  'O2 Home XL 600',
  'Download bis zu 600 MBit/s',
  'Anschlusspreis 49,99 € –',
  'Rabatt auf Anschlusspreis -40,00 € –',
  'HANDY',
  '2.389,00 € –',
  'Apple iPhone 18 Pro 1TB, Burgunder',
  'TARIF',
  '39,99 € 29,99 €',
  'O2 Mobile M Plus (2026)',
  'International Voice Standard',
  'Inklusiv Datenvolumen 60 GB',
  'Einmaliger Anschlusspreis 39,99 € –',
  'Plus-Rabatt – -15,00 €',
  'Ersparnis 400,00 €',
  'Einmalige Kosten 2.438,98 €',
  'Monatliche Kosten 69,98 €',
  'Aktuell',
  'O2 Mobile S (2020) 19,99 €'
].join('\n');

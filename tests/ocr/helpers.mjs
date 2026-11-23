// Laedt den OCR-Teil der index.html (ohne Browser) in eine Node-VM. Kein Build, keine Abhaengigkeiten: nur `node --test tests/ocr`.
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HTML = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'index.html');

export function ocrSource() {
  const lines = fs.readFileSync(HTML, 'utf8').replace(/\r\n/g, '\n').split('\n');
  const a = lines.findIndex(l => l.includes('o2-VORSCHLAG EINLESEN'));
  const b = lines.findIndex(l => l.includes('FOTO ZUSCHNEIDEN + ENTZERREN'));
  if (a < 0 || b < 0 || b <= a) throw new Error('OCR-Block in index.html nicht gefunden');
  return lines.slice(a, b).join('\n');
}

const NAMES = ['psO2Parse', 'psO2WordsToText', 'psO2Score', 'psO2Check', 'psO2Suggest', 'psO2Verdict', 'psO2Gaps', 'psO2Combine',
  'psO2Pretty', 'psO2ReadLocal', 'psO2NewJob', 'psO2Release', 'psO2Worker', 'psO2ResetEngine', 'psO2WithTimeout', 'psO2Cents', 'psO2Fmt', 'PS_O2_T', 'PS_O2_PLAN'];

// tess = Attrappe fuer window.Tesseract (siehe fakeTesseract), sonst keine
export function loadOcr(tess) {
  const win = tess ? { Tesseract: tess } : {};
  const ctx = vm.createContext({ window: win, console, setTimeout, clearTimeout, Promise, navigator: {}, document: {} });
  vm.runInContext(ocrSource() + '\n;this.__ocr = {' + NAMES.join(',') + '};', ctx);
  const X = ctx.__ocr;
  X.peek = expr => vm.runInContext(expr, ctx); // z. B. peek('__psO2W')
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

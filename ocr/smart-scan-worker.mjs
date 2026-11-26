// Smart Scan – neuronale OCR im eigenen Web Worker (PaddleOCR PP-OCRv6 tiny, ONNX Runtime Web, WebAssembly).
// Alles von der eigenen Domain: Modelle (.tar) und WASM liegen neben dieser Datei (ocr/generated/).
import { PaddleOCR } from '@paddleocr/paddleocr-js';

// v57-FIX: paddleocr-js zeichnet Bilder über document.createElement('canvas') und OpenCV cv.imread(canvas).
// Im Worker gibt es kein document → bisher schlug JEDE Erkennung fehl und es lief unbemerkt nur Tesseract.
// OffscreenCanvas bietet dieselbe 2D-Schnittstelle (drawImage/getImageData) und ist in Workern verfügbar.
if (typeof document === 'undefined' && typeof OffscreenCanvas !== 'undefined') {
  self.document = { createElement: t => { if (t !== 'canvas') throw new Error('unsupported element ' + t); return new OffscreenCanvas(1, 1); } };
  if (typeof self.HTMLCanvasElement === 'undefined') self.HTMLCanvasElement = OffscreenCanvas;
  if (typeof self.HTMLImageElement === 'undefined') self.HTMLImageElement = class {};
}

let instance;
const root = new URL('./', self.location.href);
function init() {
  if (!instance) {
    const det = 'PP-OCRv6_tiny_det', rec = 'PP-OCRv6_tiny_rec';
    instance = PaddleOCR.create({
      textDetectionModelName: det, textRecognitionModelName: rec,
      textDetectionModelAsset: { url: new URL(det + '.tar', root).href },
      textRecognitionModelAsset: { url: new URL(rec + '.tar', root).href },
      textDetectionBatchSize: 1, textRecognitionBatchSize: 4,
      ortOptions: { backend: 'wasm', wasmPaths: new URL('wasm/', root).href, numThreads: 1, simd: true }
    });
  }
  return instance;
}
self.onmessage = async ({ data: d }) => {
  if (!d || !['warm', 'read'].includes(d.type)) return;
  let bmp;
  try {
    const ocr = await init();
    if (d.type === 'warm') { self.postMessage({ id: d.id, ok: true }); return; }
    if (!(d.image instanceof Blob)) throw Error('No image');
    bmp = await createImageBitmap(d.image);
    const [r] = await ocr.predict(bmp, { textDetLimitSideLen: 1600, textDetLimitType: 'max', textDetMaxSideLimit: 1800, textDetBoxThresh: 0.45, textRecScoreThresh: 0.35 });
    self.postMessage({ id: d.id, ok: true, items: (r.items || []).map(x => ({ text: x.text, score: x.score, poly: x.poly })) });
  } catch (e) {
    // Fehlerart zurückmelden (nur technische Kurzinfo, keine Bilddaten) – die App fällt dann auf Tesseract zurück
    self.postMessage({ id: d.id, ok: false, error: String((e && e.message) || e).slice(0, 200) });
  } finally { if (bmp) bmp.close(); }
};

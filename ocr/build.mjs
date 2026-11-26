// Baut den selbst gehosteten OCR-Worker (ocr/generated/): Vite-Bundle + ONNX-Runtime-WASM + PaddleOCR-Modelle.
//   cd ocr && npm ci && npm run build
// Modelle: werden nur heruntergeladen, wenn sie fehlen oder die Prüfsumme nicht stimmt (models.lock.json).
// Zur Laufzeit lädt die App alles von der eigenen Domain – kein CDN, kein Cloud-Dienst.
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const dir = path.dirname(fileURLToPath(import.meta.url)), out = path.join(dir, 'generated');
const lockFile = path.join(dir, 'models.lock.json');
const lock = existsSync(lockFile) ? JSON.parse(await fs.readFile(lockFile, 'utf8')) : {};
const sha = b => crypto.createHash('sha256').update(b).digest('hex');

// Vorhandene Modelle sichern (emptyOutDir löscht sonst alles)
const models = {};
for (const name of ['PP-OCRv6_tiny_det', 'PP-OCRv6_tiny_rec']) {
  const f = path.join(out, name + '.tar');
  if (existsSync(f)) models[name] = await fs.readFile(f);
}

await build({ root: dir, base: './', logLevel: 'warn', build: { outDir: out, emptyOutDir: true, target: 'es2022', rollupOptions: { input: path.join(dir, 'smart-scan-worker.mjs'), output: { entryFileNames: 'smart-scan-worker.mjs', chunkFileNames: 'chunks/[name]-[hash].mjs', assetFileNames: 'assets/[name]-[hash][extname]' } } } });
await fs.mkdir(path.join(out, 'wasm'), { recursive: true });
const ort = path.join(dir, 'node_modules/onnxruntime-web/dist');
// Nur die WASM-Variante, die ort.bundle (JSEP-Build) mit backend 'wasm' lädt – spart ~55 MB gegenüber allen Varianten.
for (const f of await fs.readdir(ort)) if (/^ort-wasm-simd-threaded\.jsep\.(wasm|mjs)$/.test(f)) await fs.copyFile(path.join(ort, f), path.join(out, 'wasm', f));

// Vite legt zusätzlich eine zweite JSEP-WASM-Kopie und den internen Worker von paddleocr-js unter assets/ ab.
// Beide werden mit backend 'wasm' + wasmPaths nie geladen (per Browser-Test geprüft) → entfernen (≈36 MB).
await fs.rm(path.join(out, 'assets'), { recursive: true, force: true });

const host = 'https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/';
for (const name of ['PP-OCRv6_tiny_det', 'PP-OCRv6_tiny_rec']) {
  let b = models[name];
  if (!b || (lock[name] && sha(b) !== lock[name])) {
    const r = await fetch(host + name + '_onnx_infer.tar', { signal: AbortSignal.timeout(120000) });
    if (!r.ok) throw Error('model download ' + name + ' ' + r.status);
    b = Buffer.from(await r.arrayBuffer());
  }
  if (b.length < 10240 || b.length % 512 !== 0) throw Error('Invalid tar ' + name);
  if (lock[name] && sha(b) !== lock[name]) throw Error('Prüfsumme stimmt nicht: ' + name);
  lock[name] = sha(b);
  await fs.writeFile(path.join(out, name + '.tar'), b);
}
await fs.writeFile(lockFile, JSON.stringify(lock, null, 2) + '\n');
console.log('OCR-Worker gebaut:', out);

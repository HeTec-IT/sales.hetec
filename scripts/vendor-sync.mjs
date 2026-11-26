// Kopiert die benötigten Bibliotheken aus node_modules nach vendor/ (selbst gehostet, keine CDNs zur Laufzeit)
// und schreibt vendor/manifest.json mit Version, Lizenz und SHA-256 jeder Datei.
//   npm install && npm run vendor
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NM = path.join(ROOT, 'node_modules');
const OUT = path.join(ROOT, 'vendor');

const files = [
  // [Paket, Quelldatei im Paket, Ziel unter vendor/]
  ['react', 'umd/react.production.min.js', 'react/react.production.min.js'],
  ['react-dom', 'umd/react-dom.production.min.js', 'react/react-dom.production.min.js'],
  ['pdf-lib', 'dist/pdf-lib.min.js', 'pdf-lib/pdf-lib.min.js'],
  ['pdfjs-dist', 'build/pdf.min.js', 'pdfjs/pdf.min.js'],
  ['pdfjs-dist', 'build/pdf.worker.min.js', 'pdfjs/pdf.worker.min.js'],
  ['html2pdf.js', 'dist/html2pdf.bundle.min.js', 'html2pdf/html2pdf.bundle.min.js'],
  ['tesseract.js', 'dist/tesseract.min.js', 'tesseract/tesseract.min.js'],
  ['tesseract.js', 'dist/worker.min.js', 'tesseract/worker.min.js'],
  ['tesseract.js-core', 'tesseract-core-simd-lstm.wasm.js', 'tesseract/core/tesseract-core-simd-lstm.wasm.js'],
  ['tesseract.js-core', 'tesseract-core-lstm.wasm.js', 'tesseract/core/tesseract-core-lstm.wasm.js'],
  ['@tesseract.js-data/deu', '4.0.0_best_int/deu.traineddata.gz', 'tesseract/lang/deu.traineddata.gz'],
  ['@tesseract.js-data/eng', '4.0.0_best_int/eng.traineddata.gz', 'tesseract/lang/eng.traineddata.gz'],
];

const manifest = { generated: new Date().toISOString(), note: 'Automatisch erzeugt von scripts/vendor-sync.mjs – nicht von Hand ändern.', files: {} };
for (const [pkg, src, dst] of files) {
  const pj = JSON.parse(fs.readFileSync(path.join(NM, pkg, 'package.json'), 'utf8'));
  const from = path.join(NM, pkg, src);
  const to = path.join(OUT, dst);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  const buf = fs.readFileSync(to);
  manifest.files[dst] = { package: pkg, version: pj.version, license: pj.license || 'siehe Paket', sha256: crypto.createHash('sha256').update(buf).digest('hex'), bytes: buf.length };
  // Lizenztext mitliefern
  for (const lic of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license']) {
    const lp = path.join(NM, pkg, lic);
    if (fs.existsSync(lp)) { fs.copyFileSync(lp, path.join(path.dirname(to), 'LICENSE-' + pkg.replace(/[@/]/g, '_') + '.txt')); break; }
  }
}
// Bereits vorhandene, selbst gehostete Dateien (nicht aus npm) ebenfalls erfassen
for (const extra of ['qrcode.js', 'jsQR.js']) {
  const p = path.join(OUT, extra);
  if (fs.existsSync(p)) {
    const buf = fs.readFileSync(p);
    manifest.files[extra] = { package: extra === 'qrcode.js' ? 'qrcode-generator' : 'jsqr', version: extra === 'qrcode.js' ? '1.4.4' : '1.4.0', license: extra === 'qrcode.js' ? 'MIT' : 'Apache-2.0', sha256: crypto.createHash('sha256').update(buf).digest('hex'), bytes: buf.length };
  }
}
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log('vendor/ aktualisiert:', Object.keys(manifest.files).length, 'Dateien');

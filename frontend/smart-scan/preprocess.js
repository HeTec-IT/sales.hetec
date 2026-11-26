/*
 * Smart Scan – preprocess.js
 * Bildvorverarbeitung: Schärfe/Helligkeit, Spiegelungen, Moiré-Glättung, Zuschnitt/Entzerrung (Perspektive). Canvas-basiert, lokal.
 *
 * Klassisches Skript (globale Funktionen wie bisher in index.html), geladen vor der App.
 * Ausgelagert aus index.html (v56.0-beta.4) ohne inhaltliche Änderung; Cloud-OCR entfernt.
 */
// Fotoqualitaet sofort pruefen, bevor die lange Texterkennung laeuft: Schaerfe ueber die Laplace-Varianz
// (Kantenstaerke; unscharfe Fotos haben kaum Kanten) und die mittlere Helligkeit. Auf 2000 px gerechnet,
// damit der Wert bei iPad und Samsung-Tab vergleichbar ist.
const PS_O2_SHARP_MIN = 150, PS_O2_HELL_MIN = 60;
async function psO2Quality(file) {
  const bmp = await createImageBitmap(file);
  const sc = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
  const W = Math.max(3, Math.round(bmp.width * sc)), H = Math.max(3, Math.round(bmp.height * sc));
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(bmp, 0, 0, W, H);
  const d = x.getImageData(0, 0, W, H).data, n = W * H, g = new Float32Array(n);
  let sum = 0;
  for (let i = 0, p = 0; i < n; i++, p += 4) { const v = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2]; g[i] = v; sum += v; }
  let s1 = 0, s2 = 0, cnt = 0;
  for (let y = 1; y < H - 1; y++) for (let xx = 1; xx < W - 1; xx++) {
    const i = y * W + xx, l = g[i - 1] + g[i + 1] + g[i - W] + g[i + W] - 4 * g[i];
    s1 += l; s2 += l * l; cnt++;
  }
  const m = cnt ? s1 / cnt : 0;
  return { sharp: cnt ? s2 / cnt - m * m : 0, hell: sum / n };
}
// v55.227: Spiegelung (Lampe/Fenster auf dem Monitor) = ueberstrahlte Flaeche: >1 % fast weisser Pixel. Moiré-Fotos haben keine.
function psO2Glare(bmp) {
  const sc = Math.min(1, 400 / Math.max(bmp.width, bmp.height)), W = Math.max(3, Math.round(bmp.width * sc)), H = Math.max(3, Math.round(bmp.height * sc));
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(bmp, 0, 0, W, H);
  const d = x.getImageData(0, 0, W, H).data; let n = 0;
  for (let p = 0; p < d.length; p += 4) if (0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2] >= 245) n++;
  return n / (W * H) > 0.01;
}
// Foto vorbereiten: verkleinern (Tempo auf dem iPad), Graustufen, Kontrast spreizen (Bildschirmfotos sind oft flau)
// Den hellen Bereich des Fotos finden (Bildschirm oder Blatt vor dunklem Raum). Null, wenn das ganze Bild hell ist.
function psO2BrightBox(bmp) {
  const w = 300, hh = Math.max(1, Math.round(bmp.height * 300 / bmp.width));
  const c = document.createElement('canvas'); c.width = w; c.height = hh;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(bmp, 0, 0, w, hh);
  const d = x.getImageData(0, 0, w, hh).data, n = w * hh, g = new Float32Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) g[i] = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
  const srt = Float32Array.from(g).sort(), p95 = srt[Math.floor(n * 0.95)];
  // v55.210: Schwelle je Spalte (Sichtschutzfolie / schraeg: eine Bildschirmseite ist deutlich dunkler), aber nie unter 35 % der globalen
  const cp = new Float32Array(w), col = new Float32Array(hh);
  for (let xx = 0; xx < w; xx++) { for (let y = 0; y < hh; y++) col[y] = g[y * w + xx]; col.sort(); cp[xx] = col[Math.floor(hh * 0.95)]; }
  const thrX = new Float32Array(w);
  for (let xx = 0; xx < w; xx++) { let sm = 0, k = 0; for (let j = Math.max(0, xx - 15); j <= Math.min(w - 1, xx + 15); j++) { sm += cp[j]; k++; } thrX[xx] = Math.max(sm / k, p95 * 0.35) * 0.62; }
  const rows = new Float32Array(hh), cols = new Float32Array(w);
  for (let y = 0; y < hh; y++) for (let xx = 0; xx < w; xx++) if (g[y * w + xx] > thrX[xx]) { rows[y]++; cols[xx]++; }
  // laengster zusammenhaengender Abschnitt, in dem die Zeile/Spalte ueberwiegend hell ist
  const run = (v, len) => {
    let bs = -1, be = -1, cs = -1;
    for (let i = 0; i < v.length; i++) {
      const ok = v[i] / len > 0.35;
      if (ok && cs < 0) cs = i;
      if ((!ok || i === v.length - 1) && cs >= 0) { const e = ok ? i : i - 1; if (e - cs > be - bs) { bs = cs; be = e; } cs = -1; }
    }
    return bs < 0 ? null : [bs, be];
  };
  const r = run(rows, w), cc = run(cols, hh);
  if (!r || !cc) return null;
  const fx = bmp.width / w, fy = bmp.height / hh;
  const x0 = Math.max(0, Math.round((cc[0] - 1) * fx)), x1 = Math.min(bmp.width, Math.round((cc[1] + 2) * fx));
  const y0 = Math.max(0, Math.round((r[0] - 1) * fy)), y1 = Math.min(bmp.height, Math.round((r[1] + 2) * fy));
  const bw = x1 - x0, bh = y1 - y0, teil = bw * bh / (bmp.width * bmp.height);
  return bw < 160 || bh < 160 || teil < 0.12 || teil > 0.93 ? null : [x0, y0, bw, bh];
}
// v55.210: Ausleuchtung ausgleichen (Sichtschutzfolie, schraeger Blickwinkel, Vignette): Hintergrund (Papierweiss) blockweise
// schaetzen, glaetten und jedes Pixel durch seinen Hintergrund teilen -> ueberall gleich helles Weiss, Schrift bleibt dunkel.
// Nur wenn das Bild ungleich hell oder flau ist. Ergebnis: true = ausgeglichen.
function psO2Flatten(g, W, H, force) {
  const B = Math.max(8, Math.round(Math.max(W, H) / 120)), bw = Math.ceil(W / B), bh = Math.ceil(H / B), m = new Float32Array(bw * bh);
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    // helles Ende je Block (90 %), robust gegen Rauschen und einzelne Spitzlichter
    const hs = new Uint16Array(256); let n = 0;
    for (let y = by * B, ye = Math.min(H, y + B); y < ye; y++) for (let x = bx * B, xe = Math.min(W, x + B); x < xe; x++) { hs[g[y * W + x]]++; n++; }
    let a = 0, v = 255; for (; v > 0; v--) { a += hs[v]; if (a >= n * 0.1) break; }
    m[by * bw + bx] = v;
  }
  // Ungleichmaessigkeit messen: nur dort, wo Papier ist (helle Bloecke)
  const sorted = Array.from(m).sort((a, b) => a - b), p50 = sorted[Math.floor(sorted.length * 0.5)], p95 = sorted[Math.floor(sorted.length * 0.95)];
  const paper = Array.from(m).filter(v => v >= p50).sort((a, b) => a - b), q10 = paper[Math.floor(paper.length * 0.1)] || p95;
  if (!force && p95 >= 200 && q10 / Math.max(1, p95) > 0.82) return false;
  // Maximum ueber 2 Bloecke (Schrift-Bloecke bekommen das Weiss der Nachbarn), dann 2x glaetten
  const mx = new Float32Array(bw * bh), R = 2;
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) { let v = 0; for (let yy = Math.max(0, y - R); yy <= Math.min(bh - 1, y + R); yy++) for (let xx = Math.max(0, x - R); xx <= Math.min(bw - 1, x + R); xx++) v = Math.max(v, m[yy * bw + xx]); mx[y * bw + x] = v; }
  const blur = (a, r) => { const o = new Float32Array(a.length); for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) { let sm = 0, n = 0; for (let yy = Math.max(0, y - r); yy <= Math.min(bh - 1, y + r); yy++) for (let xx = Math.max(0, x - r); xx <= Math.min(bw - 1, x + r); xx++) { sm += a[yy * bw + xx]; n++; } o[y * bw + x] = sm / n; } return o; };
  const bg = blur(blur(mx, 2), 2);
  for (let y = 0; y < H; y++) {
    const fy = Math.min(bh - 1, Math.max(0, (y + 0.5) / B - 0.5)), y0 = Math.floor(fy), y1 = Math.min(bh - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < W; x++) {
      const fx = Math.min(bw - 1, Math.max(0, (x + 0.5) / B - 0.5)), x0 = Math.floor(fx), x1 = Math.min(bw - 1, x0 + 1), tx = fx - x0;
      const b = (bg[y0 * bw + x0] * (1 - tx) + bg[y0 * bw + x1] * tx) * (1 - ty) + (bg[y1 * bw + x0] * (1 - tx) + bg[y1 * bw + x1] * tx) * ty;
      const i = y * W + x; g[i] = Math.min(255, g[i] * 245 / Math.max(24, b));
    }
  }
  return true;
}
// v55.224: Bildquelle EINMAL entschluesseln (ein 12-MP-Foto belegt ~48 MB) und fuer alle Durchgaenge teilen; close() gibt den Speicher frei.
// EXIF-Drehung wird beachtet (Tablet im Hochformat gehalten).
async function psO2Bitmap(file) {
  try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch (e) { return await createImageBitmap(file); }
}
async function psO2Source(file) {
  const bmp = await psO2Bitmap(file);
  let bb, gl;
  return {
    bmp,
    get bb() { if (bb === undefined) { try { bb = psO2BrightBox(bmp); } catch (e) { bb = null; } } return bb; },
    get glare() { if (gl === undefined) { try { gl = psO2Glare(bmp); } catch (e) { gl = false; } } return gl; },
    close() { try { if (bmp.close) bmp.close(); } catch (e) {} }
  };
}
// Variante v = { side, blur, crop }: side = Zielgroesse (laengste Seite des Bildschirmbereichs; zu gross = Moire/Rauschen/Laufzeit,
// zu klein = feine Schrift weg), blur = Anzahl 3x3-Glaettungen (Moire/Rauschen), crop = heller Bereich ausschneiden (Standard: ja).
// Gemessen am Beleg-Foto: 1600 px liest besser UND doppelt so schnell wie 2000 px; Schaerfen/Binarisieren verstaerkt das Moire
// (900+ Pseudo-Woerter, 6-17 s statt 2-5 s, ohne einen einzigen Treffer) und ist deshalb entfallen.
async function psO2Prepare(src, v) {
  v = v || {};
  const bmp = src.bmp, bb = v.crop === false ? null : src.bb;
  const bx = bb ? bb[0] : 0, by = bb ? bb[1] : 0, bW = bb ? bb[2] : bmp.width, bH = bb ? bb[3] : bmp.height;
  const sc = Math.min(2.5, (v.side || 1600) / Math.max(bW, bH * 0.75));
  const W = Math.max(8, Math.round(bW * sc)), H = Math.max(8, Math.round(bH * sc));
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.imageSmoothingQuality = 'high';
  x.drawImage(bmp, bx, by, bW, bH, 0, 0, W, H);
  const id = x.getImageData(0, 0, W, H), d = id.data, n = W * H, g = new Uint8ClampedArray(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) g[i] = (0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2]) | 0;
  const smooth = () => {
    const t = new Uint8ClampedArray(g);
    for (let y = 1; y < H - 1; y++) for (let xx = 1; xx < W - 1; xx++) { const i = y * W + xx; g[i] = (t[i - W - 1] + 2 * t[i - W] + t[i - W + 1] + 2 * t[i - 1] + 4 * t[i] + 2 * t[i + 1] + t[i + W - 1] + 2 * t[i + W] + t[i + W + 1]) >> 4; }
  };
  // ungleich ausgeleuchtet (Sichtschutzfolie, Spiegelung, schraeg): Hintergrund angleichen, dabei Rauschen leicht glaetten
  if (psO2Flatten(g, W, H, false)) smooth();
  for (let k = 0; k < (v.blur || 0); k++) smooth();
  if (v.adapt || v.paper) {
    // v55.224: lokaler Schwellwert (Mittel im Fenster ~ 1/24 der Breite): Text ist dunkler als seine Umgebung - egal wie hell die Stelle ist
    const iw = W + 1, I = new Float64Array(iw * (H + 1));
    for (let y = 0; y < H; y++) { let rs = 0; for (let xx = 0; xx < W; xx++) { rs += g[y * W + xx]; I[(y + 1) * iw + xx + 1] = I[y * iw + xx + 1] + rs; } }
    const r = Math.max(8, Math.round(W / 48)), out = new Uint8ClampedArray(n);
    for (let y = 0; y < H; y++) {
      const y0 = Math.max(0, y - r), y1 = Math.min(H, y + r + 1);
      for (let xx = 0; xx < W; xx++) {
        const x0 = Math.max(0, xx - r), x1 = Math.min(W, xx + r + 1);
        const mean = (I[y1 * iw + x1] - I[y0 * iw + x1] - I[y1 * iw + x0] + I[y0 * iw + x0]) / ((x1 - x0) * (y1 - y0));
        const pixel = g[y * W + xx];
        out[y * W + xx] = v.paper ? 251 + 3 * (pixel - mean) : pixel < mean * 0.88 ? 0 : 255;
      }
    }
    for (let i = 0, p = 0; i < n; i++, p += 4) { d[p] = d[p + 1] = d[p + 2] = out[i]; d[p + 3] = 255; }
    x.putImageData(id, 0, 0);
    return c;
  }
  const hist = new Uint32Array(256);
  for (let i = 0; i < n; i++) hist[g[i]]++;
  let lo = 0, hi = 255, acc = 0;
  for (let q = 0; q < 256; q++) { acc += hist[q]; if (acc > n * 0.01) { lo = q; break; } }
  acc = 0;
  for (let q = 255; q >= 0; q--) { acc += hist[q]; if (acc > n * 0.01) { hi = q; break; } }
  const k = 255 / Math.max(1, hi - lo);
  for (let i = 0, p = 0; i < n; i++, p += 4) { const q = (g[i] - lo) * k; d[p] = d[p + 1] = d[p + 2] = q; d[p + 3] = 255; }
  x.putImageData(id, 0, 0);
  return c;
}
// === v55.176 (Beta): FOTO ZUSCHNEIDEN + ENTZERREN ========================================================
// Viereck (4 frei ziehbare Ecken, Bruchteile 0..1 des Fotos) -> gerades Rechteck. Das letzte Viereck wird gemerkt.
const PS_O2_QUAD_KEY = 'ps_o2_quad';
const PS_O2_QUAD_DEF = [[0.04, 0.04], [0.96, 0.04], [0.96, 0.96], [0.04, 0.96]];
function psO2QuadLoad() {
  try {
    const q = JSON.parse(localStorage.getItem(PS_O2_QUAD_KEY) || 'null');
    if (Array.isArray(q) && q.length === 4 && q.every(p => Array.isArray(p) && p.length === 2 && p.every(v => typeof v === 'number' && v >= 0 && v <= 1)) && psO2Convex(q)) return q;
  } catch (e) {}
  return PS_O2_QUAD_DEF.map(p => p.slice());
}
function psO2QuadSave(q) { try { localStorage.setItem(PS_O2_QUAD_KEY, JSON.stringify(q)); } catch (e) {} }
function psO2Convex(q) {
  let sg = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
    const cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cr) < 1e-6) return false;
    const s = cr > 0 ? 1 : -1;
    if (sg && s !== sg) return false;
    sg = s;
  }
  return true;
}
// Zeichnet das Viereck q aus der Leinwand c als gerades Rechteck. Achsparallel = einfacher Ausschnitt, sonst Perspektiv-Entzerrung.
function psO2Warp(c, q) {
  const P = q.map(p => [p[0] * c.width, p[1] * c.height]);
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  let W = Math.max(8, Math.round((dist(P[0], P[1]) + dist(P[3], P[2])) / 2)), H = Math.max(8, Math.round((dist(P[0], P[3]) + dist(P[1], P[2])) / 2));
  const sc = Math.min(1, 2400 / Math.max(W, H));
  W = Math.max(8, Math.round(W * sc)); H = Math.max(8, Math.round(H * sc));
  const o = document.createElement('canvas'); o.width = W; o.height = H;
  const ox = o.getContext('2d');
  const straight = Math.abs(P[0][0] - P[3][0]) < 1 && Math.abs(P[1][0] - P[2][0]) < 1 && Math.abs(P[0][1] - P[1][1]) < 1 && Math.abs(P[3][1] - P[2][1]) < 1;
  if (straight) {
    const sx = Math.min(P[0][0], P[3][0]), sy = Math.min(P[0][1], P[1][1]);
    ox.drawImage(c, sx, sy, Math.max(P[1][0], P[2][0]) - sx, Math.max(P[3][1], P[2][1]) - sy, 0, 0, W, H);
    return o;
  }
  const xs = P.map(p => p[0]), ys = P.map(p => p[1]);
  const bx = Math.max(0, Math.floor(Math.min.apply(null, xs)) - 1), by = Math.max(0, Math.floor(Math.min.apply(null, ys)) - 1);
  const bw = Math.min(c.width, Math.ceil(Math.max.apply(null, xs)) + 1) - bx, bh = Math.min(c.height, Math.ceil(Math.max.apply(null, ys)) + 1) - by;
  const src = c.getContext('2d').getImageData(bx, by, bw, bh).data;
  const x0 = P[0][0], y0 = P[0][1], x1 = P[1][0], y1 = P[1][1], x2 = P[2][0], y2 = P[2][1], x3 = P[3][0], y3 = P[3][1];
  const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3, dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;
  let g = 0, hh = 0;
  const den = dx1 * dy2 - dx2 * dy1;
  if ((Math.abs(dx3) > 1e-9 || Math.abs(dy3) > 1e-9) && Math.abs(den) > 1e-9) { g = (dx3 * dy2 - dx2 * dy3) / den; hh = (dx1 * dy3 - dx3 * dy1) / den; }
  const A = x1 - x0 + g * x1, B = x3 - x0 + hh * x3, C = x0, D = y1 - y0 + g * y1, E = y3 - y0 + hh * y3, F = y0;
  const out = ox.createImageData(W, H), od = out.data;
  for (let j = 0; j < H; j++) {
    const v = (j + 0.5) / H;
    for (let i = 0; i < W; i++) {
      const u = (i + 0.5) / W, w = g * u + hh * v + 1;
      const X = (A * u + B * v + C) / w - bx - 0.5, Y = (D * u + E * v + F) / w - by - 0.5;
      const xi = Math.floor(X), yi = Math.floor(Y), fx = X - xi, fy = Y - yi;
      const xa = Math.min(bw - 1, Math.max(0, xi)), xb = Math.min(bw - 1, Math.max(0, xi + 1)), ya = Math.min(bh - 1, Math.max(0, yi)), yb = Math.min(bh - 1, Math.max(0, yi + 1));
      const p00 = (ya * bw + xa) * 4, p10 = (ya * bw + xb) * 4, p01 = (yb * bw + xa) * 4, p11 = (yb * bw + xb) * 4, po = (j * W + i) * 4;
      const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
      od[po] = src[p00] * w00 + src[p10] * w10 + src[p01] * w01 + src[p11] * w11;
      od[po + 1] = src[p00 + 1] * w00 + src[p10 + 1] * w10 + src[p01 + 1] * w01 + src[p11 + 1] * w11;
      od[po + 2] = src[p00 + 2] * w00 + src[p10 + 2] * w10 + src[p01 + 2] * w01 + src[p11 + 2] * w11;
      od[po + 3] = 255;
    }
  }
  ox.putImageData(out, 0, 0);
  return o;
}
